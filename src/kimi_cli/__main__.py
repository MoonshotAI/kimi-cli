"""Kimi CLI 的命令行进程入口。

这个模块非常薄，不包含任何业务逻辑，只负责三件事：
1. 在程序最开始安装崩溃处理器（crash handler）并规范化代理环境变量；
2. 单独处理 ``kimi --version`` / ``kimi -V`` 这种极简命令；
3. 把剩余参数原样交给 Typer 的 ``cli``（真正的 CLI 定义在
   ``kimi_cli/cli/__init__.py``），并把 ``SystemExit`` / 已知异常
   统一翻译成进程退出码。
"""

from __future__ import annotations

import sys
from collections.abc import Sequence
from pathlib import Path


def _prog_name() -> str:
    # 取 argv[0] 的文件名（如 "kimi" 或 "kimi-cli"）作为程序名，
    # 用于 Typer/Click 的帮助文本与错误提示。
    return Path(sys.argv[0]).name or "kimi"


def main(argv: Sequence[str] | None = None) -> int | str | None:
    # 延迟导入：把重量级模块推迟到真正需要时，加快启动速度。
    from kimi_cli.telemetry.crash import install_crash_handlers, set_phase
    from kimi_cli.utils.proxy import normalize_proxy_env

    # 第一步：在任何其它初始化之前安装 excepthook，
    # 确保启动阶段的崩溃也能被捕获、记录到 telemetry 崩溃日志。
    install_crash_handlers()
    # 把 HTTP(S)_PROXY / NO_PROXY 等代理环境变量规范化（处理小写、空值等），
    # 让 aiohttp/httpx 等库能正确读取代理配置。
    normalize_proxy_env()

    # 支持以列表形式传入参数（便于测试）；默认取 sys.argv。
    args = list(sys.argv[1:] if argv is None else argv)

    # `kimi --version` / `kimi -V` 单独短路，避免启动整个 Typer 应用。
    if len(args) == 1 and args[0] in {"--version", "-V"}:
        from kimi_cli.constant import get_version

        print(f"kimi, version {get_version()}")
        return 0

    from kimi_cli.cli import cli
    from kimi_cli.utils.environment import GitBashNotFoundError

    try:
        # 把控制权交给 Typer 的 cli：参数解析、子命令分发、主命令回调都在那里。
        return cli(args=args, prog_name=_prog_name())
    except SystemExit as exc:
        # Typer/Click 通过 SystemExit 表达退出码，这里原样返回（而非抛出），
        # 方便上层（如 PyInstaller 打包后的入口）拿到退出码。
        return exc.code
    except GitBashNotFoundError as exc:
        # Windows 下执行 shell 工具需要 git-bash，缺失时给出明确提示。
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        # 无论正常退出还是异常，都把 telemetry 阶段标记为 shutdown。
        set_phase("shutdown")


if __name__ == "__main__":
    # 让返回值成为进程退出码。
    raise SystemExit(main())
