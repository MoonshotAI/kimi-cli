from __future__ import annotations

import asyncio
import io
import locale
import os
import platform
import re
import shutil
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from textwrap import shorten
from typing import TYPE_CHECKING, Any

from kimi_cli.constant import VERSION
from kimi_cli.feedback.models import (
    ActiveModelInfo,
    AgentContext,
    ApprovalState,
    ChatMessage,
    ChatSummary,
    ErrorInfo,
    ExecutionSummary,
    GitInfo,
    InstallInfo,
    MCPServerSummary,
    Phase1Request,
    ProjectContext,
    SessionSummary,
    SystemInfo,
    TokenUsageSummary,
    ToolExecutionSummary,
)
from kimi_cli.feedback.redact import (
    anonymize_path,
    redact_config,
    redact_git_url,
    redact_log_content,
)
from kimi_cli.share import get_share_dir
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

# --- Phase 1 sub-collectors ---

_ENV_WHITELIST = [
    "TERM",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM_PROGRAM",
    "COLORTERM",
    "KIMI_SHARE_DIR",
    "KIMI_CLI_NO_AUTO_UPDATE",
    "VIRTUAL_ENV",
    "CONDA_DEFAULT_ENV",
]


def _collect_system_info() -> SystemInfo:
    from kimi_cli.agentspec import SUPPORTED_AGENT_SPEC_VERSIONS
    from kimi_cli.auth.oauth import get_device_id
    from kimi_cli.wire.protocol import WIRE_PROTOCOL_VERSION

    loc: str | None = None
    try:
        raw_loc = locale.getlocale()
        joined = ".".join(filter(None, raw_loc)) if raw_loc else ""
        loc = joined or None
    except Exception:
        pass

    return SystemInfo(
        os_name=platform.system(),
        os_version=platform.version(),
        os_release=platform.release(),
        os_arch=platform.machine(),
        python_version=platform.python_version(),
        kimi_cli_version=VERSION,
        agent_spec_versions=[str(v) for v in SUPPORTED_AGENT_SPEC_VERSIONS],
        wire_protocol_version=WIRE_PROTOCOL_VERSION,
        device_id=get_device_id(),
        locale=loc,
        terminal=os.environ.get("TERM"),
        shell=os.environ.get("SHELL"),
    )


def _collect_install_info() -> InstallInfo:
    executable_path = anonymize_path(sys.executable)
    kimi_bin = shutil.which("kimi")
    kimi_bin_path = anonymize_path(kimi_bin) if kimi_bin else None

    # Detect install method
    install_method = "unknown"
    install_path: str | None = None
    try:
        import importlib.metadata

        dist = importlib.metadata.distribution("kimi-cli")
        dist_location = str(dist._path.parent) if hasattr(dist, "_path") else None  # type: ignore[attr-defined]
        if dist_location:
            install_path = anonymize_path(dist_location)
            if "uv" in dist_location:
                install_method = "uv_tool"
            elif "pipx" in dist_location:
                install_method = "pipx"
            elif "site-packages" in dist_location:
                direct_url = dist.read_text("direct_url.json")
                install_method = "editable" if direct_url and '"editable"' in direct_url else "pip"
    except Exception:
        pass

    return InstallInfo(
        install_path=install_path,
        install_method=install_method,
        executable_path=executable_path,
        kimi_bin_path=kimi_bin_path,
    )


def _collect_config_redacted(soul: KimiSoul | None) -> dict[str, Any]:
    if soul is None:
        from kimi_cli.config import load_config

        try:
            config = load_config()
        except Exception:
            return {}
        return redact_config(config)
    return redact_config(soul.runtime.config)


def _collect_session_summary(soul: KimiSoul) -> SessionSummary:
    session = soul.runtime.session
    return SessionSummary(
        session_id=session.id,
        title=session.title,
        message_count=len(soul.context.history),
        token_count=soul.context.token_count,
        work_dir=anonymize_path(str(session.work_dir)),
    )


