# type: ignore
import asyncio
import json
from typing import Any, Callable

from kimi_cli.app import KimiCLI, enable_logging
from kimi_cli.session import Session
from kosong.tooling import ToolCall, ToolResult, ToolOk, ToolError
from kimi_cli.wire.message import WireMessage
from kimi_cli.utils.logging import logger

from swebench.config import EvalConfig
from swebench.utils.docker import Container


class KimiContainerSolver:
    def __init__(
        self,
        container: Container,
        working_dir: str,
        config: EvalConfig,
        problem_statement: str,
        interaction_logger: Callable[[int, str, str], None] | None = None,
    ):
        self.container = container
        self.working_dir = working_dir
        self.config = config
        self.problem_statement = problem_statement
        self.interaction_logger = interaction_logger
        self.round = 0

    async def solve(self) -> dict[str, Any]:
        enable_logging()
        
        session = await Session.create(self.working_dir)
        kimi_instance = await KimiCLI.create(
            session,
            yolo=True,
            model_name=self.config.kimi.model,
        )
        
        final_response = ""
        tool_calls_executed: list[dict[str, Any]] = []
        
        try:
            logger.info(f"Starting Kimi solver for: {self.problem_statement[:100]}")
            
            async for msg in kimi_instance.run(
                user_input=self.problem_statement,
                cancel_event=asyncio.Event(),
                merge_wire_messages=False,
            ):
                await self._handle_message(msg, tool_calls_executed)
            
            # Extract final response from context
            history = kimi_instance.soul.context.history
            if history and history[-1].role == "assistant":
                final_response = self._extract_text_from_message(history[-1])
            
            logger.info(f"Kimi solver completed. Executed {len(tool_calls_executed)} tool calls")
            
        except Exception as e:
            logger.error(f"Kimi solver failed: {e}")
            raise
        finally:
            # Cleanup
            pass
        
        return {
            "output": final_response,
            "tool_calls": tool_calls_executed,
            "rounds": self.round,
        }

    async def _handle_message(
        self, msg: WireMessage, tool_calls_executed: list[dict[str, Any]]
    ) -> None:
        """Handle a message from Kimi CLI."""
        match msg:
            case ToolCall(
                id=tool_id,
                function=func,
            ):
                logger.info(f"Tool call: {func.name}")
                if func.name in ["bash", "shell"]:
                    await self._handle_shell_call(tool_id, func.name, func.arguments)
                elif func.name in ["write_file", "str_replace_file"]:
                    await self._handle_file_call(tool_id, func.name, func.arguments)
                elif func.name == "read_file":
                    await self._handle_read_file(tool_id, func.arguments)
                else:
                    logger.debug(f"Skipping non-container tool: {func.name}")
                
                tool_calls_executed.append({
                    "tool": func.name,
                    "args": func.arguments,
                    "id": tool_id,
                })
            case _:
                if hasattr(msg, "__class__"):
                    logger.debug(f"Message type: {msg.__class__.__name__}")

    async def _handle_shell_call(self, tool_id: str, tool_name: str, args_json: str) -> None:
        try:
            args = json.loads(args_json)
            command = args.get("command", "")
            
            logger.info(f"Executing in container: {command}")
            result = await self.container.execute(
                ["bash", "-c", command],
                timeout=self.config.timeout_seconds,
                check=False,
            )
            
            output = result.get("stdout", "") + result.get("stderr", "")
            logger.debug(f"Shell output: {output[:200]}")
            
        except Exception as e:
            logger.error(f"Shell execution failed: {e}")

    async def _handle_file_call(
        self, tool_id: str, tool_name: str, args_json: str
    ) -> None:
        """Handle file write operations in the container."""
        try:
            args = json.loads(args_json)
            
            if tool_name == "write_file":
                file_path = args.get("file_path", "")
                contents = args.get("contents", "")
                cmd = f"cat > {file_path} << 'EOF'\n{contents}\nEOF"
                await self.container.execute_shell(cmd, timeout=60)
                logger.info(f"Wrote file: {file_path}")
                
            elif tool_name == "str_replace_file":
                file_path = args.get("file_path", "")
                old_string = args.get("old_string", "")
                new_string = args.get("new_string", "")
                
                # Use sed for replacement
                cmd = f"sed -i 's/{self._escape_sed(old_string)}/{self._escape_sed(new_string)}/g' {file_path}"
                await self.container.execute_shell(cmd, timeout=60)
                logger.info(f"Modified file: {file_path}")
                
        except Exception as e:
            logger.error(f"File operation failed: {e}")

    async def _handle_read_file(self, tool_id: str, args_json: str) -> None:
        """Handle file read operations in the container."""
        try:
            args = json.loads(args_json)
            file_path = args.get("file_path", "")
            
            result = await self.container.execute(
                ["cat", file_path],
                timeout=60,
                check=False,
            )
            
            content = result.get("stdout", "")
            logger.debug(f"Read file: {file_path} ({len(content)} bytes)")
            
        except Exception as e:
            logger.error(f"File read failed: {e}")

    @staticmethod
    def _escape_sed(s: str) -> str:
        """Escape string for sed."""
        return s.replace("/", "\\/").replace("&", "\\&")

    @staticmethod
    def _extract_text_from_message(msg: Any) -> str:
        """Extract text content from a message."""
        if hasattr(msg, "content"):
            if isinstance(msg.content, list):
                text_parts = []
                for part in msg.content:
                    if hasattr(part, "text"):
                        text_parts.append(part.text)
                return "\n".join(text_parts)
            elif isinstance(msg.content, str):
                return msg.content
        return ""

