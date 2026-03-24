from __future__ import annotations

import asyncio
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, NamedTuple

import acp
from kaos.path import KaosPath

from kimi_cli.acp.kaos import ACPKaos
from kimi_cli.acp.mcp import acp_mcp_servers_to_mcp_config
from kimi_cli.acp.session import ACPSession
from kimi_cli.acp.tools import replace_tools
from kimi_cli.acp.types import ACPContentBlock, MCPServer
from kimi_cli.acp.version import ACPVersionSpec, negotiate_version
from kimi_cli.app import KimiCLI
from kimi_cli.auth.oauth import (
    KIMI_CODE_OAUTH_KEY,
    load_tokens,
    request_device_authorization,
    _request_device_token,
    save_tokens,
    DeviceAuthorization,
    OAuthToken,
)
from kimi_cli.config import LLMModel, OAuthRef, load_config, save_config
from kimi_cli.constant import NAME, VERSION
from kimi_cli.llm import create_llm, derive_model_capabilities
from kimi_cli.session import Session
from kimi_cli.soul.slash import registry as soul_slash_registry
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.utils.logging import logger


class ACPServer:
    def __init__(self) -> None:
        self.client_capabilities: acp.schema.ClientCapabilities | None = None
        self.conn: acp.Client | None = None
        self.sessions: dict[str, tuple[ACPSession, _ModelIDConv]] = {}
        self.negotiated_version: ACPVersionSpec | None = None
        self._auth_methods: list[acp.schema.AuthMethod] = []
        self._active_auth_sessions: dict[str, asyncio.Task[bool]] = {}

    def on_connect(self, conn: acp.Client) -> None:
        logger.info("ACP client connected")
        self.conn = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: acp.schema.ClientCapabilities | None = None,
        client_info: acp.schema.Implementation | None = None,
        **kwargs: Any,
    ) -> acp.InitializeResponse:
        self.negotiated_version = negotiate_version(protocol_version)
        logger.info(
            "ACP server initialized with client protocol version: {version}, "
            "negotiated version: {negotiated}, "
            "client capabilities: {capabilities}, client info: {info}",
            version=protocol_version,
            negotiated=self.negotiated_version,
            capabilities=client_capabilities,
            info=client_info,
        )
        self.client_capabilities = client_capabilities

        # Use sys.executable for reliable login command across all launch methods
        # This works regardless of how ACP was started (direct, module, or IDE integration)
        command = sys.executable
        terminal_args = ["-m", "kimi_cli", "login"]

        # Build and cache auth methods for reuse in AUTH_REQUIRED errors
        self._auth_methods = [
            acp.schema.AuthMethod(
                id="login",
                name="Login with Kimi account",
                description=(
                    "Run login command in the terminal, "
                    "then follow the instructions to finish login."
                ),
                # Store auth data in field_meta for building AUTH_REQUIRED error
                field_meta={
                    "terminal-auth": {
                        "command": command,
                        "args": terminal_args,
                        "label": "Kimi Code Login",
                        "env": {},
                        "type": "terminal",
                    }
                },
            ),
        ]

        return acp.InitializeResponse(
            protocol_version=self.negotiated_version.protocol_version,
            agent_capabilities=acp.schema.AgentCapabilities(
                load_session=True,
                prompt_capabilities=acp.schema.PromptCapabilities(
                    embedded_context=True, image=True, audio=False
                ),
                mcp_capabilities=acp.schema.McpCapabilities(http=True, sse=False),
                session_capabilities=acp.schema.SessionCapabilities(
                    list=acp.schema.SessionListCapabilities(),
                    resume=acp.schema.SessionResumeCapabilities(),
                ),
            ),
            auth_methods=self._auth_methods,
            agent_info=acp.schema.Implementation(name=NAME, version=VERSION),
        )

    async def _check_auth(self) -> None:
        """Check if Kimi Code authentication is complete."""
        ref = OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY)
        token = load_tokens(ref)

        if token is None or not token.access_token:
            logger.warning("No valid token found, requesting manual authentication")
            
            # Build AUTH_REQUIRED error data for clients
            auth_methods_data: list[dict[str, Any]] = []
            for m in self._auth_methods:
                if m.field_meta and "terminal-auth" in m.field_meta:
                    terminal_auth = m.field_meta["terminal-auth"]
                    auth_methods_data.append(
                        {
                            "id": m.id,
                            "name": m.name,
                            "description": m.description,
                            "type": terminal_auth.get("type", "terminal"),
                            "command": terminal_auth.get("command", "kimi"),
                            "args": terminal_auth.get("args", []),
                            "label": terminal_auth.get("label", ""),
                            "env": terminal_auth.get("env", {}),
                        }
                    )

            raise acp.RequestError.auth_required({"authMethods": auth_methods_data})

    async def new_session(
        self, cwd: str, mcp_servers: list[MCPServer] | None = None, **kwargs: Any
    ) -> acp.NewSessionResponse:
        logger.info("Creating new session for working directory: {cwd}", cwd=cwd)
        assert self.conn is not None, "ACP client not connected"
        assert self.client_capabilities is not None, "ACP connection not initialized"

        # Check authentication before creating session
        try:
            await self._check_auth()
        except acp.RequestError as e:
            if e.code == -32000:  # AUTH_REQUIRED
                # 主动调用 authenticate 方法进行认证
                logger.info("Authentication required, triggering authenticate method")
                await self.authenticate("login")
            else:
                raise

        session = await Session.create(KaosPath.unsafe_from_local_path(Path(cwd)))

        mcp_config = acp_mcp_servers_to_mcp_config(mcp_servers or [])
        cli_instance = await KimiCLI.create(
            session,
            mcp_configs=[mcp_config],
        )
        config = cli_instance.soul.runtime.config
        acp_kaos = ACPKaos(self.conn, session.id, self.client_capabilities)
        acp_session = ACPSession(session.id, cli_instance, self.conn, kaos=acp_kaos)
        model_id_conv = _ModelIDConv(config.default_model, config.default_thinking)
        self.sessions[session.id] = (acp_session, model_id_conv)

        if isinstance(cli_instance.soul.agent.toolset, KimiToolset):
            replace_tools(
                self.client_capabilities,
                self.conn,
                session.id,
                cli_instance.soul.agent.toolset,
                cli_instance.soul.runtime,
            )

        available_commands = [
            acp.schema.AvailableCommand(name=cmd.name, description=cmd.description)
            for cmd in soul_slash_registry.list_commands()
        ]
        asyncio.create_task(
            self.conn.session_update(
                session_id=session.id,
                update=acp.schema.AvailableCommandsUpdate(
                    session_update="available_commands_update",
                    available_commands=available_commands,
                ),
            )
        )
        return acp.NewSessionResponse(
            session_id=session.id,
            modes=acp.schema.SessionModeState(
                available_modes=[
                    acp.schema.SessionMode(
                        id="default",
                        name="Default",
                        description="The default mode.",
                    ),
                ],
                current_mode_id="default",
            ),
            models=acp.schema.SessionModelState(
                available_models=_expand_llm_models(config.models),
                current_model_id=model_id_conv.to_acp_model_id(),
            ),
        )

    async def _setup_session(
        self,
        cwd: str,
        session_id: str,
        mcp_servers: list[MCPServer] | None = None,
    ) -> tuple[ACPSession, _ModelIDConv]:
        """Load or resume a session. Shared by load_session and resume_session."""
        assert self.conn is not None, "ACP client not connected"
        assert self.client_capabilities is not None, "ACP connection not initialized"

        work_dir = KaosPath.unsafe_from_local_path(Path(cwd))
        session = await Session.find(work_dir, session_id)
        if session is None:
            logger.error(
                "Session not found: {id} for working directory: {cwd}", id=session_id, cwd=cwd
            )
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})

        mcp_config = acp_mcp_servers_to_mcp_config(mcp_servers or [])
        cli_instance = await KimiCLI.create(
            session,
            mcp_configs=[mcp_config],
        )
        config = cli_instance.soul.runtime.config
        acp_kaos = ACPKaos(self.conn, session.id, self.client_capabilities)
        acp_session = ACPSession(session.id, cli_instance, self.conn, kaos=acp_kaos)
        model_id_conv = _ModelIDConv(config.default_model, config.default_thinking)
        self.sessions[session.id] = (acp_session, model_id_conv)

        if isinstance(cli_instance.soul.agent.toolset, KimiToolset):
            replace_tools(
                self.client_capabilities,
                self.conn,
                session.id,
                cli_instance.soul.agent.toolset,
                cli_instance.soul.runtime,
            )

        return acp_session, model_id_conv

    async def load_session(
        self, cwd: str, session_id: str, mcp_servers: list[MCPServer] | None = None, **kwargs: Any
    ) -> None:
        logger.info("Loading session: {id} for working directory: {cwd}", id=session_id, cwd=cwd)

        if session_id in self.sessions:
            logger.warning("Session already loaded: {id}", id=session_id)
            return

        # Check authentication before loading session
        await self._check_auth()

        await self._setup_session(cwd, session_id, mcp_servers)
        # TODO: replay session history?

    async def resume_session(
        self, cwd: str, session_id: str, mcp_servers: list[MCPServer] | None = None, **kwargs: Any
    ) -> acp.schema.ResumeSessionResponse:
        logger.info("Resuming session: {id} for working directory: {cwd}", id=session_id, cwd=cwd)

        if session_id not in self.sessions:
            await self._setup_session(cwd, session_id, mcp_servers)

        acp_session, model_id_conv = self.sessions[session_id]
        config = acp_session.cli.soul.runtime.config
        return acp.schema.ResumeSessionResponse(
            modes=acp.schema.SessionModeState(
                available_modes=[
                    acp.schema.SessionMode(
                        id="default",
                        name="Default",
                        description="The default mode.",
                    ),
                ],
                current_mode_id="default",
            ),
            models=acp.schema.SessionModelState(
                available_models=_expand_llm_models(config.models),
                current_model_id=model_id_conv.to_acp_model_id(),
            ),
        )

    async def fork_session(
        self, cwd: str, session_id: str, mcp_servers: list[MCPServer] | None = None, **kwargs: Any
    ) -> acp.schema.ForkSessionResponse:
        raise NotImplementedError

    async def list_sessions(
        self, cursor: str | None = None, cwd: str | None = None, **kwargs: Any
    ) -> acp.schema.ListSessionsResponse:
        logger.info("Listing sessions for working directory: {cwd}", cwd=cwd)
        if cwd is None:
            return acp.schema.ListSessionsResponse(sessions=[], next_cursor=None)
        work_dir = KaosPath.unsafe_from_local_path(Path(cwd))
        sessions = await Session.list(work_dir)
        return acp.schema.ListSessionsResponse(
            sessions=[
                acp.schema.SessionInfo(
                    cwd=cwd,
                    session_id=s.id,
                    title=s.title,
                    updated_at=datetime.fromtimestamp(s.updated_at).astimezone().isoformat(),
                )
                for s in sessions
            ],
            next_cursor=None,
        )

    async def set_session_mode(self, mode_id: str, session_id: str, **kwargs: Any) -> None:
        assert mode_id == "default", "Only default mode is supported"

    async def set_session_model(self, model_id: str, session_id: str, **kwargs: Any) -> None:
        logger.info(
            "Setting session model to {model_id} for session: {id}",
            model_id=model_id,
            id=session_id,
        )
        if session_id not in self.sessions:
            logger.error("Session not found: {id}", id=session_id)
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})

        acp_session, current_model_id = self.sessions[session_id]
        cli_instance = acp_session.cli
        model_id_conv = _ModelIDConv.from_acp_model_id(model_id)
        if model_id_conv == current_model_id:
            return

        config = cli_instance.soul.runtime.config
        new_model = config.models.get(model_id_conv.model_key)
        if new_model is None:
            logger.error("Model not found: {model_key}", model_key=model_id_conv.model_key)
            raise acp.RequestError.invalid_params({"model_id": "Model not found"})
        new_provider = config.providers.get(new_model.provider)
        if new_provider is None:
            logger.error(
                "Provider not found: {provider} for model: {model_key}",
                provider=new_model.provider,
                model_key=model_id_conv.model_key,
            )
            raise acp.RequestError.invalid_params({"model_id": "Model's provider not found"})

        new_llm = create_llm(
            new_provider,
            new_model,
            session_id=acp_session.id,
            thinking=model_id_conv.thinking,
            oauth=cli_instance.soul.runtime.oauth,
        )
        cli_instance.soul.runtime.llm = new_llm

        config.default_model = model_id_conv.model_key
        config.default_thinking = model_id_conv.thinking
        assert config.is_from_default_location, "`kimi acp` must use the default config location"
        config_for_save = load_config()
        config_for_save.default_model = model_id_conv.model_key
        config_for_save.default_thinking = model_id_conv.thinking
        save_config(config_for_save)

    async def _trigger_login_in_terminal(self, session_id: str) -> bool:
        """
        通过ACP协议在终端中触发登录流程
        
        Args:
            session_id: ACP会话ID
            
        Returns:
            bool: 登录是否成功
        """
        if not self.conn:
            logger.error("ACP client not connected, cannot trigger terminal login")
            return False
        
        terminal_id: str | None = None
        try:
            # 使用ACP协议创建终端并执行登录命令
            resp = await self.conn.create_terminal(
                command=f"{sys.executable} -m kimi_cli login",
                session_id=session_id,
                output_byte_limit=10000,
            )
            terminal_id = resp.terminal_id
            
            logger.info("Created terminal for login: {terminal_id}", terminal_id=terminal_id)
            
            # 发送进度通知
            await self._send_auth_progress(
                session_id,
                "started",
                "Login terminal created. Please complete authentication in the terminal.",
            )
            
            # 等待终端命令执行完成
            exit_status = await self.conn.wait_for_terminal_exit(
                session_id=session_id,
                terminal_id=terminal_id,
            )
            
            # 获取终端输出
            output_response = await self.conn.terminal_output(
                session_id=session_id,
                terminal_id=terminal_id,
            )
            
            # 检查登录是否成功
            ref = OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY)
            token = load_tokens(ref)
            
            success = token is not None and token.access_token is not None
            
            if success:
                logger.info("Terminal login completed successfully")
                await self._send_auth_progress(
                    session_id,
                    "completed",
                    "Login successful!",
                )
            else:
                logger.warning("Terminal login did not complete successfully")
                await self._send_auth_progress(
                    session_id,
                    "failed",
                    "Login failed. Please try again.",
                )
            
            return success
                
        except Exception as e:
            logger.error("Failed to trigger login in terminal: {error}", error=e)
            await self._send_auth_progress(
                session_id,
                "failed",
                f"Login failed: {e}",
            )
            return False
        finally:
            # 清理终端资源
            if terminal_id and self.conn:
                try:
                    await self.conn.release_terminal(
                        session_id=session_id,
                        terminal_id=terminal_id,
                    )
                except Exception as e:
                    logger.warning("Failed to release terminal: {error}", error=e)

    async def _trigger_oauth_device_flow(self, session_id: str) -> bool:
        """
        通过ACP协议触发OAuth Device Flow认证
        
        Args:
            session_id: ACP会话ID
            
        Returns:
            bool: 认证是否成功
        """
        if not self.conn:
            logger.error("ACP client not connected, cannot trigger OAuth device flow")
            return False
        
        # Check if this is a real session or a temporary session ID
        is_real_session = session_id in self.sessions
        
        try:
            # 获取设备授权
            auth: DeviceAuthorization = await request_device_authorization()
            
            logger.info("OAuth device authorization obtained, verification URL: {url}", 
                       url=auth.verification_uri_complete)
            
            # 发送认证URI给客户端（仅当有真正session时）
            if is_real_session:
                await self._send_auth_progress(
                    session_id,
                    "verification_url",
                    f"Please visit: {auth.verification_uri_complete}",
                    data={
                        "verification_url": auth.verification_uri_complete,
                        "user_code": auth.user_code,
                    },
                )
            else:
                # 对于自动认证，直接打印URL到日志
                logger.info("Please visit: {url}", url=auth.verification_uri_complete)
                logger.info("User code: {code}", code=auth.user_code)
            
            # 等待用户授权 - 轮询服务器获取令牌
            interval = max(auth.interval, 1)
            max_wait_time = 300  # 最多等待5分钟
            elapsed_time = 0
            next_update_time = 10  # 下一次发送状态更新的时间
            
            while elapsed_time < max_wait_time:
                await asyncio.sleep(interval)
                elapsed_time += interval
                
                # 调用服务器交换设备代码获取令牌
                status, data = await _request_device_token(auth)
                
                if status == 200 and "access_token" in data:
                    # 成功获取令牌，保存它
                    token = OAuthToken.from_response(data)
                    ref = OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY)
                    save_tokens(ref, token)
                    
                    logger.info("OAuth device flow completed successfully")
                    if is_real_session:
                        await self._send_auth_progress(
                            session_id,
                            "completed",
                            "Login successful!",
                        )
                    return True
                
                # 检查错误
                error_code = str(data.get("error") or "")
                if error_code == "expired_token":
                    logger.warning("Device code expired")
                    if is_real_session:
                        await self._send_auth_progress(
                            session_id,
                            "failed",
                            "Device code expired. Please try again.",
                        )
                    return False
                
                # 发送等待状态（使用独立计数器避免模运算问题）
                if elapsed_time >= next_update_time:
                    if is_real_session:
                        await self._send_auth_progress(
                            session_id,
                            "waiting",
                            f"Waiting for user authorization... ({elapsed_time}s)",
                        )
                    else:
                        logger.info("Waiting for user authorization... ({elapsed_time}s)", elapsed_time=elapsed_time)
                    next_update_time += 10
            
            # 超时
            logger.warning("OAuth device flow timed out")
            if is_real_session:
                await self._send_auth_progress(
                    session_id,
                    "timeout",
                    "Login timed out. Please try again.",
                )
            return False
            
        except Exception as e:
            logger.error("Failed to trigger OAuth device flow: {error}", error=e)
            if is_real_session:
                await self._send_auth_progress(
                    session_id,
                    "failed",
                    f"Login failed: {e}",
                )
            return False

    async def _send_auth_progress(
        self,
        session_id: str,
        status: str,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        """发送认证进度通知"""
        if not self.conn:
            return
        
        try:
            notification_data: dict[str, Any] = {
                "status": status,
                "message": message,
            }
            if data:
                notification_data["data"] = data
            
            # 使用session_update发送通知
            await self.conn.session_update(
                session_id=session_id,
                update=acp.schema.SessionUpdate(
                    session_update="auth_progress",
                    **notification_data,
                ),
            )
        except Exception as e:
            logger.warning("Failed to send auth progress notification: {error}", error=e)

    async def cancel_auth(self, session_id: str, **kwargs: Any) -> None:
        """取消正在进行的认证"""
        if session_id in self._active_auth_sessions:
            task = self._active_auth_sessions[session_id]
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            del self._active_auth_sessions[session_id]
            logger.info("Authentication cancelled for session: {id}", id=session_id)
            
            await self._send_auth_progress(
                session_id,
                "cancelled",
                "Login cancelled by user.",
            )

    async def authenticate(self, method_id: str, **kwargs: Any) -> acp.AuthenticateResponse | None:
        """
        处理认证请求
        
        对于terminal类型的认证，通过ACP协议在终端中触发登录流程
        支持OAuth Device Flow作为备选方案
        """
        if method_id == "login":
            ref = OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY)
            token = load_tokens(ref)
            
            # 如果已有有效令牌，直接返回成功
            if token and token.access_token:
                logger.info("Authentication successful for method: {id}", id=method_id)
                return acp.AuthenticateResponse()
            
            # 获取session_id - 如果没有session，使用临时ID
            # 注意：authenticate在session/new之前调用，所以可能没有session
            session_id = next(iter(self.sessions.keys()), None)
            
            # 创建认证任务并存储到_active_auth_sessions中，以便cancel_auth可以取消
            async def _run_auth() -> bool:
                """运行认证任务"""
                # 只有当有真正的session且客户端支持终端时，才使用终端登录
                # 终端登录需要一个真正的session来调用ACP协议方法
                if session_id and self.client_capabilities and self.client_capabilities.terminal:
                    return await self._trigger_login_in_terminal(session_id)
                else:
                    # 其他情况使用OAuth Device Flow
                    # OAuth device flow不需要session支持
                    logger.info("Using OAuth device flow for authentication")
                    return await self._trigger_oauth_device_flow(session_id)
            
            # 创建并存储任务
            auth_task = asyncio.create_task(_run_auth())
            self._active_auth_sessions[session_id] = auth_task
            
            try:
                # 等待认证任务完成
                login_success = await auth_task
                
                if login_success:
                    logger.info("Authentication successful")
                    return acp.AuthenticateResponse()
                else:
                    logger.warning("Authentication failed")
            except asyncio.CancelledError:
                logger.info("Authentication was cancelled")
                if session_id:
                    await self._send_auth_progress(
                        session_id,
                        "cancelled",
                        "Login cancelled by user.",
                    )
            finally:
                # 清理任务
                self._active_auth_sessions.pop(session_id, None)
            
            # 登录失败，抛出auth_required错误
            logger.warning("Authentication not complete for method: {id}", id=method_id)
            raise acp.RequestError.auth_required(
                {
                    "message": "Login failed. Please try again.",
                    "authMethods": self._auth_methods,
                }
            )

        logger.error("Unknown auth method: {method_id}", method_id=method_id)
        raise acp.RequestError.invalid_params({"method_id": "Unknown auth method"})

    async def prompt(
        self, prompt: list[ACPContentBlock], session_id: str, **kwargs: Any
    ) -> acp.PromptResponse:
        logger.info("Received prompt request for session: {id}", id=session_id)
        if session_id not in self.sessions:
            logger.error("Session not found: {id}", id=session_id)
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})
        acp_session, *_ = self.sessions[session_id]
        return await acp_session.prompt(prompt)

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        logger.info("Received cancel request for session: {id}", id=session_id)
        if session_id not in self.sessions:
            logger.error("Session not found: {id}", id=session_id)
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})
        acp_session, *_ = self.sessions[session_id]
        await acp_session.cancel()

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        raise NotImplementedError


