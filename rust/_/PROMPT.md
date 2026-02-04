当前项目是使用 Python 编写的 CLI coding agent 项目，参考 README.md 和 AGENTS.md 以了解项目基本信息。

现在需要把该项目的核心代码使用 Rust 重写，你可以使用 tokei -o json 命令看到项目的代码行数分布情况。在项目的整个目录结构中，

- src/kimi_cli/{(.py,wire/,skill/,soul/,tools/,ui/wire/)} 中的内容是 kimi-cli 项目的核心代码，这部分包括 Config 加载、Session 管理、Skills 支持、Agent Loop、Tools、UI 与 Loop 通信用的 Wire、和对外暴露 Wire messages 的 WireOverStdio 等。
- packages/kosong/src/kosong/{*.py,chat_provider/,message/,tooling/} 中的内容是 kosong 项目的核心代码。Kosong 是 Kimi CLI 底层的 LLM 抽象层。是 Kimi CLI 的 Agent Loop 和 Tools 的基石。
- packages/kaos/src/kaos/*.py 除 ssh.py 中的内容是 kaos 项目的核心代码。Kaos 是 Kimi CLI 的 OS 抽象层。负责代理 FS、Process 操作到 local 或 SSH 远端。
- 所有与上述内容相关的单元测试、集成测试和端到端测试也需要一并重写为 Rust 版本的测试。实际上只有与 UI 有关、与 shell 交互有关、与除 Kimi 之外的 chat provider 有关的测试可以不做重写。
- 所有 Utils 按需重写，根据 Rust 语言特性，某些 utils 可能不需要，或者需要以 Rust 的方式重写。鼓励使用第三方库来替代某些 utils 的功能。

上述部分是我们本次需要使用 Rust 重写的内容。重写后的 Rust 程序，应仍然分为三个 crate，分别对应 kimi-cli、kosong、kaos 三个 Python 项目。每个 crate 的功能和目录结构应与现有 Python 项目保持一致，但可以根据 Rust 语言的特性进行适当调整。

重写的技术栈采用最新 Rust edition、最新 Rust toolchain（需要先更新一下本地的 toolchain）、tokio async runtime，使用 serde 进行序列化和反序列化，使用 anyhow 和 thiserror 进行错误处理，使用 clap 进行 CLI 参数解析，使用 reqwest 进行 HTTP 请求。对于其他需要第三方库的情况，可以根据 Rust 社区的最佳实践选择合适的库。

重写后的 Rust 版本应：

1. 可以构建为一个单一可执行文件，不依赖 Python 环境，支持 macOS、Linux 和 Windows
2. 对于访问外部资源的，尽可能采用最合适的第三方库，比如说 OpenAI SDK 等
3. 不需要实现 Print UI、Shell UI 和 ACP 支持
4. CLI 参数与当前 Python 版本保持一致，除了 Print UI、Shell UI 和 ACP 支持相关的可以省略
5. 能够加载当前 ~/.kimi 中的 config、sessions 等所有元数据，可以无缝替换当前的 Python 版本（应通过只读的测试来验证这一点）
6. 对外提供与当前 Python 版本完全兼容的 WireOverStdio 接口，确保所有外部 SDK、UI 都能无缝替换为 Rust 版本的 kimi-cli
7. 支持 Kimi、Echo 和 ScriptedEcho chat provider（后两者用于端到端测试），并与当前 Kosong 的抽象保持一致，从而可以在下一步轻松添加对其他 chat provider 的支持
8. 支持 LocalKaos，并与当前 Kaos 的抽象保持一致，从而可以在下一步轻松添加对 SSH Kaos 的支持

再次强调：

1. 尊重现有模块划分，尤其是三大 crate 之间的边界和职责划分、在 wire 两端的 soul 和 WireOverStdio 之间的边界划分
2. 尊重现有的设计理念和概念，比如 Soul、KimiSoul、ChatProvider、Wire、Approval、LaborMarket 等等
3. 对于 Rust 与 Python 语言特性和最佳实践的差异，可以进行适当调整，但必须确保**功能和对外接口保持完全一致**
4. 元数据、配置、对外表现**必须完全兼容**
5. kosong.message 和 kimi_cli.wire.types 中的数据结构（类型名、字段名、字段类型）**必须完全一致**
6. 测试覆盖应与当前 Python 版本保持一致，除了本次无需实现的部分相关的测试可以省略
7. 所有对外功能，可以以 docs 中的中文文档为准，因为这是经过仔细 review 的最终用户文档

你应当非常仔细地理解现有代码，制定详尽的重写方案，写到 PLAN.md。PLAN 必须极为详尽，因为这个任务必然会消耗你的完整 context window，随后会压缩，你要确保压缩后能够继续工作。
完成方案制定后，开始工作。在过程中应时刻遵守我的要求，并常常回顾 PLAN.md，确保 on track。
Rust 版本写在当前目录的 rust 文件夹下，代码风格应符合 Rust 社区的最佳实践，包括命名、并发安全、错误处理、类型抽象等。对于所有公开的模块、API 和比较 tricky/复杂的实现细节，都应编写详尽的注释，对于项目的关键模块，编写子目录级的 AGENTS.md，确保代码易于理解和维护。