def _collect_error_info() -> ErrorInfo:
    """Extract recent errors from app log."""
    log_path = get_share_dir() / "logs" / "kimi.log"
    if not log_path.exists():
        return ErrorInfo()

    try:
        # Read only the tail of the log file to avoid loading large files
        max_scan_bytes = 50_000
        file_size = log_path.stat().st_size
        with open(log_path, encoding="utf-8", errors="replace") as f:
            if file_size > max_scan_bytes:
                f.seek(file_size - max_scan_bytes)
                f.readline()  # skip partial first line
            content = f.read()

        last_error: str | None = None
        recent_exceptions: list[str] = []

        # Find ERROR lines
        for line in content.split("\n"):
            if "| ERROR" in line or "| CRITICAL" in line:
                last_error = shorten(line.strip(), width=500)

        # Find tracebacks (simplified: look for "Traceback" blocks)
        tb_pattern = re.compile(
            r"Traceback \(most recent call last\):.*?(?=\n\d{4}-|\Z)",
            re.DOTALL,
        )
        for match in tb_pattern.finditer(content):
            tb_text = shorten(match.group(0), width=1000)
            recent_exceptions.append(redact_log_content(tb_text))

        # Keep only last 5 exceptions
        recent_exceptions = recent_exceptions[-5:]

        return ErrorInfo(last_error=last_error, recent_exceptions=recent_exceptions)
    except Exception:
        logger.debug("Failed to collect error info from log")
        return ErrorInfo()


def _collect_chat_summary(soul: KimiSoul) -> ChatSummary:
    """Get representative messages: first 3 + last 7 (deduped), each truncated."""
    history = soul.context.history
    total_count = len(history)
    messages: list[ChatMessage] = []

    # Select representative messages: first 3 + last 7 (dedup when overlapping)
    selected = list(history) if total_count <= 10 else list(history[:3]) + list(history[-7:])

    for msg in selected:
        # Extract text content
        content_text = ""
        try:
            content_text = msg.extract_text(" ")
        except Exception:
            for part in msg.content:
                if hasattr(part, "text"):
                    content_text += getattr(part, "text", "")
        content_text = shorten(content_text, width=500, placeholder="...(truncated)")

        # Extract tool call names
        tool_call_names: list[str] | None = None
        if msg.tool_calls:
            tool_call_names = [tc.function.name for tc in msg.tool_calls]

        messages.append(
            ChatMessage(
                role=msg.role,
                content=content_text,
                tool_calls=tool_call_names,
            )
        )

    return ChatSummary(total_count=total_count, messages=messages)