class _ModelIDConv(NamedTuple):
    model_key: str
    thinking: bool

    @classmethod
    def from_acp_model_id(cls, model_id: str) -> _ModelIDConv:
        if model_id.endswith(",thinking"):
            return _ModelIDConv(model_id[: -len(",thinking")], True)
        return _ModelIDConv(model_id, False)

    def to_acp_model_id(self) -> str:
        if self.thinking:
            return f"{self.model_key},thinking"
        return self.model_key


def _expand_llm_models(models: dict[str, LLMModel]) -> list[acp.schema.ModelInfo]:
    expanded_models: list[acp.schema.ModelInfo] = []
    for model_key, model in models.items():
        capabilities = derive_model_capabilities(model)
        if "thinking" in model.model or "reason" in model.model:
            # always-thinking models
            expanded_models.append(
                acp.schema.ModelInfo(
                    model_id=_ModelIDConv(model_key, True).to_acp_model_id(),
                    name=f"{model.model}",
                )
            )
        else:
            expanded_models.append(
                acp.schema.ModelInfo(
                    model_id=model_key,
                    name=model.model,
                )
            )
            if "thinking" in capabilities:
                # add thinking variant
                expanded_models.append(
                    acp.schema.ModelInfo(
                        model_id=_ModelIDConv(model_key, True).to_acp_model_id(),
                        name=f"{model.model} (thinking)",
                    )
                )
    return expanded_models