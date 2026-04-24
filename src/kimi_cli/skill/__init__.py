"""Skill specification discovery and loading utilities."""

from __future__ import annotations

import sys
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

from kaos import get_current_kaos
from kaos.local import local_kaos
from kaos.path import KaosPath
from pydantic import BaseModel, ConfigDict, Field

from kimi_cli import logger
from kimi_cli.skill.flow import Flow, FlowError
from kimi_cli.skill.flow.d2 import parse_d2_flowchart
from kimi_cli.skill.flow.mermaid import parse_mermaid_flowchart
from kimi_cli.utils.frontmatter import parse_frontmatter

SkillType = Literal["standard", "flow"]

SkillScope = Literal["builtin", "user", "project", "extra"]
"""Where a skill was discovered from.

- ``builtin``: bundled with kimi-cli
- ``user``: from the user's home (``~/.kimi/skills``, ``~/.agents/skills``, ...)
- ``project``: from the current project's working directory
  (``<work_dir>/.kimi/skills``, ``<work_dir>/.agents/skills``, ...)
- ``extra``: from ``extra_skill_dirs`` config or ``--skills-dir`` override
"""


@dataclass(frozen=True, slots=True)
class ScopedSkillsRoot:
    """A skills directory paired with the scope it belongs to."""

    root: KaosPath
    scope: SkillScope


def get_builtin_skills_dir() -> Path:
    """
    Get the built-in skills directory path.
    """
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        # Running in a PyInstaller bundle; use _MEIPASS to locate bundled resources
        # reliably on all platforms (avoids __file__ path issues in frozen envs on Windows)
        meipass = cast(str, sys._MEIPASS)  # pyright: ignore[reportAttributeAccessIssue,reportUnknownMemberType]
        return Path(meipass) / "kimi_cli" / "skills"
    return Path(__file__).parent.parent / "skills"


def _get_user_generic_skills_dir_candidates() -> tuple[KaosPath, ...]:
    """
    Get user-level generic skills directory candidates in priority order.

    Generic group: ``~/.config/agents/skills`` > ``~/.agents/skills``
    """
    return (
        KaosPath.home() / ".config" / "agents" / "skills",
        KaosPath.home() / ".agents" / "skills",
    )


def _get_user_brand_skills_dir_candidates() -> tuple[KaosPath, ...]:
    """
    Get user-level brand skills directory candidates in priority order.

    Brand group: ``~/.kimi/skills`` > ``~/.claude/skills`` > ``~/.codex/skills``
    """
    return (
        KaosPath.home() / ".kimi" / "skills",
        KaosPath.home() / ".claude" / "skills",
        KaosPath.home() / ".codex" / "skills",
    )


def _get_project_generic_skills_dir_candidates(work_dir: KaosPath) -> tuple[KaosPath, ...]:
    """
    Get project-level generic skills directory candidates.

    Generic group: ``.agents/skills``
    """
    return (work_dir / ".agents" / "skills",)


def _get_project_brand_skills_dir_candidates(work_dir: KaosPath) -> tuple[KaosPath, ...]:
    """
    Get project-level brand skills directory candidates in priority order.

    Brand group: ``.kimi/skills`` > ``.claude/skills`` > ``.codex/skills``
    """
    return (
        work_dir / ".kimi" / "skills",
        work_dir / ".claude" / "skills",
        work_dir / ".codex" / "skills",
    )


def _supports_builtin_skills() -> bool:
    """Return True when the active KAOS backend can read bundled skills."""
    current_name = get_current_kaos().name
    return current_name in (local_kaos.name, "acp")


async def find_first_existing_dir(candidates: Iterable[KaosPath]) -> KaosPath | None:
    """
    Return the first existing directory from candidates.
    """
    for candidate in candidates:
        if await candidate.is_dir():
            return candidate
    return None


