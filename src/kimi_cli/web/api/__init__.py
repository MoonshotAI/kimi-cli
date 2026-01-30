"""API routes."""

from kimi_cli.web.api import config, sessions

config_router = config.router
sessions_router = sessions.router
work_dirs_router = sessions.work_dirs_router

__all__ = [
    "config_router",
    "sessions_router",
    "work_dirs_router",
]
