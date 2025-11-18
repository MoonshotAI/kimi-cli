"""
The local version of the Grep tool using ripgrep.
Be cautious that `KaosPath` is not used in this implementation.
"""

import asyncio
import platform
import shutil
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import override

import aiohttp
import ripgrepy  # pyright: ignore[reportMissingTypeStubs]
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnType
from pydantic import BaseModel, Field

import kimi_cli
from kimi_cli.share import get_share_dir
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.logging import logger


class Params(BaseModel):
    pattern: str = Field(
        description="The regular expression pattern to search for in file contents"
    )
    path: str = Field(
        description=(
            "File or directory to search in. Defaults to current working directory. "
            "If specified, it must be an absolute path."
        ),
        default=".",
    )
    glob: str | None = Field(
        description=(
            "Glob pattern to filter files (e.g. `*.js`, `*.{ts,tsx}`). No filter by default."
        ),
        default=None,
    )
    output_mode: str = Field(
        description=(
            "`content`: Show matching lines (supports `-B`, `-A`, `-C`, `-n`, `head_limit`); "
            "`files_with_matches`: Show file paths (supports `head_limit`); "
            "`count_matches`: Show total number of matches. "
            "Defaults to `files_with_matches`."
        ),
        default="files_with_matches",
    )
    before_context: int | None = Field(
        alias="-B",
        description=(
            "Number of lines to show before each match (the `-B` option). "
            "Requires `output_mode` to be `content`."
        ),
        default=None,
    )
    after_context: int | None = Field(
        alias="-A",
        description=(
            "Number of lines to show after each match (the `-A` option). "
            "Requires `output_mode` to be `content`."
        ),
        default=None,
    )
    context: int | None = Field(
        alias="-C",
        description=(
            "Number of lines to show before and after each match (the `-C` option). "
            "Requires `output_mode` to be `content`."
        ),
        default=None,
    )
    line_number: bool = Field(
        alias="-n",
        description=(
            "Show line numbers in output (the `-n` option). Requires `output_mode` to be `content`."
        ),
        default=False,
    )
    ignore_case: bool = Field(
        alias="-i",
        description="Case insensitive search (the `-i` option).",
        default=False,
    )
    type: str | None = Field(
        description=(
            "File type to search. Examples: py, rust, js, ts, go, java, etc. "
            "More efficient than `glob` for standard file types."
        ),
        default=None,
    )
    head_limit: int | None = Field(
        description=(
            "Limit output to first N lines, equivalent to `| head -N`. "
            "Works across all output modes: content (limits output lines), "
            "files_with_matches (limits file paths), count_matches (limits count entries). "
            "By default, no limit is applied."
        ),
        default=None,
    )
    multiline: bool = Field(
        description=(
            "Enable multiline mode where `.` matches newlines and patterns can span "
            "lines (the `-U` and `--multiline-dotall` options). "
            "By default, multiline mode is disabled."
        ),
        default=False,
    )


RG_VERSION = "15.0.0"
RG_BASE_URL = "http://cdn.kimi.com/binaries/kimi-cli/rg"
_RG_DOWNLOAD_LOCK = asyncio.Lock()


def _rg_binary_name() -> str:
    return "rg.exe" if platform.system() == "Windows" else "rg"


def _find_existing_rg(bin_name: str) -> Path | None:
    share_bin = get_share_dir() / "bin" / bin_name
    if share_bin.is_file():
        return share_bin

    local_dep = Path(kimi_cli.__file__).parent / "deps" / "bin" / bin_name
    if local_dep.is_file():
        return local_dep

    system_rg = shutil.which("rg")
    if system_rg:
        return Path(system_rg)

    return None


def _detect_target() -> str | None:
    sys_name = platform.system()
    mach = platform.machine().lower()

    if mach in ("x86_64", "amd64"):
        arch = "x86_64"
    elif mach in ("arm64", "aarch64"):
        arch = "aarch64"
    else:
        logger.error("Unsupported architecture for ripgrep: {mach}", mach=mach)
        return None

    if sys_name == "Darwin":
        os_name = "apple-darwin"
    elif sys_name == "Linux":
        os_name = "unknown-linux-musl" if arch == "x86_64" else "unknown-linux-gnu"
    elif sys_name == "Windows":
        os_name = "pc-windows-msvc"
    else:
        logger.error("Unsupported operating system for ripgrep: {sys_name}", sys_name=sys_name)
        return None

    return f"{arch}-{os_name}"