async def find_user_skills_dirs(
    *,
    merge_brands: bool = False,
) -> list[KaosPath]:
    """
    Return user-level skills directories from both brand and generic groups.

    The brand group comes first because brand-specific directories have
    higher specificity.  When *merge_brands* is ``False`` (default), only the
    first existing brand directory is used.  When ``True``, all existing brand
    directories are included (priority order: kimi > claude > codex).
    """
    dirs: list[KaosPath] = []
    if merge_brands:
        for candidate in _get_user_brand_skills_dir_candidates():
            if await candidate.is_dir():
                dirs.append(candidate)
    else:
        if brand := await find_first_existing_dir(
            _get_user_brand_skills_dir_candidates(),
        ):
            dirs.append(brand)
    if generic := await find_first_existing_dir(
        _get_user_generic_skills_dir_candidates(),
    ):
        dirs.append(generic)
    return dirs


async def find_project_skills_dirs(
    work_dir: KaosPath,
    *,
    merge_brands: bool = False,
) -> list[KaosPath]:
    """
    Return project-level skills directories from both brand and generic groups.

    Discovery starts at the **project root** (the nearest ``.git`` ancestor
    of ``work_dir``), so launching kimi-cli from a subdirectory — for example
    a monorepo package — still surfaces skills defined at the repository root.
    Falls back to ``work_dir`` itself when no ``.git`` marker is found, to
    avoid accidentally walking up into unrelated parent trees.

    The brand group comes first because brand-specific directories have
    higher specificity.  When *merge_brands* is ``False`` (default), only the
    first existing brand directory is used.  When ``True``, all existing brand
    directories are included (priority order: kimi > claude > codex).
    """
    from kimi_cli.utils.path import find_project_root

    work_dir = await find_project_root(work_dir)
    dirs: list[KaosPath] = []
    brand_candidates = _get_project_brand_skills_dir_candidates(work_dir)
    if merge_brands:
        for candidate in brand_candidates:
            if await candidate.is_dir():
                dirs.append(candidate)
    else:
        if brand := await find_first_existing_dir(brand_candidates):
            dirs.append(brand)
    generic_candidates = _get_project_generic_skills_dir_candidates(work_dir)
    if generic := await find_first_existing_dir(generic_candidates):
        dirs.append(generic)
    return dirs


