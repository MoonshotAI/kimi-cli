"""Tests for the minimal bare-invocation plugin router."""

from __future__ import annotations

from kaos.path import KaosPath

from kimi_cli.claude_plugin.router import (
    PluginCapabilityIndex,
    _is_bare_invocation,
    _normalize,
    build_plugin_capability_index,
)
from kimi_cli.claude_plugin.spec import ClaudeCommandSpec
from kimi_cli.skill import Skill
from kimi_cli.skill.flow import Flow

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _skill(
    name: str,
    *,
    is_plugin: bool = True,
    skill_type: str = "standard",
    flow: Flow | None = None,
) -> Skill:
    return Skill(
        name=name,
        description=f"{name} skill",
        type=skill_type,  # type: ignore[arg-type]
        dir=KaosPath("/tmp/fake"),
        is_plugin=is_plugin,
        flow=flow,
    )


def _command(full_name: str) -> ClaudeCommandSpec:
    parts = full_name.split(":", 1)
    return ClaudeCommandSpec(
        name=parts[1] if len(parts) > 1 else parts[0],
        full_name=full_name,
        description=f"{full_name} command",
        body="Do $ARGUMENTS",
        frontmatter={"description": "test"},
    )


def _idx(*skill_names: str) -> PluginCapabilityIndex:
    skills = {n: _skill(n) for n in skill_names}
    return build_plugin_capability_index(skills)


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


class TestNormalize:
    def test_hyphens_to_space(self) -> None:
        assert _normalize("webnovel-init") == "webnovel init"

    def test_underscores_to_space(self) -> None:
        assert _normalize("webnovel_init") == "webnovel init"

    def test_lowercase(self) -> None:
        assert _normalize("WebNovel-Init") == "webnovel init"

    def test_namespace_colon_preserved(self) -> None:
        assert _normalize("plugin:webnovel-init") == "plugin:webnovel init"


# ---------------------------------------------------------------------------
# Bare invocation detection
# ---------------------------------------------------------------------------


class TestBareInvocation:
    def test_exact_match(self) -> None:
        assert _is_bare_invocation("webnovel init", "webnovel init") is True

    def test_with_请(self) -> None:
        assert _is_bare_invocation("请 webnovel init", "webnovel init") is True

    def test_with_功能(self) -> None:
        assert _is_bare_invocation("webnovel init 功能", "webnovel init") is True

    def test_with_sentence_after(self) -> None:
        assert _is_bare_invocation("webnovel init is broken", "webnovel init") is False

    def test_with_long_prefix(self) -> None:
        assert _is_bare_invocation("i want to use webnovel init", "webnovel init") is False


# ---------------------------------------------------------------------------
# Index matching (only bare invocations)
# ---------------------------------------------------------------------------


class TestIndexMatch:
    def test_bare_name_dispatches(self) -> None:
        index = _idx("plug:webnovel-init")
        cap = index.match("webnovel init")
        assert cap is not None
        assert cap.name == "plug:webnovel-init"

    def test_bare_name_with_hyphens(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("webnovel-init") is not None

    def test_bare_name_with_underscores(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("webnovel_init") is not None

    def test_full_namespaced_name(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("plug:webnovel-init") is not None

    def test_bare_name_with_filler(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("请 webnovel init") is not None

    def test_empty_input(self) -> None:
        index = _idx("plug:hello")
        assert index.match("") is None

    def test_no_match(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("something else entirely") is None

    def test_command_bare_invocation(self) -> None:
        cmds = {"demo:summarize": _command("demo:summarize")}
        index = build_plugin_capability_index({}, commands=cmds)
        assert index.match("summarize") is not None


# ---------------------------------------------------------------------------
# Goal-oriented / descriptive inputs must NOT match
# ---------------------------------------------------------------------------


class TestGoalOrientedFallsThrough:
    """These should all go to the model via _turn(), not be locally routed."""

    def test_natural_language_goal(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("I want to write a novel") is None

    def test_sentence_with_capability_name(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("run webnovel init please") is None

    def test_question_about_capability(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("what does webnovel init do?") is None

    def test_failure_report(self) -> None:
        index = _idx("plug:webnovel-dashboard")
        assert index.match("webnovel dashboard is broken") is None

    def test_negated_sentence(self) -> None:
        index = _idx("plug:webnovel-dashboard")
        assert index.match("I cannot open webnovel dashboard") is None

    def test_hypothetical(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("what happens if I run webnovel init?") is None

    def test_polite_request(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("can you run webnovel init?") is None

    def test_chinese_goal(self) -> None:
        index = _idx("plug:webnovel-write")
        assert index.match("我想写一篇小说") is None

    def test_chinese_descriptive(self) -> None:
        index = _idx("plug:webnovel-dashboard")
        assert index.match("webnovel dashboard打不开了") is None

    def test_explain_request(self) -> None:
        index = _idx("plug:webnovel-init")
        assert index.match("please explain webnovel init") is None

    def test_diagnostic_question_with_cannot_open_in_english(self) -> None:
        index = _idx("plug:webnovel-dashboard")
        assert index.match("can you tell me why I cannot open webnovel dashboard?") is None

    def test_diagnostic_question_with_cannot_open_in_chinese(self) -> None:
        index = _idx("plug:webnovel-dashboard")
        assert index.match("可以帮我看看为什么打不开webnovel dashboard吗") is None

    def test_diagnostic_question_with_look_into_it_in_chinese(self) -> None:
        index = _idx("plug:webnovel-dashboard")
        assert index.match("帮我看看 webnovel dashboard 为什么打不开") is None


# ---------------------------------------------------------------------------
# Non-plugin skills and ambiguity
# ---------------------------------------------------------------------------


class TestNonPluginAndAmbiguity:
    def test_native_skill_not_indexed(self) -> None:
        skills = {
            "native-helper": _skill("native-helper", is_plugin=False),
            "plug:deploy": _skill("plug:deploy", is_plugin=True),
        }
        index = build_plugin_capability_index(skills)
        assert index.match("native-helper") is None
        assert index.match("deploy") is not None

    def test_ambiguous_bare_name(self) -> None:
        skills = {"a:init": _skill("a:init"), "b:init": _skill("b:init")}
        index = build_plugin_capability_index(skills)
        assert index.match("init") is None
        assert index.match("a:init") is not None
        assert index.match("b:init") is not None

    def test_flow_skill_kind(self) -> None:
        from kimi_cli.skill.flow import FlowEdge, FlowNode

        flow = Flow(
            nodes={
                "BEGIN": FlowNode(id="BEGIN", label="Begin", kind="begin"),
                "END": FlowNode(id="END", label="End", kind="end"),
            },
            outgoing={
                "BEGIN": [FlowEdge(src="BEGIN", dst="END", label=None)],
                "END": [],
            },
            begin_id="BEGIN",
            end_id="END",
        )
        skills = {"plug:flowy": _skill("plug:flowy", skill_type="flow", flow=flow)}
        index = build_plugin_capability_index(skills)
        cap = index.match("flowy")
        assert cap is not None
        assert cap.kind == "flow_skill"
