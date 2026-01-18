---
Author: "@stdrc"
Updated: 2026-01-07
Status: Implemented
---

# KLIP-0: Kimi CLI Improvement Proposal

## Kimi CLI 的前世今生

Kimi CLI 起源于 2025 年 9 月 1 日晚上开始的一个 side project——「Ensoul」。Ensoul 是一个命令行程序，功能是加载指定的 agent 文件（其中包含 system prompt 和要启用的 mshtools 中的 tool list），进入 REPL 接收用户 prompt，对用户 prompt 运行 agent loop。项目名字叫「Ensoul」是因为这个过程很像在给一个「死的」agent 文件「赋予灵魂」，让它「活起来」。

Ensoul 最初的目标是让不懂代码的 PM 能够利用当时已有的内部 agent 开发框架——「YAMAHA」。YAMAHA 是硬凑出来的名字，全称是「Yet Another Moonshot Agent, Hallucination Avoided」，它是更早已存在的专用于跑 GAIA benchmark 的「YAMA」的重写版。重写后的 YAMAHA 发展成了一个更为通用的 agent 开发框架，提供一些 agent 的构建单元，比如「ChatProvider」「Message」「Context」「Tool」「Toolset」——「Kosong」即脱胎于此。

Kosong 在马来语的意思是「空」，如此命名是希望它只提供「机制」，不提供「策略」，它不含有任何「实际的东西」，却又什么都蕴含了。「空即是色，色即是空」。当 Ensoul 逐渐取代 YAMAHA 的位置，又进而演变成 Kimi CLI 时，YAMAHA 中最通用的那部分东西，沉淀到了 Kosong。现在的 Kosong 包含 LLM 抽象层和 agent 开发原语（其中最为关键的是 `step` 函数），是 Kimi CLI 最关键的基石。它的存在使得 Kimi CLI 的核心 agent loop——「KimiSoul」的实现只需要 400 行 Python 代码。

现在回到 Kimi CLI。CLI 的全称是「Command Line Interface」，是所有运行在终端的命令行界面程序的统称，类似于所有图形界面的程序都称为「GUI」程序，所有运行在浏览器的程序都称为「Web」程序。当意识到 Ensoul「就是」Kimi CLI 时，我们把命令的名字改成了 `kimi`。它从一开始就不只是一个 coding agent，而是运行在命令行界面的 Kimi 智能助理，人们应该期待它可以做任何事，以命令行界面的形式。

那么它应该长什么样？「没有人想在终端里用聊天界面」是我们的早期共识。在 Claude Code 之前，人们只会在终端里用 shell，以及用 shell 运行其他命令行程序，如 `npm` `python` `rclone`；而一般大众则更是从来没有打开过终端。我们认为 Claude Code 把 chat UI 放到终端里完全是因为这样开发起来最快。GUI 是需要时间的，而且需要项目有更多人力资源，终端的 chat UI 似乎是一种可以很快推出的、谁都不想要但谁都能勉强用的形式。我们在最开始就认为，人们需要三种形式的 agent——面向大众的图形界面 agent、面向程序员的 AI-shell、面向程序员的 IDE 集成 agent。Kimi CLI 的第一步，是成为 AI-shell，至少长得像个 AI-shell。

但 UI 不是本质问题。无论表现为什么形态，内核是一样的。CLI 程序是一个非常理想的提供 agent 内核的形式。就像 MCP 工具最广泛使用的形式是通过 `npx` 运行并在 stdio 上通过 JSON-RPC 通信，Kimi CLI 在 shell UI 之外，提供了 Print 模式和 Wire 模式，可以在 stdio 上通过特定的格式接受用户 prompt 和推送 agent 行为事件。基于 Wire 模式，我们有了内部的 Web UI，和正在开发的 VS Code 扩展。除此之外，我们通过 ACP 模式提供 ACP 服务端（同样走 stdio 通信），支持接入任何 ACP 客户端，这使得 Kimi CLI 可以接入 JetBrains 和 Zed 等 IDE，也可以接入 DeepChat、Alma 这样的本地通用 agent 客户端。我们最开始所畅想的三种形式，正在一一出现并变得可用。