async def resolve_skills_roots(
    work_dir: KaosPath,
    *,
    skills_dirs: Sequence[KaosPath] | None = None,
    merge_brands: bool = False,
    extra_skill_dirs: Sequence[str] | None = None,
) -> list[ScopedSkillsRoot]:
    """Resolve layered skill roots with their scope labels.

    Scope labels let the system-prompt renderer group skills so the model can
    tell a user-scope skill from a project-scope one. Roots are ordered
    **highest priority first** — ``discover_skills_from_roots`` keeps the first
    match per skill name, so this ordering controls which scope "wins" when the
    same skill name exists in several places:

        Project > User > Extra(config) > Extra(plugins) > Built-in

    ``extra_skill_dirs`` is **additive** (not an override) and scoped as
    ``extra``; each entry may be:

    - An absolute path (used as-is)
    - ``~/...`` (expanded against ``$HOME``)
    - A relative path (resolved against the **project root** — the nearest
      ``.git`` directory above ``work_dir``, or ``work_dir`` itself if none)

    Non-existent entries are silently dropped. Duplicates collapse to one.
    """
    from kimi_cli.plugin.manager import get_plugins_dir
    from kimi_cli.utils.path import find_project_root

    scoped: list[ScopedSkillsRoot] = []
    seen: set[str] = set()

    def _append(root: KaosPath, scope: SkillScope) -> None:
        # Dedupe so symlinks, ``..`` segments, and trailing slashes don't
        # produce phantom duplicate entries in the system prompt. Note that
        # ``KaosPath.canonical()`` only normalizes path segments; it does NOT
        # resolve symlinks. So on local backends we walk symlinks via
        # ``pathlib.Path.resolve()`` first, then fall through to
        # ``canonical()`` for ``..`` / trailing-slash normalization. Non-local
        # backends keep the canonical-only path because ``Path.resolve()``
        # would walk the wrong filesystem.
        resolved = root
        if get_current_kaos().name == local_kaos.name:
            try:
                local_resolved = Path(str(root)).resolve()
            except OSError:
                # Keep the original path; canonical() below still does what it can.
                pass
            else:
                resolved = KaosPath.unsafe_from_local_path(local_resolved)
        try:
            canon = resolved.canonical()
        except OSError:
            canon = resolved
        key = str(canon)
        if key in seen:
            return
        seen.add(key)
        scoped.append(ScopedSkillsRoot(root=canon, scope=scope))

    if skills_dirs:
        # --skills-dir overrides user/project auto-discovery, but runs at the
        # top of priority order so its skills take precedence, matching the
        # "closer to the user's explicit intent, higher priority" principle.
        for d in skills_dirs:
            _append(d, "extra")
    else:
        for d in await find_project_skills_dirs(work_dir, merge_brands=merge_brands):
            _append(d, "project")
        for d in await find_user_skills_dirs(merge_brands=merge_brands):
            _append(d, "user")

    if extra_skill_dirs:
        project_root = await find_project_root(work_dir)
        for raw in extra_skill_dirs:
            resolved = _resolve_extra_skill_dir(raw, project_root)
            if resolved is None:
                continue
            try:
                is_dir = await resolved.is_dir()
            except OSError as exc:
                logger.info(
                    "Skipping extra_skill_dirs entry {path}: {error}",
                    path=resolved,
                    error=exc,
                )
                continue
            if not is_dir:
                continue
            _append(resolved, "extra")

    # Plugins are always discoverable; treat as "extra" origin for prompt
    # grouping but place them below config-declared extras (user intent wins).
    plugins_path = get_plugins_dir()
    try:
        plugins_is_dir = plugins_path.is_dir()
    except OSError:
        plugins_is_dir = False
    if plugins_is_dir:
        _append(KaosPath.unsafe_from_local_path(plugins_path), "extra")

    if _supports_builtin_skills():
        _append(
            KaosPath.unsafe_from_local_path(get_builtin_skills_dir()),
            "builtin",
        )
    return scoped


def _resolve_extra_skill_dir(raw: str, project_root: KaosPath) -> KaosPath | None:
    """Resolve a single ``extra_skill_dirs`` entry to a KaosPath, or None on error.

    Expands ``~``; treats non-absolute entries as relative to *project_root*.
    """
    if not raw:
        return None
    try:
        p = Path(raw).expanduser()
    except (RuntimeError, OSError):
        # ``expanduser`` can raise on malformed HOME or platform-specific
        # oddities; treat any failure as a dropped entry rather than let it
        # kill skill discovery.
        return None
    if p.is_absolute():
        return KaosPath.unsafe_from_local_path(p)
    return KaosPath.unsafe_from_local_path(Path(str(project_root)) / p)


def normalize_skill_name(name: str) -> str:
    """Normalize a skill name for lookup."""
    return name.casefold()


def index_skills(skills: Iterable[Skill]) -> dict[str, Skill]:
    """Build a lookup table for skills by normalized name."""
    return {normalize_skill_name(skill.name): skill for skill in skills}


async def discover_skills_from_roots(
    scoped_roots: Iterable[ScopedSkillsRoot],
) -> list[Skill]:
    """Discover skills from scope-labelled roots.

    When the same skill name appears in multiple roots, the **first occurrence
    wins** (higher priority roots come first in :func:`resolve_skills_roots`'s
    output). Each returned :class:`Skill` carries the scope of the root it came
    from.
    """
    skills_by_name: dict[str, Skill] = {}
    for scoped in scoped_roots:
        for skill in await discover_skills(scoped.root, scope=scoped.scope):
            skills_by_name.setdefault(normalize_skill_name(skill.name), skill)
    return sorted(skills_by_name.values(), key=lambda s: s.name)


