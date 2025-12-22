"""Context integration for injecting skills into the agent loop."""

from __future__ import annotations

from .models import Skill, SkillMetadata


def generate_skills_system_prompt(skills: list[SkillMetadata]) -> str:
    """Generate system prompt section for available skills.

    This is injected into the agent's system prompt at startup to make
    it aware of available skills without loading full instructions.

    Args:
        skills: List of discovered skill metadata

    Returns:
        Formatted string for system prompt injection
    """
    if not skills:
        return ""

    lines = [
        "## Skills System",
        "",
        "IMPORTANT: You have specialized skills available. Before starting any task,",
        "check if a relevant skill exists and activate it FIRST using `ActivateSkill`.",
        "Skills contain expert-level instructions that significantly improve your output.",
        "",
        "### Available Skills:",
        "",
    ]

    for skill in sorted(skills, key=lambda s: s.name):
        skill_line = f"- **{skill.name}**: {skill.description}"
        if skill.triggers:
            triggers_str = ", ".join(skill.triggers[:5])  # Limit to 5 triggers
            skill_line += f" [Triggers: {triggers_str}]"
        lines.append(skill_line)

    lines.extend(
        [
            "",
            "### Skill Activation Protocol:",
            "1. When you receive a task, IMMEDIATELY check if any skill matches the request",
            '2. Call `ActivateSkill(skill_name="<name>")` to load the skill\'s instructions',
            "3. Follow the loaded instructions to complete the task with expert guidance",
            "",
            "DO NOT skip skill activation - the detailed instructions contain critical",
            "checklists, review criteria, and output formats that improve quality.",
        ]
    )

    return "\n".join(lines)


def format_activated_skill(skill: Skill) -> str:
    """Format an activated skill's instructions for context injection.

    Args:
        skill: The fully loaded skill

    Returns:
        Formatted instructions for context injection
    """
    lines = [
        f"## Activated Skill: {skill.name}",
        "",
        skill.instructions,
        "",
        "---",
        "*Follow the instructions above to complete the user's request.*",
        f"*You may access files in the skill directory at: {skill.metadata.path}*",
    ]
    return "\n".join(lines)


def generate_skill_activation_message(skill_name: str, user_request: str | None = None) -> str:
    """Generate a message for when a skill is activated.

    Args:
        skill_name: Name of the activated skill
        user_request: The original user request (optional)

    Returns:
        Formatted message text
    """
    lines = [
        f"Skill **{skill_name}** has been activated.",
        "",
        "The skill instructions have been loaded. Please follow them to complete the task.",
    ]

    if user_request:
        lines.insert(1, f"**Your request**: {user_request}")

    return "\n".join(lines)


def format_skills_list(skills: list[SkillMetadata]) -> str:
    """Format a list of skills for display.

    Args:
        skills: List of skill metadata

    Returns:
        Formatted string showing all skills
    """
    if not skills:
        return "No skills found. Add skills to ~/.kimi/skills/ or ./.kimi/skills/"

    lines = ["**Available Skills:**", ""]
    for skill in sorted(skills, key=lambda s: s.name):
        lines.append(f"- **{skill.name}**")
        lines.append(f"  {skill.description}")
        lines.append("")

    return "\n".join(lines)


def format_skill_info(skill: Skill) -> str:
    """Format detailed skill information for display.

    Args:
        skill: The fully loaded skill

    Returns:
        Formatted string with skill details
    """
    lines = [
        f"**Skill:** {skill.name}",
        f"**Description:** {skill.description}",
        f"**Path:** {skill.metadata.path}",
    ]

    if skill.metadata.license:
        lines.append(f"**License:** {skill.metadata.license}")

    if skill.metadata.metadata:
        lines.append("**Metadata:**")
        for key, value in skill.metadata.metadata.items():
            lines.append(f"  - {key}: {value}")

    lines.extend(["", "---", "**Instructions:**", "", skill.instructions])

    return "\n".join(lines)
