"""API routes."""

from kimi_cli.web.api import config, open_in, plans, sessions

config_router = config.router
sessions_router = sessions.router
work_dirs_router = sessions.work_dirs_router
open_in_router = open_in.router
plans_router = plans.router

__all__ = [
    "config_router",
    "open_in_router",
    "plans_router",
    "sessions_router",
    "work_dirs_router",
]