_SCOPE_HEADINGS: tuple[tuple[SkillScope, str], ...] = (
    ("project", "Project"),
    ("user", "User"),
    ("extra", "Extra"),
    ("builtin", "Built-in"),
)
"""Scope headings for the system-prompt skills block, in the order they appear.

Project first (most specific), then User, Extra, and finally Built-in (least
specific). Matches the priority the model should give when multiple scopes
define a skill with the same name.
"""


def format_skills_for_prompt(skills: Iterable[Skill]) -> str:
    """Render *skills* grouped by scope for injection into the system prompt.

    Output layout::

        ### Project
        - <name>
          - Path: <skill_md_file>
          - Description: <description>

        ### User
        - ...

    Empty scope groups are omitted. The model uses these headings to distinguish
    user-scope and project-scope skills when responding to prompts like
    "the skill in my project".
    """
    grouped: dict[SkillScope, list[Skill]] = {s: [] for s, _ in _SCOPE_HEADINGS}
    for skill in skills:
        grouped.setdefault(skill.scope, []).append(skill)

    sections: list[str] = []
    for scope, heading in _SCOPE_HEADINGS:
        bucket = grouped.get(scope) or []
        if not bucket:
            continue
        lines = [f"### {heading}"]
        for skill in sorted(bucket, key=lambda s: s.name):
            lines.append(f"- {skill.name}")
            lines.append(f"  - Path: {skill.skill_md_file}")
            lines.append(f"  - Description: {skill.description}")
        sections.append("\n".join(lines))

    if not sections:
        return "No skills found."
    return "\n\n".join(sections)


async def read_skill_text(skill: Skill) -> str | None:
    """Read the SKILL.md contents for a skill."""
    try:
        return (await skill.skill_md_file.read_text(encoding="utf-8")).strip()
    except OSError as exc:
        logger.warning(
            "Failed to read skill file {path}: {error}",
            path=skill.skill_md_file,
            error=exc,
        )
        return None


class Skill(BaseModel):
    """Information about a single skill."""

    model_config = ConfigDict(extra="ignore", arbitrary_types_allowed=True)

    name: str
    description: str
    type: SkillType = "standard"
    dir: KaosPath
    """The skill's resource directory. For subdirectory-form skills this is the
    per-skill directory; for flat ``.md`` skills it is the parent skills root."""
    skill_md_file: KaosPath
    """Path to the markdown file that holds the skill body. For subdirectory
    skills this is ``dir/SKILL.md``; for flat skills this is the ``.md`` file
    itself."""
    flow: Flow | None = None
    scope: SkillScope = Field(...)
    """Which scope this skill was discovered from. Required; discovery always
    stamps it. The system-prompt renderer groups skills by this label so the
    model can tell user-scope from project-scope skills."""


