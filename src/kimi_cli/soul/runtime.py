from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from kimi_cli.config import Config
from kimi_cli.llm import LLM
from kimi_cli.session import Session
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.utils.logging import logger
from kimi_cli.utils.path import list_directory


@dataclass(frozen=True, slots=True, kw_only=True)
class BuiltinSystemPromptArgs:
    """Builtin system prompt arguments."""

    KIMI_NOW: str
    """The current datetime."""
    KIMI_WORK_DIR: Path
    """The current working directory."""
    KIMI_WORK_DIR_LS: str
    """The directory listing of current working directory."""
    KIMI_AGENTS_MD: str  # TODO: move to first message from system prompt
    """The content of AGENTS.md."""


def load_agents_md(work_dir: Path) -> str | None:
    paths = [
        work_dir / "AGENTS.md",
        work_dir / "agents.md",
    ]
    for path in paths:
        if path.is_file():
            logger.info("Loaded agents.md: {path}", path=path)
            return path.read_text(encoding="utf-8").strip()
    logger.info("No AGENTS.md found in {work_dir}", work_dir=work_dir)
    return None


@dataclass(frozen=True, slots=True, kw_only=True)
class Runtime:
    """Agent runtime."""

    config: Config
    llm: LLM | None
    session: Session
    builtin_args: BuiltinSystemPromptArgs
    denwa_renji: DenwaRenji
    approval: Approval

    @staticmethod
    async def create(
        config: Config,
        llm: LLM | None,
        session: Session,
        yolo: bool,
    ) -> Runtime:
        ls_output, agents_md = await asyncio.gather(
            asyncio.to_thread(list_directory, session.work_dir),
            asyncio.to_thread(load_agents_md, session.work_dir),
        )

        return Runtime(
            config=config,
            llm=llm,
            session=session,
            builtin_args=BuiltinSystemPromptArgs(
                KIMI_NOW=datetime.now().astimezone().isoformat(),
                KIMI_WORK_DIR=session.work_dir,
                KIMI_WORK_DIR_LS=ls_output,
                KIMI_AGENTS_MD=agents_md or "",
            ),
            denwa_renji=DenwaRenji(),
            approval=Approval(yolo=yolo),
        )
