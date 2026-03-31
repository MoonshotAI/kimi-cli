from typing import Literal

from pydantic import BaseModel, Field, model_validator

HookEventType = Literal[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "SessionStart",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Notification",
]

HOOK_EVENT_TYPES: list[str] = list(HookEventType.__args__)  # type: ignore[attr-defined]


class HookDef(BaseModel):
    """A single hook definition in config.toml."""

    event: HookEventType
    """Which lifecycle event triggers this hook."""
    command: str = ""
    """Shell command to execute. Receives JSON on stdin."""
    inject_prompt: str = ""
    """Prompt content or file path to inject as additional context."""
    matcher: str = ""
    """Regex pattern to filter. Empty matches everything."""
    timeout: int = Field(default=30, ge=1, le=600)
    """Timeout in seconds. Fail-open on timeout."""

    @model_validator(mode="after")
    def check_command_or_inject(self):
        if self.command and self.inject_prompt:
            raise ValueError("hook cannot have both 'command' and 'inject_prompt'")
        if not self.command and not self.inject_prompt:
            raise ValueError("hook must have either 'command' or 'inject_prompt'")
        return self