async def discover_skills(
    skills_dir: KaosPath,
    *,
    scope: SkillScope,
) -> list[Skill]:
    """Discover all skills in the given directory.

    Two layouts are supported side by side:

    1. **Subdirectory**: ``<skills_dir>/<name>/SKILL.md`` — the canonical layout.
    2. **Flat**: ``<skills_dir>/<name>.md`` — a single-file skill. Handy for
       users migrating from agent tooling that stores skills as flat markdown
       files.

    When both forms share the same normalized name in one directory, the
    subdirectory form wins and a warning is emitted.

    *scope* is stamped onto each discovered :class:`Skill` so the system-prompt
    renderer can group skills by where they came from (user / project / extra /
    builtin).
    """
    try:
        is_dir = await skills_dir.is_dir()
    except OSError as exc:
        logger.warning(
            "Cannot stat skills directory {path}, skipping: {error}",
            path=skills_dir,
            error=exc,
        )
        return []
    if not is_dir:
        return []

    skills_by_name: dict[str, Skill] = {}

    # Pass 1: subdirectory form (canonical).
    try:
        async for entry in skills_dir.iterdir():
            try:
                if not await entry.is_dir():
                    continue
                skill_md = entry / "SKILL.md"
                if not await skill_md.is_file():
                    continue
                content = await skill_md.read_text(encoding="utf-8")
            except OSError as exc:
                logger.info(
                    "Skipping unreadable skill entry {path}: {error}",
                    path=entry,
                    error=exc,
                )
                continue
            try:
                skill = parse_skill_text(
                    content, dir_path=entry, skill_md_file=skill_md, scope=scope
                )
            except Exception as exc:
                logger.info("Skipping invalid skill at {}: {}", skill_md, exc)
                continue
            skills_by_name[normalize_skill_name(skill.name)] = skill
    except OSError as exc:
        logger.warning(
            "Failed to iterate skills directory {path}: {error}",
            path=skills_dir,
            error=exc,
        )
        return sorted(skills_by_name.values(), key=lambda s: s.name)

    # Pass 2: flat ``.md`` form, skipping names already claimed by a subdir.
    try:
        async for entry in skills_dir.iterdir():
            try:
                if await entry.is_dir():
                    continue
            except OSError as exc:
                logger.info(
                    "Skipping unstattable entry {path}: {error}",
                    path=entry,
                    error=exc,
                )
                continue
            if not entry.name.lower().endswith(".md"):
                continue
            # A bare ``SKILL.md`` at the top of skills_dir is a stray marker file,
            # not a skill — it has no per-skill directory to associate with.
            if entry.name.upper() == "SKILL.MD":
                continue

            try:
                content = await entry.read_text(encoding="utf-8")
                skill = parse_skill_text(
                    content,
                    dir_path=skills_dir,
                    skill_md_file=entry,
                    scope=scope,
                    flat_file=entry,
                )
            except Exception as exc:
                logger.info("Skipping invalid flat skill at {}: {}", entry, exc)
                continue

            key = normalize_skill_name(skill.name)
            if key in skills_by_name:
                logger.warning(
                    "Flat skill {flat} shadowed by subdirectory skill of the same "
                    "name at {sub}; the subdirectory version is used.",
                    flat=entry,
                    sub=skills_by_name[key].dir,
                )
                continue
            skills_by_name[key] = skill
    except OSError as exc:
        logger.warning(
            "Failed to iterate skills directory for flat scan {path}: {error}",
            path=skills_dir,
            error=exc,
        )

    return sorted(skills_by_name.values(), key=lambda s: s.name)


_DESCRIPTION_FALLBACK_MAX_LEN = 240
"""Max length for the body-derived description fallback. Longer first lines are
truncated with an ellipsis. The spec caps ``description`` at 1024 chars, but
for a fallback used when the user forgot to set one, a tighter cap keeps the
system prompt compact.
"""


def parse_skill_text(
    content: str,
    *,
    dir_path: KaosPath,
    skill_md_file: KaosPath,
    scope: SkillScope,
    flat_file: KaosPath | None = None,
) -> Skill:
    """Parse skill markdown content to extract name and description.

    *flat_file* is passed only to compute the default ``name`` from the filename
    stem when there is no frontmatter ``name``. *skill_md_file* points at the
    actual markdown file (``dir_path/SKILL.md`` for subdir skills, the ``.md``
    itself for flat ones) and is stamped onto the returned :class:`Skill`.

    The ``description`` resolution applies the same three-step chain regardless
    of form: frontmatter ``description`` → first non-empty body line →
    ``"No description provided."``.
    """
    frontmatter = parse_frontmatter(content) or {}

    default_name = _strip_md_suffix(flat_file.name) if flat_file is not None else dir_path.name
    name = frontmatter.get("name") or default_name

    description = frontmatter.get("description")
    if not description:
        body_fallback = _first_meaningful_line(content)
        description = _truncate(body_fallback) if body_fallback else "No description provided."

    skill_type = frontmatter.get("type") or "standard"
    if skill_type not in ("standard", "flow"):
        raise ValueError(f'Invalid skill type "{skill_type}"')
    flow = None
    if skill_type == "flow":
        try:
            flow = _parse_flow_from_skill(content)
        except ValueError as exc:
            logger.error("Failed to parse flow skill {name}: {error}", name=name, error=exc)
            skill_type = "standard"
            flow = None

    return Skill(
        name=name,
        description=description,
        type=skill_type,
        dir=dir_path,
        skill_md_file=skill_md_file,
        flow=flow,
        scope=scope,
    )


