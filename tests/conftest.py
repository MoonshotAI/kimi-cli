"""Test configuration and fixtures."""

from __future__ import annotations

import platform
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import pytest
from kosong.chat_provider.mock import MockChatProvider
from kosong.tooling.empty import EmptyToolset
from pydantic import SecretStr

from kaos import current_kaos
from kaos.local import LocalKaos
from kaos.path import KaosPath
from kimi_cli.config import Config, MoonshotSearchConfig, get_default_config
from kimi_cli.llm import LLM
from kimi_cli.session import Session
from kimi_cli.soul.agent import Agent, BuiltinSystemPromptArgs, LaborMarket, Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.tools.dmail import SendDMail
from kimi_cli.tools.file.glob import Glob
from kimi_cli.tools.file.grep_local import Grep
from kimi_cli.tools.file.read import ReadFile
from kimi_cli.tools.file.replace import StrReplaceFile
from kimi_cli.tools.file.write import WriteFile
from kimi_cli.tools.multiagent.create import CreateSubagent
from kimi_cli.tools.multiagent.task import Task
from kimi_cli.tools.shell import Shell
from kimi_cli.tools.think import Think
from kimi_cli.tools.todo import SetTodoList
from kimi_cli.tools.web.fetch import FetchURL
from kimi_cli.tools.web.search import SearchWeb


@pytest.fixture
def config() -> Config:
    """Create a Config instance."""
    conf = get_default_config()
    conf.services.moonshot_search = MoonshotSearchConfig(
        base_url="https://api.kimi.com/coding/v1/search",
        api_key=SecretStr("test-api-key"),
    )
    return conf


@pytest.fixture
def llm() -> LLM:
    """Create a LLM instance."""
    return LLM(
        chat_provider=MockChatProvider([]),
        max_context_size=100_000,
        capabilities=set(),
    )


@pytest.fixture
def temp_work_dir() -> Generator[KaosPath]:
    """Create a temporary working directory for tests."""
    token = current_kaos.set(LocalKaos())
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            yield KaosPath.unsafe_from_local_path(Path(tmpdir))
    finally:
        current_kaos.reset(token)


@pytest.fixture
def temp_share_dir() -> Generator[Path]:
    """Create a temporary shared directory for tests."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def builtin_args(temp_work_dir: KaosPath) -> BuiltinSystemPromptArgs:
    """Create builtin arguments with temporary work directory."""
    return BuiltinSystemPromptArgs(
        KIMI_NOW="1970-01-01T00:00:00+00:00",
        KIMI_WORK_DIR=temp_work_dir,
        KIMI_WORK_DIR_LS="Test ls content",
        KIMI_AGENTS_MD="Test agents content",
    )


@pytest.fixture
def denwa_renji() -> DenwaRenji:
    """Create a DenwaRenji instance."""
    return DenwaRenji()


@pytest.fixture
def session(temp_work_dir: KaosPath, temp_share_dir: Path) -> Session:
    """Create a Session instance."""
    return Session(
        id="test",
        work_dir=temp_work_dir,
        context_file=temp_share_dir / "history.jsonl",
    )


@pytest.fixture
def approval() -> Approval:
    """Create a Approval instance."""
    return Approval(yolo=True)


@pytest.fixture
def labor_market() -> LaborMarket:
    """Create a LaborMarket instance."""
    return LaborMarket()


@pytest.fixture
def runtime(
    config: Config,
    llm: LLM,
    builtin_args: BuiltinSystemPromptArgs,
    denwa_renji: DenwaRenji,
    session: Session,
    approval: Approval,
    labor_market: LaborMarket,
) -> Runtime:
    """Create a Runtime instance."""
    rt = Runtime(
        config=config,
        llm=llm,
        builtin_args=builtin_args,
        denwa_renji=denwa_renji,
        session=session,
        approval=approval,
        labor_market=labor_market,
    )
    rt.labor_market.add_fixed_subagent(
        "mocker",
        Agent(
            name="Mocker",
            system_prompt="You are a mock agent for testing.",
            toolset=EmptyToolset(),
            runtime=rt.copy_for_fixed_subagent(),
        ),
        "The mock agent for testing purposes.",
    )
    return rt


@pytest.fixture
def toolset() -> KimiToolset:
    return KimiToolset()


@contextmanager
def tool_call_context(tool_name: str) -> Generator[None]:
    """Create a tool call context."""
    from kosong.message import ToolCall

    from kimi_cli.soul.toolset import current_tool_call

    token = current_tool_call.set(
        ToolCall(id="test", function=ToolCall.FunctionBody(name=tool_name, arguments=None))
    )
    try:
        yield
    finally:
        current_tool_call.reset(token)


@pytest.fixture
def task_tool(runtime: Runtime) -> Task:
    """Create a Task tool instance."""
    return Task(runtime)


@pytest.fixture
def create_subagent_tool(toolset: KimiToolset, runtime: Runtime) -> CreateSubagent:
    """Create a CreateSubagent tool instance."""
    return CreateSubagent(toolset, runtime)


@pytest.fixture
def send_dmail_tool(denwa_renji: DenwaRenji) -> SendDMail:
    """Create a SendDMail tool instance."""
    return SendDMail(denwa_renji)


@pytest.fixture
def think_tool() -> Think:
    """Create a Think tool instance."""
    return Think()


@pytest.fixture
def set_todo_list_tool() -> SetTodoList:
    """Create a SetTodoList tool instance."""
    return SetTodoList()


@pytest.fixture
def shell_tool(approval: Approval) -> Generator[Shell]:
    """Create a Shell tool instance."""
    with tool_call_context("Shell"):
        yield Shell(approval)


@pytest.fixture
def read_file_tool(builtin_args: BuiltinSystemPromptArgs) -> ReadFile:
    """Create a ReadFile tool instance."""
    return ReadFile(builtin_args)


@pytest.fixture
def glob_tool(builtin_args: BuiltinSystemPromptArgs) -> Glob:
    """Create a Glob tool instance."""
    return Glob(builtin_args)


@pytest.fixture
def grep_tool() -> Grep:
    """Create a Grep tool instance."""
    return Grep()


@pytest.fixture
def write_file_tool(
    builtin_args: BuiltinSystemPromptArgs, approval: Approval
) -> Generator[WriteFile]:
    """Create a WriteFile tool instance."""
    with tool_call_context("WriteFile"):
        yield WriteFile(builtin_args, approval)


@pytest.fixture
def str_replace_file_tool(
    builtin_args: BuiltinSystemPromptArgs, approval: Approval
) -> Generator[StrReplaceFile]:
    """Create a StrReplaceFile tool instance."""
    with tool_call_context("StrReplaceFile"):
        yield StrReplaceFile(builtin_args, approval)


@pytest.fixture
def search_web_tool(config: Config) -> SearchWeb:
    """Create a SearchWeb tool instance."""
    return SearchWeb(config)


@pytest.fixture
def fetch_url_tool(config: Config) -> FetchURL:
    """Create a FetchURL tool instance."""
    return FetchURL(config)


# misc fixtures


@pytest.fixture
def outside_file() -> Path:
    """Return a path to a file outside the working directory."""
    if platform.system() == "Windows":
        return Path("C:/outside_file.txt")
    else:
        return Path("/outside_file.txt")