async def _download_and_install_rg(bin_name: str) -> Path:
    target = _detect_target()
    if not target:
        raise RuntimeError("Unsupported platform for ripgrep download")

    is_windows = "windows" in target
    archive_ext = "zip" if is_windows else "tar.gz"
    filename = f"ripgrep-{RG_VERSION}-{target}.{archive_ext}"
    url = f"{RG_BASE_URL}/{filename}"
    logger.info("Downloading ripgrep from {url}", url=url)

    share_bin_dir = get_share_dir() / "bin"
    share_bin_dir.mkdir(parents=True, exist_ok=True)
    destination = share_bin_dir / bin_name

    async with new_client_session() as session:
        with tempfile.TemporaryDirectory(prefix="kimi-rg-") as tmpdir:
            tar_path = Path(tmpdir) / filename

            try:
                async with session.get(url) as resp:
                    resp.raise_for_status()
                    with open(tar_path, "wb") as fh:
                        async for chunk in resp.content.iter_chunked(1024 * 64):
                            if chunk:
                                fh.write(chunk)
            except (aiohttp.ClientError, TimeoutError) as exc:
                raise RuntimeError("Failed to download ripgrep binary") from exc

            try:
                if is_windows:
                    with zipfile.ZipFile(tar_path, "r") as zf:
                        member_name = next(
                            (name for name in zf.namelist() if Path(name).name == bin_name),
                            None,
                        )
                        if not member_name:
                            raise RuntimeError("Ripgrep binary not found in archive")
                        with zf.open(member_name) as source, open(destination, "wb") as dest_fh:
                            shutil.copyfileobj(source, dest_fh)
                else:
                    with tarfile.open(tar_path, "r:gz") as tar:
                        member = next(
                            (m for m in tar.getmembers() if Path(m.name).name == bin_name),
                            None,
                        )
                        if not member:
                            raise RuntimeError("Ripgrep binary not found in archive")
                        extracted = tar.extractfile(member)
                        if not extracted:
                            raise RuntimeError("Failed to extract ripgrep binary")
                        with open(destination, "wb") as dest_fh:
                            shutil.copyfileobj(extracted, dest_fh)
            except (zipfile.BadZipFile, tarfile.TarError, OSError) as exc:
                raise RuntimeError("Failed to extract ripgrep archive") from exc

    destination.chmod(destination.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    logger.info("Installed ripgrep to {destination}", destination=destination)
    return destination


async def _ensure_rg_path() -> str:
    bin_name = _rg_binary_name()
    existing = _find_existing_rg(bin_name)
    if existing:
        return str(existing)

    async with _RG_DOWNLOAD_LOCK:
        existing = _find_existing_rg(bin_name)
        if existing:
            return str(existing)

        downloaded = await _download_and_install_rg(bin_name)
        return str(downloaded)


class Grep(CallableTool2[Params]):
    name: str = "Grep"
    description: str = load_desc(Path(__file__).parent / "grep.md")
    params: type[Params] = Params

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        try:
            # Initialize ripgrep with pattern and path
            rg_path = await _ensure_rg_path()
            logger.debug("Using ripgrep binary: {rg_bin}", rg_bin=rg_path)
            rg = ripgrepy.Ripgrepy(params.pattern, params.path, rg_path=rg_path)

            # Apply search options
            if params.ignore_case:
                rg = rg.ignore_case()
            if params.multiline:
                rg = rg.multiline().multiline_dotall()

            # Content display options (only for content mode)
            if params.output_mode == "content":
                if params.before_context is not None:
                    rg = rg.before_context(params.before_context)
                if params.after_context is not None:
                    rg = rg.after_context(params.after_context)
                if params.context is not None:
                    rg = rg.context(params.context)
                if params.line_number:
                    rg = rg.line_number()

            # File filtering options
            if params.glob:
                rg = rg.glob(params.glob)
            if params.type:
                rg = rg.type_(params.type)

            # Set output mode
            if params.output_mode == "files_with_matches":
                rg = rg.files_with_matches()
            elif params.output_mode == "count_matches":
                rg = rg.count_matches()

            # Execute search
            result = rg.run()

            # Get results
            output = result.as_string

            # Apply head limit if specified
            if params.head_limit is not None:
                lines = output.split("\n")
                if len(lines) > params.head_limit:
                    lines = lines[: params.head_limit]
                    output = "\n".join(lines)
                    if params.output_mode in ["content", "files_with_matches", "count_matches"]:
                        output += f"\n... (results truncated to {params.head_limit} lines)"

            if not output:
                return ToolOk(output="", message="No matches found")
            return ToolOk(output=output)

        except Exception as e:
            return ToolError(
                message=f"Failed to grep. Error: {str(e)}",
                brief="Failed to grep",
            )