仅仅如此还不够，从 Ensoul 的第一天开始，它就是支持定制化的。Kimi CLI 内核的能力不仅限于提供一个预定义好的 agent。像诞生第一天那样，Kimi CLI 支持通过 agent 文件定制 system prompt 和 tool list。同时，我们也支持了通过 MCP tools 和 skills 扩展 Kimi CLI 的能力，使每个用户可以以独特的方式使用 Kimi CLI。除了使用 `kimi` 命令，还可以把 Kimi CLI 安装为 Python 依赖，直接使用其中模块解耦良好的 agent kernel 和 UI 组件，构建上层应用程序。下一步，我们将会对 Kimi CLI 的 Wire 模式做进一步封装，形成 Kimi Agent SDK，使得用 Python、Nodejs、Go 等各种语言的用户可以更方便地构建 agent 应用。

「Lead, don't follow」是我们收到的最好的鼓励。鉴于我们更年轻，不可避免地落后于 Claude Code、OpenCode 等优秀项目，但我们绝不盲目 follow 它们。Kimi CLI 所有的想法、功能都是从零开始自然发生的，所有架构都是从零思考的。对于其中的许多部分，我们发现它与先驱产品不谋而合，比如 Wire 模式和 ACP 非常接近，Kimi Agent SDK 与 Claude Agent SDK 的架构也非常相似，但这不影响我们从第一性原理思考事情的本质。我们相信最终有一天我们可以 lead 一些事情。

## Kimi CLI Improvement Proposal

Kimi CLI 内核的大厦已经初具稳定的形状，现在我觉得是时候引入一个机制让 Kimi CLI 的开发以更 scalable 的方式进行，同时也是作为我们对下一代软件开发范式的探索。

Code is cheap，这已经是所有人的共识了。提出 pull request 现在已经没有成本，完全不需要人的思考，就可以写出几百上千行代码，可以完成功能，也能通过所有测试。但这不代表价值，无脑地堆砌 agent 的代码只会造成不可控的屎山。当代码本身变得没有价值，代码架构、可扩展性、稳定性、产品决策的重要性反而更为凸显。这其实并不是现在才应该认识到的，Linux kernel 创始人 Linus Torvalds 有句著名的说法「Bad programmers worry about the code. Good programmers worry about data structures and their relationships.」就是这意思。当我们有了良好的数据结构和关系，功能代码会自动生长出来，这时候 agent 写的代码也会是美的。

因此，KLIP 应该强调数据结构和关系的变化。未来，对于稍大的功能，Kimi CLI 的一个典型工作流程应该是：

1. 无脑给 agent 提出需求，看看会写出什么
   1. 可以迭代或重写获得一个足够证明思路可行的东西
2. 与此同时，程序员思考此功能所需的「本质修改」，也就是对架构、数据类、协议、模块接口的修改
3. 程序员和 agent 共同撰写和迭代 KLIP，详细描述所有「本质修改」
   1. 应尽量使用伪代码和图示，既不空中楼阁，也不追求细化到每一行代码的变化
4. 让其他人 review KLIP，根据反馈，调整 KLIP 和 feature 分支可能已经存在的原型代码
   1. 要保持 KLIP 更新，始终反映「本质修改」
5. 从 KLIP，用 agent 生成具体的代码实现
   1. 代码实现也可能在迭代 KLIP 的过程中就已经成熟了，这没问题
6. 用最少的精力 review 具体的代码变更，合并

这其实和过去大型软件的迭代过程非常类似，区别在于，KLIP 和代码可以同时迭代，当 KLIP 被 accept 时，代码几乎已经可用了，而不会出现（最好是不会），KLIP 想得很好，但实现出来跟想象差别很大的情况。实际上这和 Linux kernel、CPython、C++ 这类更严肃的分布式开发的超大型软件是一致的，这些软件的贡献者在提出提案时，往往已经写好了一个可以工作的原型。Agent 的辅助可以让我们更好地实践这个高标准的流程。

让我们看看会发生什么。