async def _collect_git_info(work_dir: str) -> GitInfo:
    """Collect git info from work directory."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "rev-parse",
            "--is-inside-work-tree",
            cwd=work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            return GitInfo(is_repo=False)
    except Exception:
        return GitInfo(is_repo=False)

    info = GitInfo(is_repo=True)

    # Branch
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
            cwd=work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            info.branch = stdout.decode().strip()
    except Exception:
        pass

    # Commit
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "rev-parse",
            "--short",
            "HEAD",
            cwd=work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            info.commit = stdout.decode().strip()
    except Exception:
        pass

    # Dirty
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "diff",
            "--quiet",
            "HEAD",
            cwd=work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        info.dirty = proc.returncode != 0
    except Exception:
        pass

    # Remote URL (redacted)
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "config",
            "--get",
            "remote.origin.url",
            cwd=work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            info.remote_url = redact_git_url(stdout.decode().strip())
    except Exception:
        pass

    return info


def _collect_mcp_info(soul: KimiSoul) -> list[MCPServerSummary]:
    from kimi_cli.soul.toolset import KimiToolset

    if not isinstance(soul.agent.toolset, KimiToolset):
        return []

    summaries: list[MCPServerSummary] = []
    for name, server_info in soul.agent.toolset.mcp_servers.items():
        summaries.append(
            MCPServerSummary(
                name=name,
                status=server_info.status,
                tool_count=len(server_info.tools),
                tools=[t.name for t in server_info.tools],
            )
        )
    return summaries


def _collect_env_vars() -> dict[str, str | None]:
    return {key: os.environ.get(key) for key in _ENV_WHITELIST}


def _collect_active_model(soul: KimiSoul) -> ActiveModelInfo | None:
    llm = soul.runtime.llm
    if llm is None:
        return None

    provider_type = ""
    provider_name = ""
    if llm.provider_config is not None:
        provider_type = llm.provider_config.type or ""
    if llm.model_config is not None:
        # Find the provider name from config
        provider_name = llm.model_config.provider or ""

    return ActiveModelInfo(
        model_name=llm.chat_provider.model_name,
        provider_type=provider_type,
        provider_name=provider_name,
        thinking_enabled=soul.thinking,
        max_context_size=llm.max_context_size,
        capabilities=sorted(llm.capabilities) if llm.capabilities else [],
    )


def _extract_tool_error(rv: Any) -> str:
    """Extract error message from a ToolResult return_value, truncated to 300 chars."""
    output: Any = rv.output
    if isinstance(output, str):
        return output[:300]
    if isinstance(output, list):
        for part in output:  # pyright: ignore[reportUnknownVariableType]
            text: str | None = getattr(part, "text", None)  # pyright: ignore[reportUnknownArgumentType]
            if text is not None:
                return text[:300]
    return str(rv.message)[:300] if rv.message else ""


async def _collect_wire_metrics(
    soul: KimiSoul,
) -> tuple[TokenUsageSummary, ExecutionSummary, ToolExecutionSummary, int]:
    """Single-pass wire scan for token, execution, tool metrics."""
    from kimi_cli.feedback.models import ToolError
    from kimi_cli.wire.types import (
        ApprovalRequest,
        ApprovalResponse,
        CompactionBegin,
        StatusUpdate,
        StepBegin,
        TurnBegin,
    )

    max_ctx = soul.runtime.llm.max_context_size if soul.runtime.llm else 0
    token_summary = TokenUsageSummary(max_context_size=max_ctx)
    exec_summary = ExecutionSummary(checkpoint_count=soul.context.n_checkpoints)
    tool_summary = ToolExecutionSummary()
    total_approval_requests = 0

    current_turn_steps = 0
    first_ts: float | None = None
    last_ts: float | None = None

    # Map tool_call_id -> tool_name for resolving failed tool names
    tool_call_id_to_name: dict[str, str] = {}

    try:
        async for record in soul.wire_file.iter_records():
            msg = record.to_wire_message()
            if first_ts is None:
                first_ts = record.timestamp
            last_ts = record.timestamp

            if isinstance(msg, StatusUpdate):
                tu = msg.token_usage
                if tu is not None:
                    token_summary.total_input_tokens += tu.input
                    token_summary.total_output_tokens += tu.output
                    token_summary.total_cache_read_tokens += tu.input_cache_read
                    token_summary.total_cache_creation_tokens += tu.input_cache_creation
                if msg.context_usage is not None:
                    token_summary.context_usage_pct = msg.context_usage
            elif isinstance(msg, TurnBegin):
                exec_summary.total_turns += 1
                current_turn_steps = 0
            elif isinstance(msg, StepBegin):
                exec_summary.total_steps += 1
                current_turn_steps += 1
                exec_summary.max_steps_in_turn = max(
                    exec_summary.max_steps_in_turn, current_turn_steps
                )
            elif isinstance(msg, CompactionBegin):
                exec_summary.compaction_count += 1
            elif isinstance(msg, ApprovalRequest):
                total_approval_requests += 1
            elif isinstance(msg, ApprovalResponse):
                if msg.response == "reject":
                    tool_summary.tool_rejections += 1
            else:
                # Handle ToolCall and ToolResult from kosong types
                # These are external types without proper stubs, access via Any
                type_name = type(msg).__name__
                m: Any = msg
                if type_name == "ToolCall":
                    tool_name: str = m.function.name
                    tool_call_id: str = m.id
                    tool_call_id_to_name[tool_call_id] = tool_name
                    tool_summary.total_tool_calls += 1
                    tool_summary.tool_call_counts[tool_name] = (
                        tool_summary.tool_call_counts.get(tool_name, 0) + 1
                    )
                elif type_name == "ToolResult":
                    rv: Any = m.return_value
                    if rv.is_error:
                        tool_summary.tool_failures += 1
                        tc_id: str = m.tool_call_id
                        resolved_name = tool_call_id_to_name.get(tc_id, tc_id)
                        if resolved_name not in tool_summary.failed_tool_names:
                            tool_summary.failed_tool_names.append(resolved_name)
                        # Capture error message (truncated)
                        error_msg = _extract_tool_error(rv)
                        if error_msg and len(tool_summary.recent_tool_errors) < 5:
                            tool_summary.recent_tool_errors.append(
                                ToolError(tool_name=resolved_name, error_message=error_msg)
                            )
    except Exception:
        logger.debug("Failed to collect wire metrics")

    if first_ts is not None and last_ts is not None:
        exec_summary.session_duration_seconds = round(last_ts - first_ts, 1)

    return token_summary, exec_summary, tool_summary, total_approval_requests


def _collect_approval_state(soul: KimiSoul, total_approval_requests: int = 0) -> ApprovalState:
    approval = soul.runtime.approval
    return ApprovalState(
        yolo_mode=approval.is_yolo(),
        auto_approved_actions=sorted(approval._state.auto_approve_actions),  # type: ignore[reportPrivateUsage]
        total_approval_requests=total_approval_requests,
    )


def _collect_agent_context(soul: KimiSoul) -> AgentContext:
    skills = list(soul.runtime.skills.keys())
    agents_md_present = bool(soul.runtime.builtin_args.KIMI_AGENTS_MD)
    labor_market = soul.runtime.labor_market
    subagent_count = len(labor_market.fixed_subagents) + len(labor_market.dynamic_subagents)
    return AgentContext(
        discovered_skills=sorted(skills),
        agents_md_present=agents_md_present,
        subagent_count=subagent_count,
    )


_PROJECT_MARKERS = [
    "pyproject.toml",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "Makefile",
    "CMakeLists.txt",
    ".kimirc",
    "AGENTS.md",
]


async def _collect_project_context(work_dir: str) -> ProjectContext:
    markers = [m for m in _PROJECT_MARKERS if (Path(work_dir) / m).exists()]

    file_count: int | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "ls-files",
            cwd=work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            lines = stdout.decode().strip().split("\n")
            file_count = len(lines) if lines != [""] else 0
    except Exception:
        pass

    return ProjectContext(
        project_markers=markers,
        git_tracked_file_count=file_count,
    )


# --- Phase 1 main collector ---


async def collect_phase1(soul: KimiSoul | None, user_message: str) -> Phase1Request:
    """Collect all Phase 1 data."""
    system_info = _collect_system_info()
    install_info = _collect_install_info()
    config_redacted = _collect_config_redacted(soul)
    error_info = _collect_error_info()
    env_vars = _collect_env_vars()

    session_summary: SessionSummary | None = None
    chat_summary: ChatSummary | None = None
    git_info: GitInfo | None = None
    mcp_servers: list[MCPServerSummary] = []
    token_usage_summary: TokenUsageSummary | None = None
    active_model: ActiveModelInfo | None = None
    execution_summary: ExecutionSummary | None = None
    tool_summary: ToolExecutionSummary | None = None
    approval_state: ApprovalState | None = None
    agent_context: AgentContext | None = None
    project_context: ProjectContext | None = None

    if soul is not None:
        session_summary = _collect_session_summary(soul)
        chat_summary = _collect_chat_summary(soul)
        work_dir = str(soul.runtime.session.work_dir)
        git_info = await _collect_git_info(work_dir)
        mcp_servers = _collect_mcp_info(soul)
        active_model = _collect_active_model(soul)
        (
            token_usage_summary,
            execution_summary,
            tool_summary,
            approval_req_count,
        ) = await _collect_wire_metrics(soul)
        approval_state = _collect_approval_state(soul, approval_req_count)
        agent_context = _collect_agent_context(soul)
        project_context = await _collect_project_context(work_dir)

    return Phase1Request(
        timestamp=datetime.now(UTC).isoformat(),
        user_message=user_message,
        system_info=system_info,
        install_info=install_info,
        config_redacted=config_redacted,
        session_summary=session_summary,
        error_info=error_info,
        chat_summary=chat_summary,
        git_info=git_info,
        mcp_servers=mcp_servers,
        env_vars=env_vars,
        token_usage_summary=token_usage_summary,
        active_model=active_model,
        execution_summary=execution_summary,
        tool_summary=tool_summary,
        approval_state=approval_state,
        agent_context=agent_context,
        project_context=project_context,
    )


# --- Phase 2 collectors ---

MAX_CONTEXT_SIZE = 5 * 1024 * 1024  # 5 MB
MAX_WIRE_LINES = 500
MAX_LOG_TAIL_BYTES = 100_000  # 100 KB
MAX_SOURCE_ZIP_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_SINGLE_FILE_SIZE = 1 * 1024 * 1024  # 1 MB


def _read_file_tail_bytes(path: Path, max_bytes: int) -> bytes:
    """Read at most max_bytes from the end of a file (sync helper)."""
    file_size = path.stat().st_size
    with open(path, "rb") as f:
        if file_size > max_bytes:
            f.seek(file_size - max_bytes)
        return f.read()


def _read_file_tail_lines(path: Path, max_lines: int) -> bytes:
    """Read last N lines of a text file (sync helper)."""
    content = path.read_text(encoding="utf-8", errors="replace")
    lines = content.strip().split("\n")
    tail_lines = lines[-max_lines:]
    return "\n".join(tail_lines).encode("utf-8")


async def collect_phase2_context(soul: KimiSoul) -> bytes:
    """Read full context.jsonl, capped at MAX_CONTEXT_SIZE."""
    context_path = soul.context.file_backend
    if not context_path.exists():
        return b""
    try:
        return await asyncio.to_thread(_read_file_tail_bytes, context_path, MAX_CONTEXT_SIZE)
    except Exception:
        logger.debug("Failed to read context file")
        return b""


async def collect_phase2_wire_tail(soul: KimiSoul) -> bytes:
    """Read last N lines of wire.jsonl."""
    wire_path = soul.runtime.session.wire_file.path
    if not wire_path.exists():
        return b""
    try:
        return await asyncio.to_thread(_read_file_tail_lines, wire_path, MAX_WIRE_LINES)
    except Exception:
        logger.debug("Failed to read wire file")
        return b""


async def collect_phase2_log_tail() -> bytes:
    """Read tail of app log."""
    log_path = get_share_dir() / "logs" / "kimi.log"
    if not log_path.exists():
        return b""
    try:
        raw = await asyncio.to_thread(_read_file_tail_bytes, log_path, MAX_LOG_TAIL_BYTES)
        return redact_log_content(raw.decode("utf-8", errors="replace")).encode("utf-8")
    except Exception:
        logger.debug("Failed to read app log")
        return b""


async def collect_phase2_source_zip(work_dir: str) -> bytes | None:
    """Create ZIP of git-tracked source files. Returns None on failure."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "ls-files",
            cwd=work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            return None

        files = stdout.decode().strip().split("\n")
        if not files or files == [""]:
            return None

        buf = io.BytesIO()
        total_size = 0
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for file_path in files:
                full_path = Path(work_dir) / file_path
                if not full_path.is_file():
                    continue
                try:
                    file_size = full_path.stat().st_size
                except OSError:
                    continue
                # Skip large files
                if file_size > MAX_SINGLE_FILE_SIZE:
                    continue
                # Skip binary-looking files
                try:
                    with open(full_path, "rb") as f:
                        chunk = f.read(1024)
                        if b"\x00" in chunk:
                            continue
                except OSError:
                    continue

                zf.write(full_path, file_path)
                total_size += file_size
                if total_size > MAX_SOURCE_ZIP_SIZE:
                    break

        result = buf.getvalue()
        if len(result) > MAX_SOURCE_ZIP_SIZE:
            return None
        return result
    except Exception:
        logger.debug("Failed to create source ZIP")
        return None
