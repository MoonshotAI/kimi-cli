from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import warnings
from collections.abc import AsyncGenerator, Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import kaos
from kaos.path import KaosPath
from pydantic import SecretStr

from kimi_cli.agentspec import DEFAULT_AGENT_FILE, load_agent_spec
from kimi_cli.auth.oauth import OAuthManager
from kimi_cli.cli import InputFormat, OutputFormat
from kimi_cli.config import Config, LLMModel, LLMProvider, load_config
from kimi_cli.llm import (
    augment_provider_with_env_vars,
    clone_llm_with_model_alias,
    create_llm,
    model_display_name,
)
from kimi_cli.session import Session
from kimi_cli.share import get_share_dir
from kimi_cli.soul import run_soul
from kimi_cli.soul.agent import Runtime, load_agent, load_agent_from_resolved_spec
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.utils.logging import logger, redirect_stderr_to_logger
from kimi_cli.utils.path import shorten_home
from kimi_cli.wire import Wire, WireUISide
from kimi_cli.wire.types import ApprovalRequest, ApprovalResponse, ContentPart, WireMessage

if TYPE_CHECKING:
    from fastmcp.mcp_config import MCPConfig

    from kimi_cli.claude_plugin.spec import ClaudeAgentSpec


def _patch_session_id(record: dict[str, Any]) -> None:
    """Inject the current session ID (from ContextVar) into log records."""
    try:
        from kimi_cli.soul.toolset import get_session_id

        sid = get_session_id()
        record["extra"]["sid"] = sid if sid else ""
    except Exception:
        record["extra"].setdefault("sid", "")


def enable_logging(debug: bool = False, *, redirect_stderr: bool = True) -> None:
    # NOTE: stderr redirection is implemented by swapping the process-level fd=2 (dup2).
    # That can hide Click/Typer error output during CLI startup, so some entrypoints delay
    # installing it until after critical initialization succeeds.
    logger.remove()  # Remove default stderr handler
    logger.enable("kimi_cli")
    if debug:
        logger.enable("kosong")
    logger.add(
        get_share_dir() / "logs" / "kimi.log",
        # FIXME: configure level for different modules
        level="TRACE" if debug else "INFO",
        format=(
            "{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | "
            "{name}:{function}:{line} | {extra[sid]} - {message}"
        ),
        rotation="06:00",
        retention="10 days",
    )
    logger.configure(extra={"sid": ""}, patcher=_patch_session_id)
    if redirect_stderr:
        redirect_stderr_to_logger()


def _cleanup_stale_foreground_subagents(runtime: Runtime) -> None:
    subagent_store = getattr(runtime, "subagent_store", None)
    if subagent_store is None:
        return

    stale_agent_ids = [
        record.agent_id
        for record in subagent_store.list_instances()
        if record.status == "running_foreground"
    ]
    for agent_id in stale_agent_ids:
        logger.warning(
            "Marking stale foreground subagent instance as failed during startup: {agent_id}",
            agent_id=agent_id,
        )
        subagent_store.update_instance(agent_id, status="failed")


def _filter_supported_plugin_agent_tools(
    raw_tools: Any,
    *,
    field_name: str,
    agent_name: str,
) -> tuple[list[str] | None, bool]:
    """
    Keep only plugin-agent tool entries that can be consumed by Kimi's
    YAML-style tool loader.

    Claude agent frontmatter often uses names like ``Read`` or ``Edit``.
    Those are not valid Kimi import paths, so v1 treats them as best-effort
    metadata: warn and ignore them instead of failing agent loading.
    """
    if raw_tools is None:
        return None, False

    entries_to_check: list[Any]
    if isinstance(raw_tools, str):
        entries_to_check = [raw_tools]
    elif isinstance(raw_tools, list):
        entries_to_check = cast(list[Any], raw_tools)
    else:
        logger.warning(
            "Ignoring unsupported Claude plugin agent {field} value for {agent}: {value}",
            field=field_name,
            agent=agent_name,
            value=raw_tools,
        )
        return None, False

    supported: list[str] = []
    ignored: list[str] = []
    for entry in entries_to_check:
        if isinstance(entry, str) and ":" in entry:
            supported.append(entry)
        else:
            ignored.append(str(entry))

    if ignored:
        logger.warning(
            "Ignoring unsupported Claude plugin agent {field} entries for {agent}: {entries}",
            field=field_name,
            agent=agent_name,
            entries=ignored,
        )

    if supported:
        return supported, True
    if ignored:
        return None, False
    return [], True


