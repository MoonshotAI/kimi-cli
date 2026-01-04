# type: ignore
import asyncio
import json
from typing import Any, Callable

from pydantic import SecretStr
from kaos.path import KaosPath
from kimi_cli.config import Config, LLMModel, LLMProvider
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
        
        try:
            work_dir = KaosPath.cwd()
            logger.info(f"Creating Kimi session in: {work_dir}")
            
            session = await Session.create(work_dir)
            logger.info(f"Session created: {session.id}")
                        
            logger.info(f"Creating KimiCLI with model={self.config.kimi.model}")
            
            llm_config = Config()
            if self.config.kimi.model and self.config.kimi.api_key:
                logger.info(f"Building LLM config: model={self.config.kimi.model}, api_key_len={len(self.config.kimi.api_key)}")
                logger.debug(f"Base URL: {self.config.kimi.base_url}")
                
                model_config = LLMModel(
                    model=self.config.kimi.model,
                    provider="kimi",
                    max_context_size=128000,
                )
                # Ensure base_url has a value, use Kimi default if not provided
                base_url = self.config.kimi.base_url or "https://api.moonshot.cn/v1"
                logger.info(f"Using base_url: {base_url}")
                
                provider_config = LLMProvider(
                    type="kimi",
                    api_key=SecretStr(self.config.kimi.api_key),
                    base_url=base_url,
                )
                llm_config.models[self.config.kimi.model] = model_config
                llm_config.providers["kimi"] = provider_config
                llm_config.default_model = self.config.kimi.model
                logger.info(f"Configured LLM: model={self.config.kimi.model}, provider=kimi")
            
            try:
                kimi_instance = await KimiCLI.create(
                    session,
                    yolo=True,
                    model_name=self.config.kimi.model,
                    config=llm_config,
                )
                logger.info(f"KimiCLI instance created")
                logger.info(f"KimiCLI soul model: {kimi_instance._soul.model_name}")
            except Exception as e:
                logger.error("Failed to create KimiCLI: {}", str(e), exc_info=True)
                raise
            
            final_response = ""
            tool_calls_executed: list[dict[str, Any]] = []
            
            logger.info(f"Starting Kimi solver for: {self.problem_statement[:100]}")
            logger.info(f"Using model: {self.config.kimi.model}")
            
            async for msg in kimi_instance.run(
                user_input=self.problem_statement,
                cancel_event=asyncio.Event(),
                merge_wire_messages=False,
            ):
                logger.debug(f"Message received: {msg.__class__.__name__}")
                await self._handle_message(msg, tool_calls_executed)
            
            # Extract final response from context
            history = kimi_instance.soul.context.history
            if history and history[-1].role == "assistant":
                final_response = self._extract_text_from_message(history[-1])
            
            logger.info(f"Kimi solver completed. Executed {len(tool_calls_executed)} tool calls")
            
            return {
                "output": final_response,
                "tool_calls": tool_calls_executed,
                "rounds": self.round,
            }
            
        except Exception as e:
            logger.error("Kimi solver failed: {}", str(e), exc_info=True)
            raise

    async def _handle_message(
        self, msg: WireMessage, tool_calls_executed: list[dict[str, Any]]
    ) -> None:
        """Handle a message from Kimi CLI."""
        match msg:
            case ToolCall(
                id=tool_id,
                function=func,
            ):
                logger.info(f"Tool call received: {func.name} (id={tool_id})")
                logger.debug(f"Tool arguments: {func.arguments[:100]}")
                if func.name in ["bash", "shell"]:
                    logger.info(f"Executing shell command")
                    await self._handle_shell_call(tool_id, func.name, func.arguments)
                elif func.name in ["write_file", "str_replace_file"]:
                    logger.info(f"Handling file operation")
                    await self._handle_file_call(tool_id, func.name, func.arguments)
                elif func.name == "read_file":
                    logger.info(f"Reading file")
                    await self._handle_read_file(tool_id, func.arguments)
                else:
                    logger.debug(f"Skipping non-container tool: {func.name}")
                
                tool_calls_executed.append({
                    "tool": func.name,
                    "args": func.arguments,
                    "id": tool_id,
                })
            case msg if hasattr(msg, "text"):
                logger.info(f"Text message received: {msg.text[:100] if hasattr(msg, 'text') else 'N/A'}")
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
            logger.error("Shell execution failed: {}", str(e), exc_info=True)

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
            logger.error("File operation failed: {}", str(e), exc_info=True)

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
            logger.error("File read failed: {}", str(e), exc_info=True)

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