def _strip_md_suffix(filename: str) -> str:
    """Return *filename* without a trailing ``.md`` (case-insensitive)."""
    if filename.lower().endswith(".md"):
        return filename[: -len(".md")]
    return filename


def _truncate(text: str, limit: int = _DESCRIPTION_FALLBACK_MAX_LEN) -> str:
    """Clip *text* to *limit* chars, appending an ellipsis if truncated."""
    text = text.strip()
    if len(text) <= limit:
        return text
    # Reserve one char for the ellipsis
    return text[: limit - 1].rstrip() + "…"


def _first_meaningful_line(content: str) -> str | None:
    """Return the first non-empty line of *content*'s body, or None.

    Uses :func:`strip_frontmatter` to drop any leading YAML block, so the
    frontmatter-skipping logic lives in one place (see
    :mod:`kimi_cli.utils.frontmatter`). A malformed frontmatter opener that
    never closes leaves ``strip_frontmatter`` a no-op; skip standalone
    ``---`` delimiter lines here so the stray opener does not silently
    become the fallback description.
    """
    from kimi_cli.utils.frontmatter import strip_frontmatter

    body = strip_frontmatter(content)
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped == "---":
            continue
        return stripped
    return None


def _parse_flow_from_skill(content: str) -> Flow:
    for lang, code in _iter_fenced_codeblocks(content):
        if lang == "mermaid":
            return _parse_flow_block(parse_mermaid_flowchart, code)
        if lang == "d2":
            return _parse_flow_block(parse_d2_flowchart, code)
    raise ValueError("Flow skills require a mermaid or d2 code block in SKILL.md.")


def _parse_flow_block(parser: Callable[[str], Flow], code: str) -> Flow:
    try:
        return parser(code)
    except FlowError as exc:
        raise ValueError(f"Invalid flow diagram: {exc}") from exc


def _iter_fenced_codeblocks(content: str) -> Iterator[tuple[str, str]]:
    fence = ""
    fence_char = ""
    lang = ""
    buf: list[str] = []
    in_block = False

    for line in content.splitlines():
        stripped = line.lstrip()
        if not in_block:
            if match := _parse_fence_open(stripped):
                fence, fence_char, info = match
                lang = _normalize_code_lang(info)
                in_block = True
                buf = []
            continue

        if _is_fence_close(stripped, fence_char, len(fence)):
            yield lang, "\n".join(buf).strip("\n")
            in_block = False
            fence = ""
            fence_char = ""
            lang = ""
            buf = []
            continue

        buf.append(line)


def _normalize_code_lang(info: str) -> str:
    if not info:
        return ""
    lang = info.split()[0].strip().lower()
    if lang.startswith("{") and lang.endswith("}"):
        lang = lang[1:-1].strip()
    return lang


def _parse_fence_open(line: str) -> tuple[str, str, str] | None:
    if not line or line[0] not in ("`", "~"):
        return None
    fence_char = line[0]
    count = 0
    for ch in line:
        if ch == fence_char:
            count += 1
        else:
            break
    if count < 3:
        return None
    fence = fence_char * count
    info = line[count:].strip()
    return fence, fence_char, info


def _is_fence_close(line: str, fence_char: str, fence_len: int) -> bool:
    if not fence_char or not line or line[0] != fence_char:
        return False
    count = 0
    for ch in line:
        if ch == fence_char:
            count += 1
        else:
            break
    if count < fence_len:
        return False
    return not line[count:].strip()
