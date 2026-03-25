from __future__ import annotations

import asyncio
import contextlib
import shlex
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
        # Store verification URL for pre-session auth (keyed by session_id sentinel)
        self._auth_verification_urls: dict[str, str] = {}

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
        # Handle PyInstaller frozen binary case
        if getattr(sys, "frozen", False):
            command = sys.executable
            terminal_args = ["login"]
        else:
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

    def _build_auth_methods_data(self) -> list[dict[str, Any]]:
        """Build flattened auth methods data for AUTH_REQUIRED errors.

        Returns a list of dicts with terminal-auth metadata in the same format
        used by _check_auth and authenticate, ensuring consistent error responses.
        """
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
        return auth_methods_data

    async def _check_auth(self) -> None:
        """Check if Kimi Code authentication is complete."""
        ref = OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY)
        token = load_tokens(ref)

        if token is None or not token.access_token:
            logger.warning("No valid token found, requesting manual authentication")
            raise acp.RequestError.auth_required(
                {"authMethods": self._build_auth_methods_data()}
            )

    async def new_session(
        self, cwd: str, mcp_servers: list[MCPServer] | None = None, **kwargs: Any
    ) -> acp.NewSessionResponse:
        logger.info("Creating new session for working directory: {cwd}", cwd=cwd)
        assert self.conn is not None, "ACP client not connected"
        assert self.client_capabilities is not None, "ACP connection not initialized"

        # Check authentication before creating session
        # Let AUTH_REQUIRED propagate to client (consistent with load_session)
        await self._check_auth()

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
            # Check authentication only when loading a new session from disk
            await self._check_auth()
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

        assert config.is_from_default_location, "`kimi acp` must use the default config location"
        # Reload config from disk to avoid overwriting concurrent changes (e.g., from login).
        # Only apply the two changed fields before saving.
        config_for_save = load_config()
        config_for_save.default_model = model_id_conv.model_key
        config_for_save.default_thinking = model_id_conv.thinking
        save_config(config_for_save)

        # Update in-memory config to stay in sync
        config.default_model = model_id_conv.model_key
        config.default_thinking = model_id_conv.thinking
        # Update the session's stored model so subsequent comparisons and
        # resume_session report the correct current model.
        self.sessions[session_id] = (acp_session, model_id_conv)

    async def _trigger_login_in_terminal(self, session_id: str) -> bool:
        """
        Trigger the login flow in a terminal via ACP protocol.

        Args:
            session_id: ACP session ID.

        Returns:
            bool: Whether the login was successful.
        """
        if not self.conn:
            logger.error("ACP client not connected, cannot trigger terminal login")
            return False
        
        terminal_id: str | None = None
        try:
            # Create terminal via ACP protocol and execute login command
            # Handle PyInstaller frozen binary case
            # Use shlex.quote to handle paths with spaces in sys.executable
            if getattr(sys, "frozen", False):
                login_command = f"{shlex.quote(sys.executable)} login"
            else:
                login_command = f"{shlex.quote(sys.executable)} -m kimi_cli login"
            
            resp = await self.conn.create_terminal(
                command=login_command,
                session_id=session_id,
                output_byte_limit=10000,
            )
            terminal_id = resp.terminal_id
            
            logger.info("Created terminal for login: {terminal_id}", terminal_id=terminal_id)
            
            # Send progress notification
            await self._send_auth_progress(
                session_id,
                "started",
                "Login terminal created. Please complete authentication in the terminal.",
            )
            
            # Wait for terminal command to complete
            await self.conn.wait_for_terminal_exit(
                session_id=session_id,
                terminal_id=terminal_id,
            )
            
            # Get terminal output (for logging only; actual verification via load_tokens)
            await self.conn.terminal_output(
                session_id=session_id,
                terminal_id=terminal_id,
            )
            
            # Check if login was successful
            ref = OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY)
            token = load_tokens(ref)
            
            success = token is not None and bool(token.access_token)
            
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
                
        except acp.RequestError as e:
            logger.error("ACP request error during terminal login: {error}", error=e)
            await self._send_auth_progress(
                session_id,
                "failed",
                f"Login failed: {e}",
            )
            return False
        except Exception as e:
            logger.error("Unexpected error during terminal login: {error}", error=e, exc_info=True)
            await self._send_auth_progress(
                session_id,
                "failed",
                f"Login failed: {e}",
            )
            return False
        finally:
            # Clean up terminal resources
            # Use asyncio.shield to prevent CancelledError from interrupting cleanup
            if terminal_id and self.conn:
                try:
                    await asyncio.shield(
                        self.conn.release_terminal(
                            session_id=session_id,
                            terminal_id=terminal_id,
                        )
                    )
                except asyncio.CancelledError:
                    # The shield protects the inner task, but the outer await
                    # can still raise CancelledError. We suppress it here to
                    # ensure cleanup completes (the shielded task continues).
                    pass
                except Exception as e:
                    logger.warning("Error while releasing terminal: {error}", error=e)

    async def _trigger_oauth_device_flow(self, session_id: str) -> bool:
        """
        Trigger OAuth Device Flow authentication via ACP protocol.

        Args:
            session_id: ACP session ID.

        Returns:
            bool: Whether the authentication was successful.
        """
        if not self.conn:
            logger.error("ACP client not connected, cannot trigger OAuth device flow")
            return False
        
        is_real_session = session_id in self.sessions
        
        try:
            # Directly call the login_kimi_code async generator
            from kimi_cli.auth.oauth import login_kimi_code
            
            config = load_config()
            
            async for event in login_kimi_code(config, open_browser=False):
                if event.type == "verification_url":
                    # Send authentication URI to client
                    if is_real_session:
                        await self._send_auth_progress(
                            session_id,
                            "verification_url",
                            event.message,
                            data=event.data,
                        )
                    else:
                        verification_url = event.data.get("verification_url") if event.data else None
                        if verification_url:
                            self._auth_verification_urls[session_id] = verification_url
                        logger.info("Please visit: {url}", url=verification_url)
                
                elif event.type == "waiting":
                    # Send waiting status
                    if is_real_session:
                        await self._send_auth_progress(
                            session_id,
                            "waiting",
                            event.message,
                        )
                    else:
                        logger.info("Waiting: {message}", message=event.message)

                elif event.type == "info":
                    # Forward informational messages from login_kimi_code
                    if is_real_session:
                        await self._send_auth_progress(
                            session_id,
                            "info",
                            event.message,
                        )
                    else:
                        logger.info("Auth info: {message}", message=event.message)

                elif event.type == "success":
                    # Login successful
                    logger.info("OAuth device flow completed successfully")
                    if is_real_session:
                        await self._send_auth_progress(
                            session_id,
                            "completed",
                            event.message,
                        )
                    # Store verification URL for pre-session auth response
                    return True
                
                elif event.type == "error":
                    # Login failed
                    logger.error("OAuth device flow failed: {error}", error=event.message)
                    if is_real_session:
                        await self._send_auth_progress(
                            session_id,
                            "failed",
                            event.message,
                        )
                    return False
            
            # If loop ends without returning success, consider it failed
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
        """Send authentication progress notification.
        
        Uses AgentThoughtChunk instead of AgentMessageChunk to avoid polluting
        the session conversation stream. Auth progress messages are auxiliary
        information that shouldn't appear as regular agent responses.
        """
        if not self.conn:
            return
        
        try:
            # Use AgentThoughtChunk which doesn't pollute the main conversation.
            # Encode auth progress info in the text content so the client
            # can display it to the user.
            display_message = message
            if data and "verification_url" in data:
                display_message = f"{message}\n\nVerification URL: {data['verification_url']}"
            
            await self.conn.session_update(
                session_id=session_id,
                update=acp.schema.AgentThoughtChunk(
                    session_update="agent_thought_chunk",
                    content=acp.schema.TextContentBlock(
                        type="text",
                        text=display_message,
                    ),
                ),
            )
        except Exception as e:
            logger.warning("Failed to send auth progress notification: {error}", error=e)

    async def cancel_auth(self, session_id: str, **kwargs: Any) -> None:
        """Cancel in-flight authentication."""
        if session_id in self._active_auth_sessions:
            task = self._active_auth_sessions[session_id]
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            self._active_auth_sessions.pop(session_id, None)
            logger.info("Authentication cancelled for session: {id}", id=session_id)

            # Only send progress notification to real sessions, not sentinel "__auth__"
            if session_id in self.sessions:
                await self._send_auth_progress(
                    session_id,
                    "cancelled",
                    "Login cancelled by user.",
                )
        # Clean up stored verification URL for this session
        self._auth_verification_urls.pop(session_id, None)

    async def authenticate(self, method_id: str, **kwargs: Any) -> acp.AuthenticateResponse | None:
        """
        Handle authentication requests.

        For terminal-based auth, triggers the login flow in a terminal via ACP protocol.
        Falls back to OAuth Device Flow when terminal auth is not available.
        """
        if method_id == "login":
            ref = OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY)
            token = load_tokens(ref)
            
            # If a valid token already exists, return success immediately
            if token and token.access_token:
                logger.info("Authentication successful for method: {id}", id=method_id)
                return acp.AuthenticateResponse()
            
            # Get session_id - use sentinel string if no session exists
            # Note: authenticate is called before session/new, so there may be no session
            session_id = next(iter(self.sessions.keys()), "__auth__")
            
            # Create auth task and store in _active_auth_sessions so cancel_auth can cancel it
            async def _run_auth() -> bool:
                """Run the authentication task."""
                # Only use terminal login when there is a real session and client supports terminal
                # Terminal login requires a real session to call ACP protocol methods
                if (
                    session_id != "__auth__"
                    and self.client_capabilities
                    and self.client_capabilities.terminal
                ):
                    return await self._trigger_login_in_terminal(session_id)
                else:
                    # Use OAuth Device Flow for other cases
                    # OAuth device flow does not require session support
                    logger.info("Using OAuth device flow for authentication")
                    return await self._trigger_oauth_device_flow(session_id)
            
            # Cancel any existing auth task for this session before starting a new one
            existing_task = self._active_auth_sessions.get(session_id)
            if existing_task and not existing_task.done():
                existing_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await existing_task

            # Create and store the task
            auth_task = asyncio.create_task(_run_auth())
            self._active_auth_sessions[session_id] = auth_task

            try:
                # Wait for auth task to complete
                login_success = await auth_task
                
                if login_success:
                    logger.info("Authentication successful")
                    return acp.AuthenticateResponse()
                else:
                    logger.warning("Authentication failed")
            except asyncio.CancelledError:
                logger.info("Authentication was cancelled")
                # Cancel the child auth task to stop polling/terminal
                auth_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await auth_task
                # Re-raise CancelledError to let the ACP framework handle cleanup.
                # The framework relies on CancelledError propagation for proper
                # cleanup (e.g., on client disconnect). Converting it to a
                # protocol error would interfere with this mechanism.
                raise
            finally:
                # Ensure the task is cancelled if we exit for any reason
                if not auth_task.done():
                    auth_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await auth_task
                # Clean up the task - only remove if it matches our task
                # (defensive: prevents race with concurrent authenticate calls)
                if self._active_auth_sessions.get(session_id) is auth_task:
                    self._active_auth_sessions.pop(session_id, None)
                # Clean up stored verification URL
                self._auth_verification_urls.pop(session_id, None)
            
            # Login failed, raise auth_required error
            logger.warning("Authentication not complete for method: {id}", id=method_id)
            raise acp.RequestError.auth_required(
                {
                    "message": "Login failed. Please try again.",
                    "authMethods": self._build_auth_methods_data(),
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
        if method == "auth/status":
            # Return authentication status and verification URL for pre-session auth
            session_id = params.get("session_id", "__auth__")
            verification_url = self._auth_verification_urls.get(session_id)
            is_active = session_id in self._active_auth_sessions
            return {
                "active": is_active,
                "verification_url": verification_url,
            }
        if method == "auth/cancel":
            # Cancel in-flight authentication for the session
            session_id = params.get("session_id", "__auth__")
            await self.cancel_auth(session_id)
            return {"cancelled": True}
        raise NotImplementedError(f"Unknown extension method: {method}")

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