# Kimi CLI：面向 Java 开发者的学习指南

## 项目概览
- **定位**：Kimi CLI 是一个 Python 3.13+ 编写的交互式 AI 编程代理，既可执行 shell 命令，也可作为 Agent Client Protocol (ACP) 服务器接入 IDE。
- **关键能力**：Shell 模式、Print 模式、ACP 模式、Zsh 插件、MCP 工具集成、PyInstaller 打包以及完善的 `uv`/`Makefile` 开发流水线。
- **质量保障**：`ruff` 负责格式化+静态检查，`pyright` 做类型检查，`pytest`+`pytest-asyncio` 进行单元/集成测试；常用命令集中在 `make format/check/test`。

## 核心架构速览
| 层级 | 关键文件 | 功能摘要 |
| --- | --- | --- |
| Agent 系统 | `src/kimi_cli/agent.py`, `src/kimi_cli/agents/*.yaml` | YAML 描述 agent，注入系统提示和工具配置 |
| Soul 执行引擎 | `src/kimi_cli/soul/` | `KimiSoul`、`Context`、`DenwaRenji` 负责会话、事件驱动调度、重试机制 |
| 工具层 | `src/kimi_cli/tools/` | bash/file/web/task/dmail 等模块化工具，支持 MCP 扩展 |
| UI 层 | `src/kimi_cli/ui/` | Shell/Print/ACP 等不同交互模式，基于 Typer CLI 构建 |

## Java 开发者的学习路径
1. **快速体验**：使用 `uv tool install --python 3.13 kimi-cli` 安装，运行 `kimi --help` 或 `kimi --acp`，体验 Shell vs Agent 模式的差异。
2. **对照架构理念**：阅读 `src/kimi_cli/agent.py` 与 `src/kimi_cli/soul/`，对比 Java 中的 IOC、事件驱动或 Reactor 模式，理解 Python 的 async/await、依赖注入写法。
3. **工具扩展练习**：挑选 `src/kimi_cli/tools/` 下的轻量模块（如 file/task），模仿其依赖注入和 Typer 命令行配置，尝试新增“Java 友好”工具（如 Maven/Gradle 操作）。
4. **测试与质量流程**：运行 `make check`、`make test`，对照 Java 世界的 Maven/Gradle + JUnit/SpotBugs，理解 `ruff`、`pyright`、`pytest-asyncio` 的协作方式。
5. **文档与打包**：浏览 `docs/`、`wiki/` 和 `CHANGELOG.md`，学习 Python 项目在 PyPI 发版、PyInstaller 打包可执行文件时的配置策略。
6. **跨语言思考**：对比 `src/kimi_cli/ui/` 的 Typer CLI 设计与 Java 中的 Picocli/Spring Shell，从错误处理（loguru vs slf4j）、配置 (`~/.kimi/config.json` vs `.properties/.yaml`) 等角度建立映射。

## 推荐后续步骤
- 执行 `make help` 熟悉所有内置任务，再针对感兴趣的模块深入代码。
- 按 `AGENTS.md` 指南尝试编写自定义 Agent 或 MCP 配置，形成自己的实验项目。
- 结合 Java 的工程经验，为 Kimi CLI 贡献一个新的工具模块或测试用例，加深对 Python 异步生态的理解。
