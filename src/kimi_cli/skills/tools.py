"""Tool implementations for the skills system."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, override

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field

from .context import format_activated_skill, format_skill_info, format_skills_list
from .validator import validate_skill

if TYPE_CHECKING:
    from .loader import SkillsLoader


class ActivateSkillParams(BaseModel):
    """Parameters for the ActivateSkill tool."""

    skill_name: str = Field(description="The name of the skill to activate")


class ActivateSkill(CallableTool2[ActivateSkillParams]):
    """Tool for explicitly activating a skill by name.

    When activated, the skill's full instructions are loaded and returned
    to the agent for following.
    """

    name: str = "ActivateSkill"
    description: str = (
        "IMPORTANT: Activate a skill BEFORE starting a task to load expert instructions. "
        "Skills contain checklists, review criteria, and output formats that significantly "
        "improve the quality of your work. Always check available skills and activate "
        "the relevant one first."
    )
    params: type[ActivateSkillParams] = ActivateSkillParams

    def __init__(self, skills_loader: SkillsLoader):
        super().__init__()
        self._skills_loader = skills_loader

    @property
    def skills_loader(self) -> SkillsLoader:
        """Get the skills loader instance."""
        return self._skills_loader

    @override
    async def __call__(self, params: ActivateSkillParams) -> ToolReturnValue:
        """Execute the skill activation."""
        skill = self._skills_loader.load_full_skill(params.skill_name)

        if skill is None:
            available = [s.name for s in self._skills_loader.list_skills()]
            if available:
                available_str = ", ".join(sorted(available))
                msg = f"Skill '{params.skill_name}' not found. Available: {available_str}"
            else:
                msg = f"Skill '{params.skill_name}' not found. No skills available."
            return ToolError(
                message=msg,
                brief=f"Not found: {params.skill_name}",
            )

        # Format the activated skill instructions
        instructions = format_activated_skill(skill)

        return ToolOk(
            output=instructions,
            message=f"Skill '{skill.name}' activated. Follow the instructions above.",
            brief=f"Activated: {skill.name}",
        )


class ListSkillsParams(BaseModel):
    """Parameters for the ListSkills tool.

    Empty because this tool takes no parameters. Required by CallableTool2 framework.
    """

    pass


class ListSkills(CallableTool2[ListSkillsParams]):
    """Tool for listing all available skills.

    Returns a formatted list of all discovered skills with their descriptions.
    """

    name: str = "ListSkills"
    description: str = (
        "List all available skills and their descriptions. "
        "Use this to discover what skills are available to help with tasks."
    )
    params: type[ListSkillsParams] = ListSkillsParams

    def __init__(self, skills_loader: SkillsLoader):
        super().__init__()
        self._skills_loader = skills_loader

    @override
    async def __call__(self, params: ListSkillsParams) -> ToolReturnValue:
        """List all available skills."""
        skills = self._skills_loader.list_skills()
        output = format_skills_list(skills)

        if not skills:
            return ToolOk(
                output=output,
                message="No skills available.",
                brief="No skills found",
            )

        return ToolOk(
            output=output,
            message=f"Found {len(skills)} available skill(s).",
            brief=f"{len(skills)} skills",
        )


class SkillInfoParams(BaseModel):
    """Parameters for the SkillInfo tool."""

    skill_name: str = Field(description="The name of the skill to get info about")


class SkillInfo(CallableTool2[SkillInfoParams]):
    """Tool for getting detailed information about a skill.

    Returns the full skill metadata and instructions without activating it.
    """

    name: str = "SkillInfo"
    description: str = (
        "Get detailed information about a specific skill, including its "
        "full instructions, metadata, and path. Use this to preview a skill "
        "before deciding to activate it."
    )
    params: type[SkillInfoParams] = SkillInfoParams

    def __init__(self, skills_loader: SkillsLoader):
        super().__init__()
        self._skills_loader = skills_loader

    @override
    async def __call__(self, params: SkillInfoParams) -> ToolReturnValue:
        """Get detailed skill information."""
        skill = self._skills_loader.load_full_skill(params.skill_name)

        if skill is None:
            return ToolError(
                message=f"Skill '{params.skill_name}' not found.",
                brief=f"Not found: {params.skill_name}",
            )

        output = format_skill_info(skill)

        return ToolOk(
            output=output,
            message=f"Information for skill '{skill.name}'.",
            brief=f"Info: {skill.name}",
        )


class ValidateSkillParams(BaseModel):
    """Parameters for the ValidateSkill tool."""

    path: str = Field(description="Path to the skill directory to validate")


class ValidateSkill(CallableTool2[ValidateSkillParams]):
    """Tool for validating a skill directory.

    Checks that a skill directory has valid structure and content.
    """

    name: str = "ValidateSkill"
    description: str = (
        "Validate a skill directory to check that it has the correct structure "
        "and content. Returns a list of any validation errors found."
    )
    params: type[ValidateSkillParams] = ValidateSkillParams

    @override
    async def __call__(self, params: ValidateSkillParams) -> ToolReturnValue:
        """Validate a skill directory."""
        skill_path = Path(params.path)
        errors = validate_skill(skill_path)

        if errors:
            error_list = "\n".join(f"- {e}" for e in errors)
            return ToolError(
                output=error_list,
                message=f"Validation failed for {skill_path}",
                brief=f"Invalid: {len(errors)} errors",
            )

        return ToolOk(
            output="",
            message=f"Skill at {skill_path} is valid.",
            brief=f"Valid: {skill_path.name}",
        )
