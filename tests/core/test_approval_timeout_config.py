from __future__ import annotations

from kimi_cli.auth.oauth import OAuthManager
from kimi_cli.background import BackgroundTaskManager
from kimi_cli.notifications import NotificationManager
from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval


def test_runtime_injects_approval_timeout_from_config(
    config,
    llm,
    builtin_args,
    denwa_renji,
    session,
    labor_market,
    environment,
) -> None:
    config.approval.timeout_s = 123
    notifications = NotificationManager(
        session.context_file.parent / "notifications",
        config.notifications,
    )
    runtime = Runtime(
        config=config,
        llm=llm,
        builtin_args=builtin_args,
        denwa_renji=denwa_renji,
        session=session,
        approval=Approval(yolo=True),
        labor_market=labor_market,
        environment=environment,
        notifications=notifications,
        background_tasks=BackgroundTaskManager(
            session,
            config.background,
            notifications=notifications,
        ),
        skills={},
        oauth=OAuthManager(config),
        additional_dirs=[],
        skills_dirs=[],
        role="root",
    )

    assert runtime.approval.request_timeout_s == 123

    subagent_runtime = runtime.copy_for_subagent(agent_id="a-test", subagent_type="coder")
    assert subagent_runtime.approval.request_timeout_s == 123

    runtime.approval.set_request_timeout(45)
    assert subagent_runtime.approval.request_timeout_s == 45
