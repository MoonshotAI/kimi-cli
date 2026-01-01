from __future__ import annotations

import asyncio
import contextlib

import acp  # type: ignore[reportMissingTypeStubs]
import pydantic
from kosong.chat_provider import ChatProviderError

from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled, Soul, run_soul
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.aioqueue import Queue, QueueShutDown
from kimi_cli.utils.logging import logger
from kimi_cli.wire import Wire
from kimi_cli.wire.message import ApprovalRequest, Request

from .jsonrpc import (
    ErrorCodes,
    JSONRPCApprovalRequestResult,
    JSONRPCCancelMessage,
    JSONRPCErrorObject,
    JSONRPCErrorResponse,
    JSONRPCEventMessage,
    JSONRPCInMessage,
    JSONRPCInMessageAdapter,
    JSONRPCOutMessage,
    JSONRPCPromptMessage,
    JSONRPCRequestMessage,
    JSONRPCSuccessResponse,
    Statuses,
)


class WireOverStdio:
    def __init__(self, soul: Soul):
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

        # outward
        self._write_task: asyncio.Task[None] | None = None
        self._write_queue: Queue[JSONRPCOutMessage] = Queue()

        # inward
        self._dispatch_tasks: set[asyncio.Task[None]] = set()

        # soul running stuffs
        self._soul = soul
        self._cancel_event: asyncio.Event | None = None
        self._pending_requests: dict[str, Request] = {}
        """Maps JSON RPC message IDs to pending `Request`s."""

    async def serve(self) -> None:
        logger.info("Starting Wire server on stdio")

        self._reader, self._writer = await acp.stdio_streams()
        self._write_task = asyncio.create_task(self._write_loop())
        try:
            await self._read_loop()
        finally:
            await self._shutdown()

    async def _write_loop(self) -> None:
        assert self._writer is not None

        try:
            while True:
                try:
                    msg = await self._write_queue.get()
                except QueueShutDown:
                    logger.debug("Send queue shut down, stopping Wire server write loop")
                    break
                self._writer.write(msg.model_dump_json().encode("utf-8") + b"\n")
                await self._writer.drain()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Wire server write loop error:")
            raise

    async def _read_loop(self) -> None:
        assert self._reader is not None

        while True:
            line = await self._reader.readline()
            if not line:
                logger.info("stdin closed, Wire server exiting")
                break

            try:
                msg = JSONRPCInMessageAdapter.validate_json(line)
            except ValueError:
                logger.error("Invalid JSONRPC line: {line}", line=line)
                continue

            task = asyncio.create_task(self._dispatch_msg(msg))
            task.add_done_callback(self._dispatch_tasks.discard)
            self._dispatch_tasks.add(task)

    async def _shutdown(self) -> None:
        for request in self._pending_requests.values():
            if not request.resolved:
                request.resolve("reject")
        self._pending_requests.clear()

        if self._cancel_event is not None:
            self._cancel_event.set()
            self._cancel_event = None

        self._write_queue.shutdown()
        if self._write_task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await self._write_task

        await asyncio.gather(*self._dispatch_tasks, return_exceptions=True)
        self._dispatch_tasks.clear()

        if self._writer is not None:
            self._writer.close()
            with contextlib.suppress(Exception):
                await self._writer.wait_closed()
            self._writer = None

        self._reader = None

    async def _dispatch_msg(self, msg: JSONRPCInMessage) -> None:
        resp: JSONRPCSuccessResponse | JSONRPCErrorResponse | None = None
        try:
            match msg:
                case JSONRPCPromptMessage():
                    resp = await self._handle_prompt(msg)
                case JSONRPCCancelMessage():
                    resp = await self._handle_cancel(msg)
                case JSONRPCSuccessResponse() | JSONRPCErrorResponse():
                    await self._handle_response(msg)

            if resp is not None:
                await self._send_msg(resp)
        except Exception:
            logger.exception("Unexpected error dispatching JSONRPC message:")
            raise

    async def _send_msg(self, msg: JSONRPCOutMessage) -> None:
        try:
            await self._write_queue.put(msg)
        except QueueShutDown:
            logger.error("Send queue shut down; dropping message: {msg}", msg=msg)

    @property
    def _soul_is_running(self) -> bool:
        return self._cancel_event is not None

    async def _handle_prompt(
        self, msg: JSONRPCPromptMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if self._soul_is_running:
            # TODO: support queueing multiple inputs
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE, message="An agent turn is already in progress"
                ),
            )

        self._cancel_event = asyncio.Event()
        try:
            await run_soul(
                self._soul,
                msg.params.user_input,
                self._stream_wire_messages,
                self._cancel_event,
                self._soul.wire_file if isinstance(self._soul, KimiSoul) else None,
            )
            return JSONRPCSuccessResponse(
                id=msg.id,
                result={"status": Statuses.FINISHED},
            )
        except LLMNotSet:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(code=ErrorCodes.LLM_NOT_SET, message="LLM is not set"),
            )
        except LLMNotSupported as e:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(code=ErrorCodes.LLM_NOT_SUPPORTED, message=str(e)),
            )
        except ChatProviderError as e:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(code=ErrorCodes.CHAT_PROVIDER_ERROR, message=str(e)),
            )
        except MaxStepsReached as e:
            return JSONRPCSuccessResponse(
                id=msg.id,
                result={"status": Statuses.MAX_STEPS_REACHED, "steps": e.n_steps},
            )
        except RunCancelled:
            return JSONRPCSuccessResponse(
                id=msg.id,
                result={"status": Statuses.CANCELLED},
            )
        finally:
            self._cancel_event = None

    async def _handle_cancel(
        self, msg: JSONRPCCancelMessage
    ) -> JSONRPCSuccessResponse | JSONRPCErrorResponse:
        if not self._soul_is_running:
            return JSONRPCErrorResponse(
                id=msg.id,
                error=JSONRPCErrorObject(
                    code=ErrorCodes.INVALID_STATE, message="No agent turn is in progress"
                ),
            )

        assert self._cancel_event is not None
        self._cancel_event.set()
        return JSONRPCSuccessResponse(
            id=msg.id,
            result={},
        )

    async def _handle_response(self, msg: JSONRPCSuccessResponse | JSONRPCErrorResponse) -> None:
        request = self._pending_requests.pop(msg.id, None)
        if request is None:
            logger.error("No pending request for response id={id}", id=msg.id)
            return

        match request:
            case ApprovalRequest():
                if isinstance(msg, JSONRPCErrorResponse):
                    request.resolve("reject")
                else:
                    try:
                        result = JSONRPCApprovalRequestResult.model_validate(msg.result)
                        request.resolve(result.response)
                    except pydantic.ValidationError as e:
                        logger.error(
                            "Invalid response result for request id={id}: {error}",
                            id=msg.id,
                            error=e,
                        )
                        request.resolve("reject")

    async def _stream_wire_messages(self, wire: Wire) -> None:
        wire_ui = wire.ui_side(merge=False)
        while True:
            msg = await wire_ui.receive()
            match msg:
                case ApprovalRequest():
                    await self._request_approval(msg)
                case _:
                    await self._send_msg(JSONRPCEventMessage(method="event", params=msg))

    async def _request_approval(self, request: ApprovalRequest) -> None:
        msg_id = request.id  # just use the approval request id as message id
        self._pending_requests[msg_id] = request
        await self._send_msg(JSONRPCRequestMessage(id=msg_id, params=request))
        await request.wait()