def _merge_plugin_capability_summary(prompt: str, cap_summary: str) -> str:
    """Replace any old plugin capability summary with the current one."""
    from kimi_cli.claude_plugin.discovery import (
        PLUGIN_SUMMARY_SENTINEL_BEGIN,
        PLUGIN_SUMMARY_SENTINEL_END,
    )

    begin = prompt.find(PLUGIN_SUMMARY_SENTINEL_BEGIN)
    if begin != -1:
        end = prompt.find(PLUGIN_SUMMARY_SENTINEL_END, begin)
        if end != -1:
            end += len(PLUGIN_SUMMARY_SENTINEL_END)
            base_prompt = (prompt[:begin] + prompt[end:]).strip()
        else:
            base_prompt = prompt[:begin].rstrip()
    else:
        base_prompt = prompt.rstrip()
    if not cap_summary:
        return base_prompt
    if not base_prompt:
        return cap_summary
    return base_prompt + "\n\n" + cap_summary


class KimiCLI:
    @staticmethod
    async def create(
        session: Session,
        *,
        # Basic configuration
        config: Config | Path | None = None,
        model_name: str | None = None,
        thinking: bool | None = None,
        # Run mode
        yolo: bool = False,
        plan_mode: bool = False,
        resumed: bool = False,
        # Extensions
        agent_file: Path | None = None,
        mcp_configs: list[MCPConfig] | list[dict[str, Any]] | None = None,
        skills_dirs: list[KaosPath] | None = None,
        plugin_dirs: list[Path] | None = None,
        # Loop control
        max_steps_per_turn: int | None = None,
        max_retries_per_step: int | None = None,
        max_ralph_iterations: int | None = None,
        startup_progress: Callable[[str], None] | None = None,
        defer_mcp_loading: bool = False,
    ) -> KimiCLI:
        """
        Create a KimiCLI instance.

        Args:
            session (Session): A session created by `Session.create` or `Session.continue_`.
            config (Config | Path | None, optional): Configuration to use, or path to config file.
                Defaults to None.
            model_name (str | None, optional): Name of the model to use. Defaults to None.
            thinking (bool | None, optional): Whether to enable thinking mode. Defaults to None.
            yolo (bool, optional): Approve all actions without confirmation. Defaults to False.
            agent_file (Path | None, optional): Path to the agent file. Defaults to None.
            mcp_configs (list[MCPConfig | dict[str, Any]] | None, optional): MCP configs to load
                MCP tools from. Defaults to None.
            skills_dirs (list[KaosPath] | None, optional): Custom skills directories that
                override default user/project discovery. Defaults to None.
            max_steps_per_turn (int | None, optional): Maximum number of steps in one turn.
                Defaults to None.
            max_retries_per_step (int | None, optional): Maximum number of retries in one step.
                Defaults to None.
            max_ralph_iterations (int | None, optional): Extra iterations after the first turn in
                Ralph mode. Defaults to None.
            startup_progress (Callable[[str], None] | None, optional): Progress callback used by
                interactive startup UI. Defaults to None.
            defer_mcp_loading (bool, optional): Defer MCP startup until the interactive shell is
                ready. Defaults to False.

        Raises:
            FileNotFoundError: When the agent file is not found.
            ConfigError(KimiCLIException, ValueError): When the configuration is invalid.
            AgentSpecError(KimiCLIException, ValueError): When the agent specification is invalid.
            SystemPromptTemplateError(KimiCLIException, ValueError): When the system prompt
                template is invalid.
            InvalidToolError(KimiCLIException, ValueError): When any tool cannot be loaded.
            MCPConfigError(KimiCLIException, ValueError): When any MCP configuration is invalid.
            MCPRuntimeError(KimiCLIException, RuntimeError): When any MCP server cannot be
                connected.
        """
        if startup_progress is not None:
            startup_progress("Loading configuration...")

        config = config if isinstance(config, Config) else load_config(config)
        if max_steps_per_turn is not None:
            config.loop_control.max_steps_per_turn = max_steps_per_turn
        if max_retries_per_step is not None:
            config.loop_control.max_retries_per_step = max_retries_per_step
        if max_ralph_iterations is not None:
            config.loop_control.max_ralph_iterations = max_ralph_iterations
        logger.info("Loaded config: {config}", config=config)

        oauth = OAuthManager(config)

        model: LLMModel | None = None
        provider: LLMProvider | None = None

        # try to use config file
        if not model_name and config.default_model:
            # no --model specified && default model is set in config
            model = config.models[config.default_model]
            provider = config.providers[model.provider]
        if model_name and model_name in config.models:
            # --model specified && model is set in config
            model = config.models[model_name]
            provider = config.providers[model.provider]

        if not model:
            model = LLMModel(provider="", model="", max_context_size=100_000)
            provider = LLMProvider(type="kimi", base_url="", api_key=SecretStr(""))

        # try overwrite with environment variables
        assert provider is not None
        assert model is not None
        env_overrides = augment_provider_with_env_vars(provider, model)

        # determine thinking mode
        thinking = config.default_thinking if thinking is None else thinking

        # determine yolo mode
        yolo = yolo if yolo else config.default_yolo

        # determine plan mode (only for new sessions, not restored)
        if not resumed:
            plan_mode = plan_mode if plan_mode else config.default_plan_mode

        llm = create_llm(
            provider,
            model,
            thinking=thinking,
            session_id=session.id,
            oauth=oauth,
        )
        if llm is not None:
            logger.info("Using LLM provider: {provider}", provider=provider)
            logger.info("Using LLM model: {model}", model=model)
            logger.info("Thinking mode: {thinking}", thinking=thinking)

        if startup_progress is not None:
            startup_progress("Scanning workspace...")

        runtime = await Runtime.create(
            config,
            oauth,
            llm,
            session,
            yolo,
            skills_dirs=skills_dirs,
        )
        runtime.notifications.recover()
        runtime.background_tasks.reconcile()
        _cleanup_stale_foreground_subagents(runtime)

        # Refresh plugin configs with fresh credentials (e.g. OAuth tokens)
        try:
            from kimi_cli.plugin.manager import (
                collect_host_values,
                get_plugins_dir,
                refresh_plugin_configs,
            )

            host_values = collect_host_values(config, oauth)
            if host_values.get("api_key"):
                refresh_plugin_configs(get_plugins_dir(), host_values)
        except Exception:
            logger.debug("Failed to refresh plugin configs, skipping")

        # --- Claude plugin compatibility layer ---
        _plugin_mcp_extras: list[dict[str, Any]] = []
        claude_plugin_bundle = None
        _plugin_default_agent_candidates: list[tuple[str, Path]] = []
        if plugin_dirs:
            from kimi_cli.claude_plugin.discovery import load_claude_plugins
            from kimi_cli.skill import normalize_skill_name

            claude_plugin_bundle = load_claude_plugins(plugin_dirs)

            # Merge plugin skills into runtime (after built-in/user/project skills)
            _plugin_skills_added = False
            for plugin_rt in claude_plugin_bundle.plugins.values():
                for skill_name, skill in plugin_rt.skills.items():
                    normalized_skill_name = normalize_skill_name(skill_name)
                    if normalized_skill_name not in runtime.skills:
                        runtime.skills[normalized_skill_name] = skill
                        _plugin_skills_added = True

                # Track plugin skill roots for Glob access
                plugin_skills_dir = plugin_rt.root / "skills"
                if plugin_skills_dir.is_dir():
                    from kimi_cli.utils.path import is_within_directory

                    kaos_dir = KaosPath.unsafe_from_local_path(plugin_skills_dir)
                    if not is_within_directory(kaos_dir, session.work_dir):
                        runtime.skills_dirs.append(kaos_dir)

                # Merge plugin MCP configs (session-scoped only, never persisted)
                for pc in plugin_rt.mcp_configs:
                    _plugin_mcp_extras.append(pc)

                # Collect plugin default-agent candidates in load order.
                # We choose the first *valid* markdown agent later.
                if agent_file is None and plugin_rt.default_agent_file is not None:
                    _plugin_default_agent_candidates.append(
                        (plugin_rt.manifest.name, plugin_rt.default_agent_file)
                    )

                # Log any plugin warnings
                for warning in plugin_rt.warnings:
                    logger.warning("Claude plugin: {warning}", warning=warning)

            # Rebuild KIMI_SKILLS in system prompt args to include plugin skills
            if _plugin_skills_added:
                all_skills = sorted(runtime.skills.values(), key=lambda s: s.name)
                new_skills_text = "\n".join(
                    f"- {s.name}\n  - Path: {s.skill_md_file}\n  - Description: {s.description}"
                    for s in all_skills
                )
                runtime.builtin_args = dataclasses.replace(
                    runtime.builtin_args,
                    KIMI_SKILLS=new_skills_text or "No skills found.",
                )

        # Detect if the selected agent_file is a Claude plugin Markdown agent
        _claude_plugin_agent_spec: ClaudeAgentSpec | None = None
        _selected_plugin_default_candidate_index: int | None = None
        if agent_file is None and _plugin_default_agent_candidates:
            from kimi_cli.claude_plugin.agents import parse_agent_md

            for idx, (_plugin_name, _plugin_agent_file) in enumerate(
                _plugin_default_agent_candidates
            ):
                _resolved_candidate = _plugin_agent_file.resolve()
                try:
                    _claude_plugin_agent_spec = parse_agent_md(
                        _resolved_candidate, _plugin_name
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to parse plugin default agent {plugin}:{path}, "
                        "trying later plugin defaults or falling back to the default agent: "
                        "{error}",
                        plugin=_plugin_name,
                        path=_resolved_candidate,
                        error=exc,
                    )
                    continue

                agent_file = DEFAULT_AGENT_FILE
                _selected_plugin_default_candidate_index = idx
                break

        if (
            _claude_plugin_agent_spec is None
            and
            agent_file is not None
            and agent_file.suffix == ".md"
            and claude_plugin_bundle is not None
        ):
            # Only files already parsed from <plugin>/agents/ are eligible
            # for plugin-agent overlay. Other Markdown files inside the
            # plugin tree (for example commands/*.md) must not be reclassified.
            _resolved_agent = agent_file.resolve()
            for _pname, _prt in claude_plugin_bundle.plugins.items():
                _matched_agent = next(
                    (
                        _agent_spec
                        for _agent_spec in _prt.agents.values()
                        if _agent_spec.file_path is not None
                        and _resolved_agent == _agent_spec.file_path.resolve()
                    ),
                    None,
                )
                if _matched_agent is not None:
                    _claude_plugin_agent_spec = _matched_agent
                    break

            # Only fall back to DEFAULT_AGENT_FILE when we actually matched
            # a plugin agent. A non-plugin .md file must be kept as-is.
            if _claude_plugin_agent_spec is not None:
                agent_file = DEFAULT_AGENT_FILE

        _plugin_agent_requires_full_overlay = _claude_plugin_agent_spec is not None and (
            _claude_plugin_agent_spec.model is not None
            or _claude_plugin_agent_spec.tools is not None
            or _claude_plugin_agent_spec.allowed_tools is not None
        )

        if agent_file is None:
            agent_file = DEFAULT_AGENT_FILE
        if startup_progress is not None:
            startup_progress("Loading agent...")

        # Merge plugin MCP configs into the list passed to load_agent
        _all_mcp: list[Any] = list(mcp_configs or []) + _plugin_mcp_extras

        async def _load_plugin_overlay_agent(plugin_agent_spec: ClaudeAgentSpec) -> Any:
            original_llm = runtime.llm
            try:
                base_agent_spec = load_agent_spec(DEFAULT_AGENT_FILE)
                filtered_tools, tools_override = _filter_supported_plugin_agent_tools(
                    plugin_agent_spec.tools,
                    field_name="tools",
                    agent_name=plugin_agent_spec.full_name,
                )
                filtered_allowed_tools, allowed_tools_override = (
                    _filter_supported_plugin_agent_tools(
                        plugin_agent_spec.allowed_tools,
                        field_name="allowed-tools",
                        agent_name=plugin_agent_spec.full_name,
                    )
                )
                merged_tools: list[str] = (
                    filtered_tools
                    if tools_override and filtered_tools is not None
                    else base_agent_spec.tools
                )
                merged_allowed_tools: list[str] | None = (
                    filtered_allowed_tools
                    if allowed_tools_override
                    else None
                    if tools_override
                    else base_agent_spec.allowed_tools
                )
                merged_agent_spec = dataclasses.replace(
                    base_agent_spec,
                    name=plugin_agent_spec.full_name,
                    model=plugin_agent_spec.model or base_agent_spec.model,
                    tools=merged_tools,
                    allowed_tools=merged_allowed_tools,
                )

                if plugin_agent_spec.model is not None:
                    cloned_llm = clone_llm_with_model_alias(
                        runtime.llm,
                        runtime.config,
                        plugin_agent_spec.model,
                        session_id=runtime.session.id,
                        oauth=runtime.oauth,
                    )
                    if cloned_llm is None and original_llm is not None:
                        raise ValueError(
                            f"Unable to instantiate model alias: {plugin_agent_spec.model}"
                        )
                    runtime.llm = cloned_llm

                return await load_agent_from_resolved_spec(
                    merged_agent_spec,
                    runtime,
                    mcp_configs=_all_mcp,
                    start_mcp_loading=not defer_mcp_loading,
                    system_prompt_override=plugin_agent_spec.system_prompt,
                )
            except Exception:
                runtime.llm = original_llm
                raise

        agent = None
        _effective_plugin_agent_spec: ClaudeAgentSpec | None = _claude_plugin_agent_spec
        _effective_plugin_default_candidate_index = _selected_plugin_default_candidate_index
        if _plugin_agent_requires_full_overlay and _claude_plugin_agent_spec is not None:
            if _selected_plugin_default_candidate_index is not None:
                from kimi_cli.claude_plugin.agents import parse_agent_md

                for idx in range(
                    _selected_plugin_default_candidate_index,
                    len(_plugin_default_agent_candidates),
                ):
                    candidate_spec: ClaudeAgentSpec
                    if idx == _selected_plugin_default_candidate_index:
                        candidate_spec = _claude_plugin_agent_spec
                    else:
                        plugin_name, plugin_agent_file = _plugin_default_agent_candidates[idx]
                        resolved_candidate = plugin_agent_file.resolve()
                        try:
                            candidate_spec = parse_agent_md(resolved_candidate, plugin_name)
                        except Exception as exc:
                            logger.warning(
                                "Failed to parse plugin default agent {plugin}:{path}, "
                                "trying later plugin defaults or falling back to the default "
                                "agent: {error}",
                                plugin=plugin_name,
                                path=resolved_candidate,
                                error=exc,
                            )
                            continue

                    try:
                        agent = await _load_plugin_overlay_agent(candidate_spec)
                    except Exception as exc:
                        logger.warning(
                            "Failed to load plugin default agent {plugin}:{path}, "
                            "trying later plugin defaults or falling back to the default agent: "
                            "{error}",
                            plugin=_plugin_default_agent_candidates[idx][0],
                            path=_plugin_default_agent_candidates[idx][1].resolve(),
                            error=exc,
                        )
                        continue

                    _effective_plugin_agent_spec = candidate_spec
                    _effective_plugin_default_candidate_index = idx
                    break
                else:
                    _effective_plugin_agent_spec = None
            else:
                agent = await _load_plugin_overlay_agent(_claude_plugin_agent_spec)

        if agent is None:
            agent = await load_agent(
                agent_file,
                runtime,
                mcp_configs=_all_mcp,
                start_mcp_loading=not defer_mcp_loading,
            )

            # If a Claude plugin agent was selected, overlay its system prompt
            if _effective_plugin_agent_spec is not None:
                agent = dataclasses.replace(
                    agent,
                    name=_effective_plugin_agent_spec.full_name,
                    system_prompt=_effective_plugin_agent_spec.system_prompt,
                )

        if (
            _effective_plugin_agent_spec is not None
            and _effective_plugin_default_candidate_index is not None
        ):
            for _later_plugin_name, _ in _plugin_default_agent_candidates[
                _effective_plugin_default_candidate_index + 1 :
            ]:
                logger.warning(
                    "Ignoring default agent from plugin '{plugin}' because "
                    "a prior plugin default agent is already selected",
                    plugin=_later_plugin_name,
                )

        cap_summary = ""
        # Build plugin capability summary so the model can autonomously choose
        # plugin capabilities for goal-oriented requests.
        if claude_plugin_bundle:
            from kimi_cli.claude_plugin.discovery import build_plugin_capability_summary
            from kimi_cli.soul.kimisoul import FLOW_COMMAND_PREFIX, SKILL_COMMAND_PREFIX
            from kimi_cli.soul.slash import registry as soul_slash_registry

            reserved_command_names = {cmd.name for cmd in soul_slash_registry.list_commands()}
            registered_plugin_skill_names: set[str] = set()
            for skill in runtime.skills.values():
                if skill.type not in ("standard", "flow"):
                    continue
                if skill.is_plugin:
                    if skill.type == "flow" and skill.flow is not None:
                        continue
                    if skill.name not in reserved_command_names:
                        reserved_command_names.add(skill.name)
                        registered_plugin_skill_names.add(skill.name)
                else:
                    reserved_command_names.add(f"{SKILL_COMMAND_PREFIX}{skill.name}")
                    if skill.type == "flow":
                        reserved_command_names.add(f"{FLOW_COMMAND_PREFIX}{skill.name}")
            for skill in runtime.skills.values():
                if skill.type != "flow":
                    continue
                command_name = (
                    skill.name if skill.is_plugin else f"{FLOW_COMMAND_PREFIX}{skill.name}"
                )
                if command_name in reserved_command_names:
                    continue
                reserved_command_names.add(command_name)
                if skill.is_plugin:
                    registered_plugin_skill_names.add(skill.name)

            cap_summary = build_plugin_capability_summary(
                claude_plugin_bundle,
                reserved_command_names=reserved_command_names,
                registered_plugin_skill_names=registered_plugin_skill_names,
            )

        if startup_progress is not None:
            startup_progress("Restoring conversation...")
        context = Context(session.context_file)
        await context.restore()

        if context.system_prompt is not None:
            restored_prompt = _merge_plugin_capability_summary(
                context.system_prompt,
                cap_summary,
            )
            agent = dataclasses.replace(agent, system_prompt=restored_prompt)
        else:
            if cap_summary:
                agent = dataclasses.replace(
                    agent,
                    system_prompt=_merge_plugin_capability_summary(
                        agent.system_prompt, cap_summary
                    ),
                )
            await context.write_system_prompt(agent.system_prompt)

        soul = KimiSoul(agent, context=context)

        # Register plugin commands on soul (before hook engine so hooks can fire)
        if claude_plugin_bundle:
            soul.register_plugin_commands(claude_plugin_bundle)

        # Activate plan mode if requested (for new sessions or --plan flag)
        if plan_mode and not soul.plan_mode:
            await soul.set_plan_mode_from_manual(True)
        elif plan_mode and soul.plan_mode:
            # Already in plan mode from restored session, trigger activation reminder
            soul.schedule_plan_activation_reminder()

        # Create and inject hook engine
        from kimi_cli.hooks.engine import HookEngine

        hook_engine = HookEngine(config.hooks, cwd=str(session.work_dir))

        # Inject plugin hooks (session-scoped only)
        if claude_plugin_bundle:
            for plugin_rt in claude_plugin_bundle.plugins.values():
                if plugin_rt.hooks:
                    hook_engine.add_hooks(plugin_rt.hooks)

        soul.set_hook_engine(hook_engine)
        runtime.hook_engine = hook_engine

        return KimiCLI(soul, runtime, env_overrides)

    def __init__(
        self,
        _soul: KimiSoul,
        _runtime: Runtime,
        _env_overrides: dict[str, str],
    ) -> None:
        self._soul = _soul
        self._runtime = _runtime
        self._env_overrides = _env_overrides

    @property
    def soul(self) -> KimiSoul:
        """Get the KimiSoul instance."""
        return self._soul

    @property
    def session(self) -> Session:
        """Get the Session instance."""
        return self._runtime.session

    def shutdown_background_tasks(self) -> None:
        """Kill active background tasks on exit, unless keep_alive_on_exit is configured."""
        if self._runtime.config.background.keep_alive_on_exit:
            return
        killed = self._runtime.background_tasks.kill_all_active(reason="CLI session ended")
        if killed:
            logger.info("Stopped {n} background task(s) on exit: {ids}", n=len(killed), ids=killed)

    @contextlib.asynccontextmanager
    async def _env(self) -> AsyncGenerator[None]:
        original_cwd = KaosPath.cwd()
        await kaos.chdir(self._runtime.session.work_dir)
        try:
            # to ignore possible warnings from dateparser
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            async with self._runtime.oauth.refreshing(self._runtime):
                yield
        finally:
            await kaos.chdir(original_cwd)

    async def run(
        self,
        user_input: str | list[ContentPart],
        cancel_event: asyncio.Event,
        merge_wire_messages: bool = False,
    ) -> AsyncGenerator[WireMessage]:
        """
        Run the Kimi Code CLI instance without any UI and yield Wire messages directly.

        Args:
            user_input (str | list[ContentPart]): The user input to the agent.
            cancel_event (asyncio.Event): An event to cancel the run.
            merge_wire_messages (bool): Whether to merge Wire messages as much as possible.

        Yields:
            WireMessage: The Wire messages from the `KimiSoul`.

        Raises:
            LLMNotSet: When the LLM is not set.
            LLMNotSupported: When the LLM does not have required capabilities.
            ChatProviderError: When the LLM provider returns an error.
            MaxStepsReached: When the maximum number of steps is reached.
            RunCancelled: When the run is cancelled by the cancel event.
        """
        async with self._env():
            wire_future = asyncio.Future[WireUISide]()
            stop_ui_loop = asyncio.Event()
            approval_bridge_tasks: dict[str, asyncio.Task[None]] = {}
            forwarded_approval_requests: dict[str, ApprovalRequest] = {}

            async def _bridge_approval_request(request: ApprovalRequest) -> None:
                try:
                    response = await request.wait()
                    assert self._runtime.approval_runtime is not None
                    self._runtime.approval_runtime.resolve(
                        request.id, response, feedback=request.feedback
                    )
                finally:
                    approval_bridge_tasks.pop(request.id, None)
                    forwarded_approval_requests.pop(request.id, None)

            def _forward_approval_request(wire: Wire, request: ApprovalRequest) -> None:
                if request.id in forwarded_approval_requests:
                    return
                forwarded_approval_requests[request.id] = request
                if request.id not in approval_bridge_tasks:
                    approval_bridge_tasks[request.id] = asyncio.create_task(
                        _bridge_approval_request(request)
                    )
                wire.soul_side.send(request)

            async def _ui_loop_fn(wire: Wire) -> None:
                wire_future.set_result(wire.ui_side(merge=merge_wire_messages))
                assert self._runtime.root_wire_hub is not None
                assert self._runtime.approval_runtime is not None
                root_hub_queue = self._runtime.root_wire_hub.subscribe()
                stop_task = asyncio.create_task(stop_ui_loop.wait())
                queue_task = asyncio.create_task(root_hub_queue.get())
                try:
                    for pending in self._runtime.approval_runtime.list_pending():
                        _forward_approval_request(
                            wire,
                            ApprovalRequest(
                                id=pending.id,
                                tool_call_id=pending.tool_call_id,
                                sender=pending.sender,
                                action=pending.action,
                                description=pending.description,
                                display=pending.display,
                                source_kind=pending.source.kind,
                                source_id=pending.source.id,
                                agent_id=pending.source.agent_id,
                                subagent_type=pending.source.subagent_type,
                            ),
                        )
                    while True:
                        done, _ = await asyncio.wait(
                            [stop_task, queue_task],
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if stop_task in done:
                            break
                        try:
                            msg = queue_task.result()
                        except QueueShutDown:
                            break
                        match msg:
                            case ApprovalRequest() as request:
                                _forward_approval_request(wire, request)
                                queue_task = asyncio.create_task(root_hub_queue.get())
                                continue
                            case ApprovalResponse() as response:
                                if (
                                    request := forwarded_approval_requests.get(response.request_id)
                                ) and not request.resolved:
                                    request.resolve(response.response, response.feedback)
                            case _:
                                pass
                        wire.soul_side.send(msg)
                        queue_task = asyncio.create_task(root_hub_queue.get())
                finally:
                    stop_task.cancel()
                    queue_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await stop_task
                    with contextlib.suppress(asyncio.CancelledError):
                        await queue_task
                    for task in list(approval_bridge_tasks.values()):
                        task.cancel()
                    for task in list(approval_bridge_tasks.values()):
                        with contextlib.suppress(asyncio.CancelledError):
                            await task
                    approval_bridge_tasks.clear()
                    forwarded_approval_requests.clear()
                    assert self._runtime.root_wire_hub is not None
                    self._runtime.root_wire_hub.unsubscribe(root_hub_queue)

            soul_task = asyncio.create_task(
                run_soul(
                    self.soul,
                    user_input,
                    _ui_loop_fn,
                    cancel_event,
                    runtime=self._runtime,
                )
            )

            try:
                wire_ui = await wire_future
                while True:
                    msg = await wire_ui.receive()
                    yield msg
            except QueueShutDown:
                pass
            finally:
                # stop consuming Wire messages
                stop_ui_loop.set()
                # wait for the soul task to finish, or raise
                await soul_task

    async def run_shell(
        self, command: str | None = None, *, prefill_text: str | None = None
    ) -> bool:
        """Run the Kimi Code CLI instance with shell UI."""
        from kimi_cli.ui.shell import Shell, WelcomeInfoItem

        if command is None:
            from kimi_cli.ui.shell.update import check_update_gate

            check_update_gate()

        welcome_info = [
            WelcomeInfoItem(
                name="Directory", value=str(shorten_home(self._runtime.session.work_dir))
            ),
            WelcomeInfoItem(name="Session", value=self._runtime.session.id),
        ]
        if base_url := self._env_overrides.get("KIMI_BASE_URL"):
            welcome_info.append(
                WelcomeInfoItem(
                    name="API URL",
                    value=f"{base_url} (from KIMI_BASE_URL)",
                    level=WelcomeInfoItem.Level.WARN,
                )
            )
        if self._env_overrides.get("KIMI_API_KEY"):
            welcome_info.append(
                WelcomeInfoItem(
                    name="API Key",
                    value="****** (from KIMI_API_KEY)",
                    level=WelcomeInfoItem.Level.WARN,
                )
            )
        if not self._runtime.llm:
            welcome_info.append(
                WelcomeInfoItem(
                    name="Model",
                    value="not set, send /login to login",
                    level=WelcomeInfoItem.Level.WARN,
                )
            )
        elif "KIMI_MODEL_NAME" in self._env_overrides:
            welcome_info.append(
                WelcomeInfoItem(
                    name="Model",
                    value=f"{self._soul.model_name} (from KIMI_MODEL_NAME)",
                    level=WelcomeInfoItem.Level.WARN,
                )
            )
        else:
            welcome_info.append(
                WelcomeInfoItem(
                    name="Model",
                    value=model_display_name(self._soul.model_name),
                    level=WelcomeInfoItem.Level.INFO,
                )
            )
            model_name = self._soul.model_name
            if model_name not in (
                "kimi-for-coding",
                "kimi-code",
            ) and not model_name.startswith("kimi-k2"):
                welcome_info.append(
                    WelcomeInfoItem(
                        name="Tip",
                        value="send /login to use Kimi for Coding",
                        level=WelcomeInfoItem.Level.WARN,
                    )
                )
        welcome_info.append(
            WelcomeInfoItem(
                name="\nTip",
                value=(
                    "Spot a bug or have feedback? Type /feedback right in this session"
                    " — every report makes Kimi better."
                ),
                level=WelcomeInfoItem.Level.INFO,
            )
        )
        async with self._env():
            shell = Shell(self._soul, welcome_info=welcome_info, prefill_text=prefill_text)
            return await shell.run(command)

    async def run_print(
        self,
        input_format: InputFormat,
        output_format: OutputFormat,
        command: str | None = None,
        *,
        final_only: bool = False,
    ) -> int:
        """Run the Kimi Code CLI instance with print UI."""
        from kimi_cli.ui.print import Print

        async with self._env():
            print_ = Print(
                self._soul,
                input_format,
                output_format,
                self._runtime.session.context_file,
                final_only=final_only,
            )
            return await print_.run(command)

    async def run_acp(self) -> None:
        """Run the Kimi Code CLI instance as ACP server."""
        from kimi_cli.ui.acp import ACP

        async with self._env():
            acp = ACP(self._soul)
            await acp.run()

    async def run_wire_stdio(self) -> None:
        """Run the Kimi Code CLI instance as Wire server over stdio."""
        from kimi_cli.wire.server import WireServer

        async with self._env():
            server = WireServer(self._soul)
            await server.serve()
