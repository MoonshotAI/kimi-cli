# Kimi Core (TypeScript) 设计文档 v2

> **本次修订基于 2026-04-10 ~ 2026-04-11 的架构讨论。v1 见 `kimi-core-ts-design.md`，保留作为对比参考。**
>
> **参考调研数据来源**：cc-remake（Claude Code）、pi-mono、kimi-cli（Python），通过多轮 agent team 调研获得代码级证据。

## 〇、文档导读

本文档是 **kimi-cli v2**（kimi-core TypeScript 完全重写）的架构设计蓝图，继承 v1 已拍板决策（EventSink、非阻塞 prompt、Hook 双通道、扁平事件、delta 模式、五通道路由、Transport 可插拔、Wire First），在此基础上做几处关键结构性变更，让设计更贴近真实二次开发场景和未来的 agent workflow。

**核心设计**：

- **Wire First**：所有外部交互（含同进程）走 Wire 协议，`wire.jsonl` 是 session 对话状态与审计记录的唯一持久化真相源，Transport 可插拔
- **Soul 无状态函数**：`runSoulTurn` 是一个无 this / 无实例字段 / 无跨 turn 状态的 async function，所有运行期状态外置在 `SoulContextState` 里；对 permission/approval 零感知（铁律 2）；所有依赖参数注入。注意"无状态"不等于"无副作用"——详见 §5.0 铁律 1 下方的澄清段落
- **SoulPlus 运行时宿主**：三层 DAG（共享资源层 → 服务层 → 行为组件层），管理 session lifecycle / permission / approval / skill / notification / agent team
- **双写入通道**：`ContextState`（对话状态 durable 写入）+ `SessionJournal`（纯审计/生命周期/协作类 record），底层共享 `JournalWriter`；Soul ↔ SoulPlus 走 `ContextState`（async 写状态）+ `EventSink`（fire-and-forget UI/遥测）双通道
- **多 Agent**：Task subagent（同进程 Soul 实例）+ Agent Team（多进程 SoulPlus + 可插拔 `TeamCommsProvider`）；subagent 独立 wire.jsonl + source 标记转发，父 wire 只记生命周期引用
- **Permission 单一 gate**：`beforeToolCall` 闭包是唯一 approval gate，规则 baked 进闭包，Tool 接口极简化（`name/description/inputSchema/execute`）
- **Crash Recovery**：被动 journal repair + dangling tool call 补 synthetic record；lifecycle 总回 idle，不自动续跑旧 turn

**文档结构**：§一~§四 基础协议与存储 → §五~§七 会话核心（Soul / SoulPlus / Abort Contract）→ §八~§九 多 Agent 与 Crash Recovery → §十~§十七 能力子系统（Tool / Permission / Approval / Hook / Transport / Skill / Plugin / 路径配置）+ §十七A MCP 集成（Phase 1 接口预留） → §十八~§二十一 运维与规划与决策记录 → 附录 A-F + ADR-X + 结语。

> **注**：§十七A 是新插入的 MCP 集成独立章节，编号紧接 §十七 之后，不破坏 §十八 起的历史编号。

完整的 v1 → v2 以及 v2 初稿 → v2 终稿的变更对照见 **附录 C**。关键设计决策（**#1~#102**）索引见 **§二十一**，其中 #78~#102 的完整 ADR 论证见 **附录 ADR-X**（#95-#100 由 batch1/2/3 后新增，#101-#102 由 arch-roi-A 修复批次 1 新增），已撤销/已废弃条目见 **附录 F**。

---

## 一、定位与目标

Kimi Core 是 kimi-cli 的 TypeScript 完全重写版本，**完全替代** Python 版（路径 A）。定位为**统一的 Agent 引擎**，支撑 TUI、Web、SDK、Hive 等多种产品形态。

### 核心设计原则

1. **Wire First**：所有外部交互都通过 Wire 协议，包括同进程 `import` 场景
2. **Transport 无关**：协议固定（JSON），载体可插拔（Memory / Stdio / Socket / WebSocket）
3. **Soul 是纯状态机**：给它 context + state，它就能跑完 agent loop，不依赖外部管理代码
4. **管理请求不阻塞对话**：管理通道和对话通道通过 Core 内部路由器分发，互不拖累
5. **Append-only 唯一持久化真相源**：`wire.jsonl` 是 session 对话状态与会话审计记录的唯一持久化真相源，内存状态由其重放构建
6. **多 Session + 多 Agent Loop**：一个进程可以同时跑多个 session、多个 subagent
7. **外部不知道 Soul**：调用方只面向 Wire 消息，不知道 Soul / SoulPlus / Runtime 的存在

### 非目标（v2 第一阶段不做）

- 消息级 Edit（通过命令或 email 编辑历史 message）
- 命令式 rewind / undo
- Flow-based Agent Workflow（YAML 定义的 dev→review 流水线）
- Sandbox 集成（靠 Kaos 预留接口，不做 native sandbox）
- `/export` 容错恢复命令
- 跨进程 hot reload

这些延后能力在 v2 架构上 **预留接口**，但不在第一阶段实现。

---

## 二、整体架构

```text
┌──────────────────────────────────────────────────────────────────┐
│                          外部调用方                               │
│   TUI (Node)    │   Python SDK    │   Web/Hive    │   TS 库      │
└────────┬────────┴────────┬────────┴────────┬──────┴──────┬───────┘
         │ Wire msg        │ Wire msg        │ Wire msg    │ Wire msg
┌────────▼─────────────────▼─────────────────▼─────────────▼───────┐
│                     Transport 层（可插拔）                        │
│   Memory        │    Stdio        │    Socket      │  WebSocket  │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────┐
│                          Core Process                             │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   Router (五通道分发)                    │    │
│  │    对话   │   管理   │   配置   │   控制   │   工具      │    │
│  └──────────────────────────┬──────────────────────────────┘    │
│                             ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │           SessionManager（session 注册表）              │    │
│  │   Map<session_id, SoulPlus>                             │    │
│  └──────────────────────────┬──────────────────────────────┘    │
│                             ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   SoulPlus (管理壳)                     │    │
│  │   ┌───────────────────────────────────────────────┐    │    │
│  │   │ ── 共享资源层（D10 三层 DAG 第 1 层）──         │    │    │
│  │   │ SessionLifecycleStateMachine  (5 态)           │    │    │
│  │   │ SoulLifecycleGate            (写入 gate)     │    │    │
│  │   │ JournalWriter                  (append-only    │    │    │
│  │   │                                 wire.jsonl     │    │    │
│  │   │                                 ordering point)│    │    │
│  │   │ WiredContextState              (状态类 record  │    │    │
│  │   │                                 + 投影)        │    │    │
│  │   │ SessionJournal                 (审计/协作类    │    │    │
│  │   │                                 record)        │    │    │
│  │   │ ── 服务层（D10 第 2 层）──                      │    │    │
│  │   │ Runtime / ConversationProjector /              │    │    │
│  │   │ ApprovalRuntime / ToolCallOrchestrator         │    │    │
│  │   │ ── 行为组件层（D10 第 3 层）──                  │    │    │
│  │   │ RequestRouter     (五通道分发入口)              │    │    │
│  │   │ TurnManager       (lifecycle + wakeQueue)      │    │    │
│  │   │ SoulRegistry      (Map<SoulKey, SoulHandle>)   │    │    │
│  │   │ SkillManager / NotificationManager /           │    │    │
│  │   │ TeamDaemon                                     │    │    │
│  │   │ (TransactionalHandlerRegistry: setModel /      │    │    │
│  │   │  getUsage / ... —— 非行为组件，由 SoulPlus       │    │    │
│  │   │  直接持有，供 RequestRouter 透传使用)           │    │    │
│  │   └──────────────────┬────────────────────────────┘    │    │
│  │                      │ 按需创建                          │    │
│  │                      ▼                                    │    │
│  │   ┌───────────────────────────────────────────────┐    │    │
│  │   │   Soul (无状态函数 runSoulTurn)               │    │    │
│  │   │   输入：SoulContextState + Runtime + EventSink  │    │    │
│  │   │   输出：events → EventSink                     │    │    │
│  │   │   运行：agent loop (LLM + tool 循环)            │    │    │
│  │   └───────────────────────────────────────────────┘    │    │
│  │                                                          │    │
│  │   同一个 SoulPlus 可以托管多个并发的 Soul 实例：          │    │
│  │   - 主 agent 的当前 turn                                │    │
│  │   - 正在跑的 subagent 们                                │    │
│  │   - agent team 的独立 agent 们                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │   HookEngine          (server-side + wire 双通道)        │    │
│  │   Kaos                (路径透明化，未来接 sandbox/SSH)    │    │
│  │   Kosong              (LLM provider adapter)             │    │
│  └─────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
```

**关键关系**：

- **Router** 只是个分发器，不持有状态
- **SessionManager** 持有所有活跃 session（即所有 SoulPlus 实例）
- **SoulPlus** 是每个 session 的门面，所有状态都存在它里面
- **Soul** 是无状态的执行器——SoulPlus 按需创建，跑完可以丢弃（也可以复用同一实例执行下一个 turn）
- **Soul 永远不会直接看到 Transport、Router、Wire 消息**，它只和 `EventSink` + `Runtime` 交互

### 运行时假设与约束（Phase 1）

以下假设是 v2 架构设计的前提条件，贯穿全文。它们在 Phase 1 范围内合理——属于事实文档化，不是设计选择。

- **进程模型**：单进程多 session。每个 session 对应一个 SoulPlus 实例，由同一个 Node.js 进程的 SessionManager 持有。不使用 `worker_threads` 做 session 隔离（Phase 1 范围内 trusted users，隔离需求不紧迫）。
- **并发模型**：Node.js 单线程事件循环。所有同步代码块天然原子，不需要锁。CPU-bound 操作（如大 JSON 解析、token 计数）如需卸载，走 `worker_threads` 或 `child_process`——但 Phase 1 不预期需要。
- **Subagent 资源隔离**：同进程 subagent 共享内存、CPU 时间片、文件 handle pool，无 VM 隔离。一个 misbehaving subagent（死循环 / 内存泄漏 / 阻塞性同步代码）能 starve event loop，拖死同一进程内所有 session。Phase 1 的防线是 AbortController + try/catch（§7），Phase 3+ 可考虑 worker_threads 或进程级隔离。
- **OS 假设**：主要 POSIX（macOS / Linux）。Windows 通过 §9.6 的跨平台写入策略兼容（决策 #104）。
- **Runtime 假设**：Phase 1 针对 Node.js >= 20。Bun / Deno 不在 Phase 1 验证范围——better-sqlite3 的 native binding 在 Bun 下存在已知兼容问题，Deno 完全不支持。
- **Memory 假设**：ContextState 全 in-memory（snapshot 模式），长跑 session 内存随 context 增长。compaction（§6.4 / §6.12.2）是唯一收缩机制——Phase 1 不做 out-of-core 分页。
- **Network 假设**：Transport 层 Phase 1 主要 localhost（MemoryTransport / StdioTransport / SocketTransport）。跨机器场景走 WebSocketTransport，但 Phase 1 不重点测试。

---

## 三、Wire 协议 2.1

### 3.1 统一消息信封（极繁主义）

```typescript
interface WireMessage {
  // === 必填字段 ===
  id: string;              // 唯一 ID，前缀区分：req_/res_/evt_
  time: number;            // Unix 毫秒时间戳（v2 新增，便于排序和调试）
  session_id: string;      // 多 session 路由键（v2 改为必填，进程级方法用特殊值 "__process__"）
  type: "request" | "response" | "event";
  from: string;            // 发送方标识（v2 新增，见 3.2）
  to: string;              // 接收方标识（v2 新增，见 3.2）

  // === 根据 type 分别必填 ===
  method?: string;         // request/event：方法名
  request_id?: string;     // response：关联的 request id
  data?: unknown;          // request/response/event：payload
  error?: {                // response：错误信息
    code: number;
    message: string;
    details?: unknown;
  };

  // === 可选字段 ===
  turn_id?: string;        // v2 新增：`turn_${counter}` 形如 "turn_1" / "turn_42"（字符串，不是 "1.1.2" 这种多级编号）
  agent_type?: "main" | "sub" | "independent";  // v2 新增：区分主/子/独立 agent
  seq?: number;            // event 的单调递增序列号（用于断线重连）
}
```

**为什么极繁主义？** 和技术负责人的讨论中明确了这一点：**防止多 agent 环境下的串台问题**（竞品 CC 的 agent team 实现就因为只靠 name 不带 session_id 而容易串台）。宁可多塞几个字段，也不要以后补补丁。

### 3.2 `from` / `to` 的语义

单 agent 场景：
```
Client → Core:   from="client",  to="core"
Core → Client:   from="core",    to="client"
```

多 agent 场景（subagent / agent team）：
```
Client → Core:              from="client",   to="core"
Core → SubAgent runtime:    from="main",     to="sub:<agent_id>"
SubAgent → Parent:          from="sub:<id>", to="main"
Core → Client event:        from="main",     to="client"   # 主 agent 事件
Core → Client event:        from="sub:<id>", to="client"   # 子 agent 事件
```

`session_id` 始终标识 **顶层 session**；subagent 使用同一个 session_id，通过 `from/to` 区分发送方。如果 subagent 被结构化为**独立 session**（`session.create` 新建），那它就有自己的 session_id。

### 3.3 消息方向

```
Client → Core (request):      { type: "request",  method: "session.prompt", data: {...} }
Core → Client (response):     { type: "response", request_id: "req_xxx", data: {...} }
Core → Client (event):        { type: "event",    method: "turn.begin", seq: 42, data: {...} }
Core → Client (request):      { type: "request",  method: "approval.request", data: {...} }  # 双向 RPC
Client → Core (response):     { type: "response", request_id: "req_yyy", data: {...} }
```

双向通信是 v2 的明确决策——管理 API（get_usage、setModel 等）需要从客户端主动发起，这只能用双向。同时，approval / question / hook 是反向请求的经典案例。

### 3.4 协议版本

```typescript
const WIRE_PROTOCOL_VERSION = "2.1";
```

`2.1` 相对 v1 提到的 `2.0`，增加了上述字段。`initialize` 时握手协商版本，client 如果只支持 2.0，core 降级时不发 `time` / `from` / `to` / `turn_id` / `agent_type` 等 2.1 新增字段，仅保留 2.0 的 `{id, session_id?, type, method, request_id, data, error, seq}` 核心信封（核心功能不变）。

### 3.5 请求方法列表

#### Client → Core（进程级，session_id="__process__"）

| method | 用途 | 返回 |
|---|---|---|
| `initialize` | 握手；入参含 `protocol_version`（协议版本协商）、`capabilities`（客户端能力声明）、`hooks`（Wire hook 订阅，可选）。详见下方 InitializeRequest schema | `{ protocol_version, capabilities, session_id? }`。详见下方 InitializeResponse schema |
| `shutdown` | 关闭 Core 进程 | `{}` |
| `session.create` | 创建新 session | `{ session_id }` |
| `session.list` | 列出所有 session（读 state.json） | `{ sessions: SessionInfo[] }` |
| `session.destroy` | 销毁 session | `{}` |
| `config.getModels` | 获取可用模型 | `{ models, default_model }` |
| `config.get` | 读取全局配置 | `{ config }` |

**`initialize` 请求入参 schema**：

```typescript
// initialize 请求入参
interface InitializeRequest {
  protocol_version: string;     // 客户端支持的协议版本（如 "2.1"）
  capabilities?: {
    hooks?: boolean;            // 是否支持 Wire hook 回调
    approval?: boolean;         // 是否支持 approval 交互
    streaming?: boolean;        // 是否支持流式事件
  };
  hooks?: Array<{               // Wire hook 订阅声明（可选，详见 §13.6.1）
    event: string;              // 监听的 hook 事件（如 "PreToolUse"）
    matcher?: HookMatcher;      // 匹配条件（如 { toolName: "Bash" }）
  }>;
}

// initialize 返回值
interface InitializeResponse {
  protocol_version: string;     // 服务端选定的协议版本
  capabilities: {               // 服务端能力声明
    events: string[];           // 支持的事件类型列表
    methods: string[];          // 支持的方法列表
  };
  session_id?: string;          // 如果是 resume 场景
}
```

#### 对话通道（需 session_id，可能长时间运行）

| method | 用途 | 返回 | 备注 |
|---|---|---|---|
| `session.prompt` | 提交用户输入 | `{ turn_id, status: "started" }` | **非阻塞**，立即返回 |
| `session.steer` | 运行中注入 steer 消息 | `{ queued: true }` | queue 到当前 turn |
| `session.cancel` | 取消当前 turn | `{}` | 同步完成 |
| `session.resume` | 从持久化恢复（启动时或显式重连） | `{ status }` | 读 wire.jsonl 重建 |

#### 管理通道（需 session_id，即时完成）

| method | 用途 | 返回 |
|---|---|---|
| `session.fork` | Fork session（从某 turn 分叉） | `{ session_id }` |
| `session.rename` | 重命名（同步事务，走 SessionMetaService → wire `session_meta_changed`，决策 #113） | `{}` |
| `session.setTags` | 设置 tags（全量替换语义，同步事务，走 SessionMetaService，决策 #113） | `{}` |
| `session.getMeta` | 读取完整 SessionMeta 快照（精确路径，区别于批量读 state.json 的 `session.list`，决策 #113） | `{ meta: SessionMeta }` |
| `session.getStatus` | 获取状态快照（state + 当前 turn） | `{ state, current_turn, ... }` |
| `session.getHistory` | 获取消息历史（内存 ContextState 快照） | `{ messages }` |
| `session.getTurnEvents` | 获取 turn 事件（断线重连） | `{ events }` |
| `session.getUsage` | 获取 token 用量、成本统计 | `{ usage }` |
| `session.compact` | 手动触发压缩 | `{}` |
| `session.subscribe` | 订阅 session 事件（Observer） | `{}` |
| `session.unsubscribe` | 取消订阅 | `{}` |
| `session.attach` | 获取 session ownership | `{}` |
| `session.dump` | 导出 session 当前状态快照（debug 用，决策 #108） | `{ session_id, messages, usage, lifecycle, journal_stats, subagents, ... }` |
| `session.healthcheck` | 检查 session 健康状态（决策 #108） | `{ healthy, broken_reason?, turn_count, checks, ... }` |

#### 进程级诊断（session_id="__process__"，决策 #108）

| method | 用途 | 返回 |
|---|---|---|
| `core.metrics` | 全局指标（内存、session 数、active turns） | `{ heap_used, heap_total, rss, sessions, active_turns, open_fds, uptime_ms, ... }` |

#### 配置通道（需 session_id，即时完成）

| method | 用途 | 返回 |
|---|---|---|
| `session.setModel` | 运行时切换模型 | `{}` |
| `session.setThinking` | 切换思考级别 | `{}` |
| `session.setSystemPrompt` | 修改 system prompt | `{}` |
| `session.setPlanMode` | 切换 plan mode | `{}` |
| `session.setYolo` | 切换 yolo mode | `{}` |
| `session.addSystemReminder` | 注入一次性上下文 | `{}` |

所有配置通道操作都以 **append wire 事件** 的方式持久化。详见 §4.3 的 `SystemPromptChangedRecord` 等配置变更 record。

其中 `session.addSystemReminder` 和其他配置变更在语义上略有差别：它是一次性 reminder 注入，走 `ContextState.appendSystemReminder` 做 **durable 写入**（见 §4.5.2 / §4.6），落盘为 `SystemReminderRecord` 作为对话事件进入 transcript；`ConversationProjector` 每次 `project(snapshot)` 时会把它组装为 `<system-reminder>` 包裹的系统消息（和 CC 对齐）。因此它能被 replay 还原，并且**后续 turn 的 LLM 每次都能看到**——这是和 v2 初稿"只注入一次后从 transcript 中消失"方案的关键区别，避免 assistant 后续引用 reminder 内容时出现因果断裂。

#### 工具通道（需 session_id，即时完成）

| method | 用途 | 返回 |
|---|---|---|
| `session.registerTool` | 动态注册工具 | `{}` |
| `session.removeTool` | 移除工具 | `{}` |
| `session.listTools` | 列出工具 | `{ tools }` |
| `session.setActiveTools` | 设置活跃工具集 | `{}` |

#### MCP 通道（需 session_id，决策 #100 / Phase 1 接口预留 + Phase 3 实现）

| method | 用途 | 返回 | Phase |
|---|---|---|---|
| `mcp.list` | 列出所有 MCP server + 状态 | `{ servers: McpRegistrySnapshot["servers"] }` | Phase 1 stub / Phase 3 实现 |
| `mcp.connect` | 连接一个 server | `{ ok, error? }` | 同上 |
| `mcp.disconnect` | 主动断开（不重连） | `{}` | 同上 |
| `mcp.refresh` | 重新拉 ToolList | `{ added: string[], removed: string[] }` | 同上 |
| `mcp.listResources` | 列出资源 | `{ resources: McpResource[] }` | Phase 1 stub / Phase 3 实现 |
| `mcp.readResource` | 读资源（`{ uri }`） | `{ content }` | 同上 |
| `mcp.listPrompts` | 列出 prompt | `{ prompts }` | Phase 3+ |
| `mcp.getPrompt` | 获取 prompt（`{ name, args? }`） | `{ messages }` | Phase 3+ |
| `mcp.startAuth` | 触发 OAuth 流程（`{ server_id }`） | `{ auth_url, callback_pending }` | Phase 3 |
| `mcp.resetAuth` | 清除 OAuth token | `{}` | Phase 3 |

> Phase 1 routing 阶段返回 NotImplemented；Phase 3 由 `RealMcpRegistry` 实现接通。详见 §17A MCP 集成架构。
>
> Phase 1 zod schema 定义见**附录 A.x：MCP Wire Events Schemas** 中的 `McpRegistrySnapshotSchema`（已落地，详见 B4）。

#### Core → Client（双向 RPC）

| method | 用途 | 期望 response |
|---|---|---|
| `approval.request` | 工具权限请求 | `{ response: "approved" \| "rejected" \| "cancelled", feedback?: string }`（对齐附录 B `ApprovalResponseSchema` / §12.2 `ApprovalResponseData`；request 侧字段见附录 B `ApprovalRequestSchema`） |
| `question.ask` | 向用户提问 | `{ answers }` |
| `tool.call` | SDK 端工具调用（**SDK 模式专用 method**，与 §3.6 事件流中的同名 `tool.call` 事件 —— 见 L327 —— 命名空间不同：一个是 RPC method，一个是 Core → Client 的 UI 事件，不要混淆） | `{ output, is_error? }` |
| `hook.request` | Wire Hook 回调 | `{ action, reason, ... }` |

### 3.6 事件类型（Core → Client 单向推送）

扁平结构，与 v1 一致（继承决策：不分层、delta 模式）。

| method | 关键 data 字段 | 触发场景 |
|---|---|---|
| `turn.begin` | `turn_id, user_input, input_kind, trigger_source?` | turn 开始 |
| `turn.end` | `turn_id, reason, success, usage?` | turn 结束（含 cancel/error） |
| `step.begin` | `step` | LLM 调用开始 |
| `step.end` | — | LLM 调用结束（有始有终原则） |
| `step.interrupted` | `step: number, reason: string` | 步骤异常中断（step.begin 的异常终结，两字段均必填） |
| `content.delta` | `type, text/think/...` | 内容增量（TextPart/ThinkPart 等） |
| `tool.call` | `id, name, args, description?, user_facing_name?, input_display?` | 工具调用开始（决策 #98 / Tool UI 渲染契约：新增 `user_facing_name` / `input_display`；`description` 仍由 `getActivityDescription` 生成） |
| `tool.call.delta` | `args_part` | 工具调用参数增量（Phase 1 Soul 不 emit；Phase 2 启用 streaming tool execution 后由 KosongAdapter wrapper 在 stream 期间 emit，对应 LLM `tool_use` block 的 partial input 累积，决策 #97） |
| `tool.progress` | `tool_call_id, update, progress_description?` | 工具执行过程中的流式进度（EventSink `tool.progress` 的 Wire 映射，仅 UI，不落盘；决策 #98 新增 `progress_description` 字段）。注意：v2 新增概念，**不是从 Python kimi-cli port**——Python `ToolReturnValue` 没有 progress 字段，只有 buffered output / background task 两条路；本事件借鉴 CC `getCompletedResults` 流式拉取语义 |
| `tool.result` | `tool_call_id, output, is_error?, result_display?, collapsed_summary?` | 工具调用结果（决策 #98 / Tool UI 渲染契约：新增 `result_display` / `collapsed_summary`） |
| `status.update` | `context_usage, token_usage, plan_mode, mcp_status, model` | 状态变更 |
| `status.update.mcp_status` | `McpRegistrySnapshot \| null`（详细 snapshot） | 决策 #100 / D-MCP-9：和 `mcp.loading` 并存，提供完整状态 |
| `compaction.begin` | — | 压缩开始 |
| `compaction.end` | `tokens_before?, tokens_after?` | 压缩结束（summary 从 `CompactionRecord` 读，不在事件里） |
| `mcp.loading` | `status: "loading"\|"loaded"\|"error", server_name, error?` | MCP server 加载状态变更（决策 #100 / D-MCP-9：保留作为 lifecycle 信号；producer = `McpRegistry.startAll`） |
| `mcp.connected` | `server_id, capabilities, tool_count` | MCP server 连接成功（决策 #100，Phase 1 占位 / Phase 3 emit） |
| `mcp.disconnected` | `server_id, reason` | MCP server 主动 / 被动断开（决策 #100） |
| `mcp.error` | `server_id, error, retry_in_ms?` | MCP 连接失败 / 认证失败 / tool call 失败（决策 #100） |
| `mcp.tools_changed` | `server_id, added: string[], removed: string[]` | server 推 list_changed 或重连后 ToolList 变化（决策 #100） |
| `mcp.resources_changed` | `server_id` | server 推 resources/list_changed（决策 #100，Phase 3） |
| `mcp.auth_required` | `server_id, auth_url` | server 401，等用户走 OAuth（决策 #100，Phase 3） |
| `plan.display` | `content, file_path` | Plan 内容展示 |
| `hook.triggered` | `event, target, hook_count` | Hook 被触发 |
| `hook.resolved` | `event, target, action, reason, duration_ms` | Hook 执行完成 |
| `notification` | `id, category, type, source_kind, source_id, title, body, severity, targets, dedupe_key?` | 系统通知（含背景任务完成等，落盘） |
| `subagent.spawned` | `agent_id, agent_name?, parent_tool_call_id, parent_agent_id?, run_in_background` | 子 agent 被创建（父 wire 记录生命周期） |
| `subagent.completed` | `agent_id, parent_tool_call_id, result_summary, usage?` | 子 agent 正常完成 |
| `subagent.failed` | `agent_id, parent_tool_call_id, error` | 子 agent 执行失败 |
| `team_mail` | `mail_id, reply_to?, from_agent, to_agent, content, summary?` | agent team 成员间消息（soul-to-soul 通信） |
| `skill.invoked` | `skill_name, execution_mode, original_input, invocation_trigger, query_depth?, sub_agent_id?` | Skill 被调用（决策 #99 新增 `invocation_trigger: "user-slash" \| "claude-proactive" \| "nested-skill"` + `query_depth?`） |
| `skill.completed` | `skill_name, execution_mode, success, error?, invocation_trigger, query_depth?, sub_agent_id?` | Skill 执行完成/失败（镜像 invocation_trigger / query_depth，保持成对） |
| `session.ownership_lost` | — | 所有权被转移 |
| `session.error` | `error, error_type?, retry_after_ms?, details?` | session 错误（结构化） |
| `system_prompt.changed` | `new_prompt` | system prompt 被修改 |
| `model.changed` | `old_model, new_model` | 模型切换 |
| `thinking.changed` | `level` | 思考级别切换 |
| `session_meta.changed` | `patch: Partial<SessionMeta>, source: "user" \| "auto" \| "system"` | session 元数据 wire-truth 字段（title / tags / description / archived / color）变更（决策 #113）；derived 字段变化不触发本事件 |
| `context.edited` | `operation, target_id, ...` | 预留：context 编辑（第一阶段不暴露） |

#### 3.6.1 事件字段详解（v2 新增/变更）

**`turn.begin` 新增字段**：

```typescript
turn.begin {
  turn_id: string;                        // `turn_${counter}`，与 §6.4 TurnManager 生成口径一致
  user_input: string;
  input_kind: "user" | "system_trigger";  // 区分用户发起 vs 系统自动触发
  trigger_source?: string;                // system_trigger 时标注来源
  // trigger_source 示例：
  //   "teammate:researcher"     → teammate 发来消息
  //   "task_completed:sub_abc"  → background subagent 完成
  //   "notification:n_xxx"      → 重要通知触发
}
```

UI 根据 `input_kind` 渲染不同的 turn header：
- `"user"` → 显示用户头像 + 消息
- `"system_trigger"` → 显示系统图标 + trigger_source 的描述

**`turn.end` 新增字段**：

```typescript
turn.end {
  turn_id: string;                       // 同 turn.begin，形如 `turn_${counter}`
  reason: "done" | "cancelled" | "error";
  success: boolean;
  usage?: {                              // per-turn token 用量统计
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd?: number;
  };
}
```

实现方式：Soul 在 `runSoulTurn` 内部累加每个 step 的 Kosong API response.usage，通过 TurnResult 传给 SoulPlus，SoulPlus 写入 turn.end。cancel/error 时也报已消耗的部分 usage。

**`tool.call` 新增字段**（决策 #98 / Tool UI 渲染契约）：

```typescript
tool.call {
  id: string;
  name: string;
  args: Record<string, unknown>;  // 对齐附录 B tool_call_dispatched.data.args
  description?: string;           // 人类可读 activity 描述（spinner 旁边），
                                  // 由 Tool.display.getActivityDescription(input) 生成（§10.2 / §10.7）
                                  // 示例：
                                  //   Bash → "Running: git status"
                                  //   Read → "Reading src/index.ts"
                                  //   Grep → "Searching for 'TODO' in *.ts"
                                  //   Edit → "Editing src/utils.ts"
  user_facing_name?: string;      // tool 在 UI badge 上的展示名，由 Tool.display.getUserFacingName(input)
                                  // 生成；per-call 动态（如 BashTool 在 sandbox 模式下返回 "SandboxedBash"，
                                  // 在 sed 模式下返回 "Edit"）。决策 #98 / D8。
  input_display?: ToolInputDisplay;  // 入参的结构化渲染 hint（discriminated union, §10.7），
                                     // client 按 kind 分发到对应渲染器；落 wire.jsonl 让 replay 可还原
                                     // UI（决策 #98 / D1-D5）。同时充当 ApprovalRequest.display
                                     // （§12.2 ApprovalDisplay = ToolInputDisplay 收编）。
}
```

参考 cc-remake 的两层架构：Tool 层生成描述（`getActivityDescription()` 方法），UI 层直接使用。决策 #98 把这层 hook 系统化为 `Tool.display: ToolDisplayHooks` 字段并扩展到 input/result/progress/collapsed/userFacingName 6 个 hook，详见 §10.2 / §10.7。

**`tool.result` 新增字段**（决策 #98 / Tool UI 渲染契约）：

```typescript
tool.result {
  tool_call_id: string;
  output: unknown;                    // 既有：给 LLM 看的内容
  is_error?: boolean;                 // 既有
  result_display?: ToolResultDisplay; // 结果的结构化渲染 hint（§10.7），client 按 kind 分发；
                                      // 落 wire.jsonl 让 replay 可还原。
                                      // EditTool / WriteTool 的 diff 类 result_display
                                      // 由 SoulPlus 的 ToolCallOrchestrator 在 approval/display
                                      // 阶段统一计算并复用（决策 #98 / D4）。
  collapsed_summary?: string;         // 折叠态一行摘要（transcript collapsed 视图、history 列表用），
                                      // 由 Tool.display.getCollapsedSummary(input, result) 生成；
                                      // 默认 fallback 为 description（getActivityDescription）。
                                      // 决策 #98 / D3 选择 string 形态，Phase 2 视需要升级结构化。
}
```

**`tool.progress` 新增字段**（决策 #98）：

```typescript
tool.progress {
  tool_call_id: string;
  update: ToolUpdate;                  // 既有
  progress_description?: string;       // 人类可读的本次 progress 文字描述（如 "Compiling..."）；
                                       // 由 Tool.display.getProgressDescription(input, update) 生成，
                                       // tool 自决频率（return undefined 跳过 emit，避免每个 stdout
                                       // chunk 都算 description）。决策 #98 / D7。
                                       // 仅 EventSink 推送，不落 wire.jsonl。
}
```

> **悬空字段澄清**：v2 初稿 §3.6.1 注释里提到的"`description` 由 Tool 实现层的 `getActivityDescription()` 生成"在旧版 Tool 接口中**没有对应方法**——是悬空字段。决策 #98 把这一层契约系统化补全：所有 display hook 集中在 `Tool.display: ToolDisplayHooks`（§10.2 扩展），调用时机和落盘策略集中在 §10.7（"Tool UI 渲染契约"节），具体实现可在每个内置 tool 内逐步补齐（详见附录 E 内置 Tool Schema 与 §20.1 必做清单）。

**`session.error` 新增字段**：

```typescript
session.error {
  error: string;                         // 人类可读的错误描述
  error_type?: "rate_limit"              // API 限流
    | "context_overflow"                  // context 超限（自动 compaction + retry 失败后才 surface，见决策 #96）
    | "api_error"                         // 其他 API 错误
    | "auth_error"                        // 认证失败
    | "tool_error"                        // 工具执行错误
    | "internal";                         // 内部错误
  retry_after_ms?: number;               // rate_limit 时告诉 UI 多久后重试
  details?: unknown;                     // 额外错误上下文
}
```

参考 cc-remake：rate limit 时 UI 显示倒计时（cc 用 30s 心跳分块 yield，v2 用 retry_after_ms 一次性告知）。

**context overflow 的恢复路径**（决策 #96 修订旧措辞"Kosong 调整 max_tokens 重试"，那是错的——`max_tokens` 是 output 上限，无法解决 input overflow）：
- Kosong 在 `chat()` 内部检测到 input overflow（含 silent overflow：`usage.input + usage.cache_read > contextWindow`），抛 `ContextOverflowError`（继承 §10 / 附录 D 错误层级）
- TurnManager 在 `startTurn` 的 try/catch 中捕获 `ContextOverflowError` → 调 `executeCompaction(reason: "overflow")`（与决策 #93 的 `needs_compaction` 路径合流）→ 重启 Soul 接续同一 turn_id
- `MAX_COMPACTIONS_PER_TURN = 3`（与 #93 共享熔断器）—— 超过则 emit `session.error(error_type: "context_overflow")` + `turn_end(reason: "error")`
- 成功用户无感（看到 `compaction.begin` / `compaction.end` 事件）；`max_output_tokens` 截断属另一个维度（Phase 2，不做 escalate / 续写——follow Python 版策略）

**`subagent.spawned` / `subagent.completed` / `subagent.failed`（三个生命周期 record）**：

v2 不再把子 agent 的事件嵌套包装进父 wire（旧 `subagent.event` 方案已废弃，详见决策 #88 与 §8.2）。父 wire 只记录子 agent 的**生命周期引用**，子 agent 的完整事件流独立落盘到 `sessions/<session_id>/subagents/<agent_id>/wire.jsonl`，父子关系通过 record 里的 `parent_agent_id` 字段重建（支持递归 subagent）。

```typescript
// 子 agent 被创建（由父 Soul 的 AgentTool 发起 spawn 后写入父 wire）
subagent.spawned {
  agent_id: string;                    // 子 agent 的唯一 id，对应 subagents/<agent_id>/ 目录
  agent_name?: string;                 // 人类可读名，"researcher"（UI badge 展示用）
  parent_tool_call_id: string;         // 发起 spawn 的 tool_call id
  parent_agent_id?: string;            // 递归场景：谁创建了我（主 agent 不填，仅子 agent 再 spawn 子 agent 时填）
  run_in_background: boolean;          // foreground（AgentTool await 结果）vs background（发 notification）
}

// 子 agent 正常完成
subagent.completed {
  agent_id: string;
  parent_tool_call_id: string;
  result_summary: string;              // 回传给父 agent 的聚合文本（Task tool 的 result 字段）
  usage?: TokenUsage;                  // 子 agent 累计 token 用量
}

// 子 agent 执行失败
subagent.failed {
  agent_id: string;
  parent_tool_call_id: string;
  error: string;                       // 人类可读的失败原因
}
```

**设计说明**：

- **父 wire 只记录生命周期**：三个 record 只是"引用"，不含子 agent 的任何 step / assistant_message / tool_call 事件——这些都在子 wire 里。
- **实时 UI 推送走 EventBus**：子 agent 的 EventSink 是 wrapper，做两件事：(1) 写入子 wire 持久化；(2) 加 `source` 标记（见 §4.8）转发到 session 共享 EventBus，UI 实时可见。事件自描述身份，UI 免查表即可决定渲染策略。
- **Replay**：读父 wire → 遇到 `subagent.spawned` → 按 `agent_id` 引用打开 `subagents/<agent_id>/wire.jsonl` → 逐层展开（遇到嵌套 subagent 再递归）。也可以直接 `readdir(subagents/)` 全量发现。
- **完成通知**：foreground subagent 由 AgentTool 直接 await `SubagentHandle.completion` 拿结果；background subagent 完成后发 `notification` 到 `wakeQueue`（和其它 background task 同路径）。
- **Crash Recovery**：扫 `subagents/` 目录，找有 `subagent.spawned` 但无对应 `subagent.completed` / `subagent.failed` 的 → 按 §8.2 / §9 的 dangling 修复路径处理。

**`team_mail`（新增事件类型）**：

```typescript
team_mail {
  mail_id: string;         // 全局唯一消息 ID
  reply_to?: string;       // 回复哪条消息的 mail_id（可选，不回复时为 null）
  from_agent: string;      // 发送方 agent name
  to_agent: string;        // 接收方 agent name
  content: string;         // 消息内容
  summary?: string;        // 5-10 字预览（LLM 生成，UI 通知/折叠展示用）
}
```

TeamMail 是 Wire 协议的一部分，但标注为 **soul-to-soul 通信**事件，一般不用于 soul-ui 通信。用于 agent team 成员之间的异步消息传递，通过 SQLite 消息总线路由（见 §8.3）。

#### 3.6.2 有始有终原则（事件对称性审计）

v2 所有过程性事件的对称性保证：

| 开始 | 正常结束 | 异常终止 | 备注 |
|------|---------|---------|------|
| `turn.begin` | `turn.end` | `turn.end`（reason: "cancelled"\|"error"） | 始终成对 |
| `step.begin` | `step.end` | `step.interrupted` | 有且仅有一个终结事件 |
| `compaction.begin` | `compaction.end` | — | |
| `tool.call` | `tool.result` | — | 命名不同但语义配对 |
| `hook.triggered` | `hook.resolved` | — | |

一次性事件（无需对称）：`content.delta`、`tool.call.delta`、`tool.progress`、`mcp.loading`（三态字段 status，一个事件表达完整生命周期）、`notification`、`team_mail`、`plan.display`、`status.update`、`session.error`、`session.ownership_lost`、各种 `*.changed` 事件。

**关于"异常终止"列的 `—`**：上表中 `compaction` / `tool.call` / `hook.triggered` 三行的"异常终止"列写 `—`，不是缺项，而是这些事件**没有独立的异常终结事件**——异常语义通过正常结束事件的字段表达，具体是：

- `compaction.end`：压缩失败通过 `turn.end(reason:"error")` 或 `session.error` 表达；`compaction.end` 本身只携带 `tokensBefore? / tokensAfter?`，summary 由 `CompactionRecord` 持久化，需要时从 wire.jsonl 读。`compaction` 本身不会"半途抛异常"被 UI 看见（失败时 SoulPlus 直接把 turn 终结）
- `tool.result`：通过 `is_error: true` 表达 tool 异常终结（包括取消、timeout、用户拒绝、tool 内部抛错），永远成对，不需要单独的 `tool.interrupted`
- `hook.resolved`：通过 `action` 字段（`"block"` / `"warn"` / `"allow"`）+ `reason` 表达 hook 的拒绝/失败路径，同样永远成对

### 3.7 事件是否都进 `wire.jsonl`

**不是所有事件都落盘**。原则：**只落盘"能还原状态"和"需要给 UI replay"的事件**。

| 必须落盘（用于 replay + 状态还原） | 不落盘（瞬时状态） |
|---|---|
| `turn.begin` / `turn.end` | `tool.call.delta`（只是 streaming 增量，最终被 `tool.call` 完整体盖住） |
| `assistant_message`（合并 `content.delta` 后落盘，不落 raw delta） | `content.delta`（raw 流式片段不落盘） |
| `tool.call` / `tool.result` | `tool.progress`（工具执行中的流式进度，EventSink `tool.progress` 的 Wire 映射，不影响状态） |
| `compaction.begin` / `compaction.end` | `mcp.loading`（UI 提示，不影响状态） |
| `system_prompt.changed` / `model.changed` / ... | `hook.triggered` / `hook.resolved`（用调试日志即可） |
| `subagent.spawned` / `subagent.completed` / `subagent.failed`（父 wire 只记生命周期，子 agent 完整事件流在 `subagents/<id>/wire.jsonl`） | `plan.display`（只是 UI 渲染） |
| `session.ownership_lost` | `status.update`（从 ContextState 随时可重建） |
| **`notification`**（见下方说明） | |

**Notification 落盘说明**（参考 kimi-cli 设计）：

所有 notification 都落盘为 `NotificationRecord`，且 `NotificationRecord` 已经归入 **ContextState 管理的 durable 对话事件**（见 §4.3 / §4.5.2）。原因：
1. `targets: ["llm"]` 的通知必须作为对话事件永久留在 transcript 中——LLM 在 Turn N 看到通知并基于通知内容作答后，Turn N+1 必须仍然能看到这条通知，否则 assistant 的引用会出现因果断裂（"基于 Task X 的结果..." 但上下文里没有任何关于 Task X 的内容）
2. 背景任务完成、错误警告等是会话审计历史的一部分，UI replay 时需要还原"当时发生了什么"
3. 对应 kimi-cli 的 `NotificationStore`（`~/.kimi/notifications/{id}/event.json`）

`targets` 字段控制分发路径（顺序对齐 §4.3 `NotificationRecord.targets` canonical `llm/wire/shell`）：
- `"llm"` → 通过 `ContextState.appendNotification` 做 durable 写入，`NotificationRecord` 进 transcript；下次 `ConversationProjector.project(snapshot)` 时被自然组装为系统消息进 LLM 输入。因为 `appendNotification` 本身就会走 `JournalWriter` 落盘一行 `notification` wire record，`targets: ["llm"]` 单独存在即已完成持久化——不需要再额外走一次审计路径
- `"wire"` → 立即 emit `notification` event 到客户端 UI（EventBus / EventSink 路径）
- `"shell"` → 触发 server-side hook（终端弹出）

细节：`content.delta` 和 `tool.call.delta` 是流式片段，在 turn 内部会被合并成完整的 `assistant_message`（含 text + tool_calls），**合并后的完整消息落盘一条记录**。这和 forge 的写前日志（write-ahead）模式一致——在工具执行前，assistant 消息已经写入 wire，任何崩溃都不会丢失 LLM 响应。

---

## 四、存储模型（关键变更）

### 4.1 从三文件到两文件

v1（沿袭 Python kimi-cli）：
```
sessions/<session_id>/
├── context.jsonl    # 对话消息（发给 LLM 的 message）
├── wire.jsonl       # 事件流（给 UI 的事件）
└── state.json       # 状态快照（plan mode, title, ...）
```

v2：
```text
sessions/<session_id>/
├── wire.jsonl       # append-only，唯一持久化真相源
└── state.json       # SessionMetaService 维护的内存视图异步快照（决策 #113）：
                     # title / tags / last_model / turn_count / last_updated / last_exit_code 等。
                     # 详细字段语义与一致性策略见 §4.4 / §6.13.7
```

### 4.1.1 wire.jsonl 版本管理

wire.jsonl 的第一行是 **metadata header**（不是 WireRecord，是独立的元数据）：

```json
{"type": "metadata", "protocol_version": "2.1", "created_at": 1712790000000, "kimi_version": "1.0.0"}
```

```typescript
const WireFileMetadataSchema = z.object({
  type: z.literal("metadata"),
  protocol_version: z.string(),       // "2.1"
  created_at: z.number(),             // Unix 毫秒时间戳
  kimi_version: z.string().optional(),// "1.0.0"（生成此文件的 Kimi CLI 版本）
});
```

**Replay 逻辑**：

```typescript
function replayWire(filePath: string): WiredContextState {
  const lines = readLines(filePath);

  // 1. 第一行：metadata header
  const meta = WireFileMetadataSchema.parse(JSON.parse(lines[0]));
  const [major] = meta.protocol_version.split(".");

  // 2. 版本兼容性检查
  if (parseInt(major) > SUPPORTED_MAJOR_VERSION) {
    throw new IncompatibleVersionError(
      `wire.jsonl version ${meta.protocol_version} is not supported. Please upgrade Kimi CLI.`
    );
  }
  // minor 版本差异：继续读取，未知字段/类型跳过

  // 3. 后续行：WireRecords
  const state = new WiredContextState();
  const bodyLines = lines.slice(1);
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const isLastLine = i === bodyLines.length - 1;
    try {
      const record = parseWireRecord(line);
      state.apply(record);
    } catch (e) {
      // 行号回算（统一使用「文件物理行号」口径，从 1 开始计数）：
      //   bodyLines 从 i = 0 开始，对应的文件物理行号 = i + 2
      //   （+1 是 bodyLines 相对于 lines 的 offset，再 +1 因为第 1 行是 metadata header）
      // 下面 warn / throw 全部使用 `line ${i + 2}` 这一文件物理行号口径
      if (e instanceof UnknownRecordTypeError) {
        // D13/决策 #56：未知 record type（新版本产生、旧版本不认识）→ skip + warn
        logger.warn(`Skipping unrecognized record type at line ${i + 2}: ${line.substring(0, 100)}`);
        continue;
      }
      if (isLastLine && e instanceof JsonParseError) {
        // 最后一行 JSON.parse 失败 = 崩溃时半写 line 截断 → 允许 skip（append-only 的天然
        // 容错点，因为写 \n 之前进程被杀，留下半行）
        logger.warn(`Tail line truncated, skipping: ${line.substring(0, 100)}`);
        continue;
      }
      // 中间行 JSON.parse 失败 → session 进入 broken 健康标记（D13）
      // broken 是和 lifecycle 正交的健康标记；只允许 session.list / session.destroy，
      // 其它对话类操作在 broken 下一律禁止。这里抛出让上层 SessionManager 捕获并打标
      throw new WireJournalCorruptError(
        `wire.jsonl 中间行损坏（line ${i + 2}），session 不可继续：${String(e)}`,
      );
    }
  }
  return state;
}
```

**错误分类**（和 §9.4 / D13 对齐）：
- **未知 record type**（版本兼容）：任意行都 skip + warn，session 继续可用
- **最后一行截断**（崩溃时半写）：只有最后一行的 JSON.parse 失败允许 skip + warn，session 继续可用
- **中间行 JSON.parse 失败**（文件损坏）：session 被标记为 `broken`（健康标记，和 lifecycle 状态机正交），只允许 `session.list`（返回时必须带 broken 标记）和 `session.destroy`（强制删除），其它对话类操作一律禁止

**版本号规则**：
- **minor bump**（2.1 → 2.2）：新增可选字段、新增 record type → 向后兼容，旧版本 skip + warn
- **major bump**（2.x → 3.0）：修改必填字段语义、删除 record type → 不向后兼容，旧版本报错提示升级

**compaction 轮转后**：新 wire.jsonl 第一行是 metadata（带当前 protocol_version），第二行是 CompactionRecord。归档的 wire.N.jsonl 保留原始 metadata。

### 4.2 为什么 merge

讨论里的原话：
> "其实这个可以完美代替上面这个，wire 可以完美代替 context"
> "就像各种数据库它的日志一样，它是一个变化记录"
> "搞两套状态机的话会很炸了"

本质上是把 `wire.jsonl` 当成**数据库的 Write-Ahead Log**：
- 所有状态变更都追加成事件
- 内存状态是 WAL replay 的结果
- 存档 = 持久化 WAL，恢复 = replay WAL

这个设计有三个关键好处：
1. **消除双状态机**：context 和 wire 不会不一致
2. **编辑能力天然存在**：要改 system prompt？append 一条 `system_prompt_changed` record（Wire 事件侧的名字是 `system_prompt.changed`，record type 用 snake_case）就行，崩溃/重启后 replay 依然能还原
3. **Fork / replay 简单**：从文件读到某个 turn，然后停止

### 4.3 wire.jsonl 的记录类型

```typescript
// 所有 wire.jsonl 行都是一个 WireRecord
// 具体字段 schema 见附录 B；下面的 union 用于让 `Extract<WireRecord, {type: ...}>`
// 在 §4.6 SessionJournalRecord 等位置的 TypeScript 类型运算能够正确工作。
type WireRecord =
  | TurnBeginRecord
  | TurnEndRecord
  | UserMessageRecord      // 用户输入
  | AssistantMessageRecord // LLM 完整响应（text + tool_calls）
  | ToolResultRecord       // 工具执行结果
  | CompactionRecord       // 压缩前后摘要
  | SystemPromptChangedRecord
  | ModelChangedRecord
  | ThinkingChangedRecord
  | PlanModeChangedRecord
  | ToolsChangedRecord
  | PermissionModeChangedRecord  // 运行时 permission mode 切换
  | SystemReminderRecord   // 一次性 reminder，作为 durable 对话事件进 transcript（ContextState 管理）
  | NotificationRecord     // 通知事件（含背景任务完成），作为 durable 对话事件进 transcript（ContextState 管理）
  | SubagentSpawnedRecord   // subagent 被创建（父 wire 生命周期引用）
  | SubagentCompletedRecord // subagent 正常完成（父 wire 生命周期引用）
  | SubagentFailedRecord    // subagent 失败（父 wire 生命周期引用）
  | SkillInvokedRecord     // skill 被调用
  | SkillCompletedRecord   // skill 执行完成/失败
  | ApprovalRequestRecord  // 审批请求发起
  | ApprovalResponseRecord // 审批响应
  | TeamMailRecord         // agent team 成员间消息
  | ToolCallDispatchedRecord   // tool call 派发（permission gate 后、execute 前）
  | ToolDeniedRecord       // tool call 被拒（permission/approval 拒绝）
  | OwnershipChangedRecord
  | ContextEditRecord;     // v2 预留：第一阶段不写入
```

`NotificationRecord` 字段结构（对应 kimi-cli `NotificationEvent`）：

```typescript
interface NotificationRecord {
  type: "notification";
  data: {
    id: string;                          // 格式: n + 8位hex（同 kimi-cli）
    category: "task" | "agent" | "system" | "team";  // "team" 用于 team mail / teammate 相关通知（见 §8.3.3）
    type: string;                        // e.g. "task.succeeded", "task.failed"
    source_kind: string;                 // e.g. "background_task"
    source_id: string;
    title: string;
    body: string;
    severity: "info" | "success" | "warning" | "error";
    payload?: Record<string, unknown>;
    targets: Array<"llm" | "wire" | "shell">;
    dedupe_key?: string;                 // 相同 key 只处理一次
    delivered_at?: number;              // ack 时间（replay 时跳过已 ack 的 llm 注入）
    envelope_id?: string;               // 决策 #103：仅当通知由 team mail envelope 转入时填写（= MailEnvelope.envelope_id）；
                                        // 本地产生的通知不填。用于 §9.4.1 启动恢复阶段的 envelope-level 幂等去重——
                                        // 扫描 SQL status='delivered' 的 envelope_id，去 wire index 查；查不到则重新 emit。
  };
}
```

每条 WireRecord 在信封层都携带 `seq`（JournalWriter 分配，单调递增）和 `time`（写入瞬间的 Unix 毫秒）；其余字段由 record type 决定——多数管理类 record 带 `turn_id`（部分还带 `step` 或 `agent_type`），`data` 子对象的形状因 record 而异。完整 schema 以 **附录 B** 为准，本节 union 只是示意性索引。

### 4.4 state.json 的职责

**state.json 是 SessionMetaService 维护的内存视图的异步快照**，主要给"不加载 session 就能显示 session 列表"的场景服务（`session.list` 直接 `readdir` + 读 state.json，不 replay wire.jsonl）：

```json
{
  "session_id": "ses_xxx",
  "title": "Fix the auth bug",
  "created_at": 1712790000000,
  "last_updated": 1712793600000,
  "last_model": "moonshot-v1",
  "turn_count": 12,
  "tags": ["work", "urgent"],
  "last_exit_code": "clean"
}
```

**字段三类语义**（决策 #113 / D1）：

| 类别 | 字段 | 真相源 | 写入触发 |
|---|---|---|---|
| **wire-truth** | `title` / `tags` / `description?` / `archived?` / `color?` | wire `session_meta_changed` record | `session.rename` / `session.setTags` 等 wire method（同步事务） |
| **derived** | `last_model` / `turn_count` / `last_updated` | replay wire.jsonl 完整重建 | SessionMetaService 订阅 `model.changed` / `turn.end` 等 EventBus 事件聚合更新 |
| **runtime-only** | `last_exit_code` | 进程 lifecycle | SessionLifecycle 在 shutdown 时直接覆写（决策 #75） |

**单一写者**：除 `last_exit_code` 由 SessionLifecycle 在 shutdown 时直接覆写外，其余字段全部由 **SessionMetaService**（services facade 的组件，§6.13.7）统一写入。SessionMetaService 通过 200ms debounced flush 合并 turn.end / model.changed 等高频事件触发的 derived 字段更新；flush 时把 SessionLifecycle 缓存的 `last_exit_code` 透传以避免覆盖。无并发写者。

**state.json 与 wire.jsonl 的一致性策略**（决策 #113 / D7，与决策 #75 协同）：

- **clean exit + state.json 完整** → 启动时直接信任 state.json（快路径）
- **dirty exit / state.json 缺失或损坏** → 进入 §9.7 的 SessionMeta 重建子阶段，从 wire.jsonl replay 修正：扫描所有 `session_meta_changed` 按 seq 顺序合并 patch（覆盖 wire-truth 字段），数 `turn_begin` 得 `turn_count`，取最后一条 `model_changed` 得 `last_model`，取 wire 最后一条 record 的 `time` 得 `last_updated`

理论上 state.json 任何时刻删除都能从 wire 完整重建——wire.jsonl 仍是唯一持久化真相源。state.json 只是查询索引 + clean exit 快路径，不是独立的真相源。

### 4.5 对话状态：ContextState

#### 4.5.1 ContextState 的双重身份

ContextState 是"对话状态的权威内存副本 + 状态类 record 的 WAL 写入网关"的统一体。

它负责所有"会被 LLM 看到"的 durable 写入，具体覆盖 `user_message` / `assistant_message` / `tool_result` / `config_change` / `summary_reset` / `notification` / `system_reminder`（以及未来的 `memory_recalled`）这几类 record。这里的判定原则是单一的：**一条 record 是否会被 `ConversationProjector.project(snapshot)` 组装进 LLM 的 message[]**——是的话就归 ContextState；否则走 SessionJournal。

管理/审计类 durable record（`turn_begin` / `turn_end` / `approval_*` / `team_mail` / `subagent_spawned` / `subagent_completed` / `subagent_failed` / `tool_call_dispatched` / `tool_denied` / `permission_mode_changed` / `hook_event` 等）**LLM 完全看不到**，它们走并列的 `SessionJournal` 窄门。两者底层共享同一个 `JournalWriter`，后者是 `wire.jsonl` 的唯一物理 ordering point。

> 历史说明：v2 初稿曾把 `notification` / `system_reminder` 划归 SessionJournal，read 侧由 `ConversationProjector` 通过 `ephemeralInjections` 一次性注入 LLM 输入，不进入 transcript。这违反了"上下文是 append-only 的事实记录、LLM 看过的就是事实、事实不能凭空消失"原则——会造成 Turn N 看到 notification 并基于它作答、Turn N+1 上下文里没有任何关于该 notification 的内容、assistant 引用时出现幻觉的因果断裂。Phase 6E 撤销该设计，notification / reminder 改为 ContextState durable 写入，详见决策 #82（已撤销）和决策 #89。

按本轮定稿口径，`wire.jsonl` 是 **session 对话状态与会话审计记录** 的唯一持久化真相源；transport/runtime coordination state 有各自受限真相源与恢复策略，`state.json` 只是派生缓存。ContextState 管的是其中"会改变对话投影"的那一半，审计/lifecycle/协作类 record 则交给 SessionJournal。

Soul 和 SoulPlus 都操作同一个 ContextState 实例，但**看到的接口不同**（下一节详述）。这种"同实例、窄视图"的模式是 Soul/SoulPlus 边界的物理载体：Soul 不是拿到一份 ContextState 的拷贝，而是拿到同一份数据的**类型收窄引用**。

一句话对比：cc-remake 把 `messages` 数组的维护放在 `QueryEngine`，把 JSONL 写入放在另一个 `TurnLog` 组件，两者之间靠调用顺序约束同步；v2 则把"状态类 record 的内存投影"与"统一 ordering point"收敛到 `ContextState + SessionJournal -> JournalWriter` 这条链上，Soul 看不见也无法绕开这个约束。

#### 4.5.2 双接口拆分：SoulContextState 和 FullContextState

这是核心设计。Soul 通过窄接口 `SoulContextState` 访问状态；SoulPlus 通过宽接口 `FullContextState` 访问——后者继承前者并加上 SoulPlus 独占的写方法。

```typescript
// ─── Soul 看到的窄视图 ───
// Soul 能调用的读写方法都在这里；buildMessages 的具体实现内部委托 ConversationProjector。
interface SoulContextState {
  // ─── 读方法（同步） ───
  buildMessages(): Message[];
  readonly model: string;
  readonly activeTools: ReadonlySet<string>;
  readonly systemPrompt: string;
  readonly tokenCountWithPending: number;  // compaction 检测用，**默认开启** —— 含 pending tool result 的估算（决策 #96 / Python 1.27 教训）

  // 从瞬时 buffer drain 出 steer（调用后 buffer 清空）
  drainSteerMessages(): UserInput[];

  // ─── 增量 compaction 状态（决策 #96 新增；Soul 检测时不需要，但 TurnManager.executeCompaction 要用——
  //     放在 SoulContextState 而不是 FullContextState 是因为这是"读历史"语义，不是 SoulPlus 独占写） ───
  // 读最近一次 compaction 的 summary record（如果有）。用于增量 summary 模板。
  getLastCompactionSummary?(): SummaryMessage | undefined;
  // 从最近 SummaryMessage.fileOperations 起 + 当前 history 中所有 read/write/edit toolCall 累加。
  // 实现需要 ContextState 持有"对哪些 tool name 算 file op"的策略（默认认 Read / Write / Edit）。
  getCumulativeFileOps?(): { readFiles: string[]; modifiedFiles: string[] };

  // ─── 写方法（async，必须 await；都对应状态类 durable record；全部 append-only） ───
  appendAssistantMessage(msg: AssistantMessage): Promise<void>;
  appendToolResult(toolCallId: string, result: ToolResult): Promise<void>;
  addUserMessages(steers: UserInput[]): Promise<void>;
  applyConfigChange(event: ConfigChangeEvent): Promise<void>;
  // 注意：resetToSummary 不在 SoulContextState 视图——它是 reset 语义（compaction 后重置 history），
  // 由 SoulPlus 的 TurnManager 在 executeCompaction 里调用，归属在 FullContextState 上。
  // Soul 写 ContextState 的语义全是 append-only，不持有 reset 能力（参见铁律 7 / 决策 #93）。
}

// ─── SoulPlus 看到的全视图 ───
// 继承 Soul 视图，并暴露 SoulPlus 独占的写方法。
interface FullContextState extends SoulContextState {
  // 把用户的原始输入写进 context（SoulPlus 独占，Soul 看不到这个符号）
  appendUserMessage(input: UserInput): Promise<void>;

  /**
   * append 一条系统注入的 user-meta message，与普通 user 输入区分。
   * 用于 SkillInlineWriter（§15.11）注入 skill prompt + `<kimi-skill-loaded>` tag。
   * 投影到 LLM 时仍是 user role，但 export/import/replay 路径会过滤掉 isMeta=true 的消息。
   */
  appendUserMessageMeta(input: UserInput, options?: { tag?: string }): Promise<void>;

  // compaction 专用：执行完 compactionProvider.run 后由 TurnManager.executeCompaction 调用，
  // 把整个 history 重置为 summary 序列。这是唯一的 reset 语义写方法，与 Soul 视图里的
  // append-only 写方法形成对照。
  resetToSummary(summary: Message[]): Promise<void>;

  // ─── 以下是 SoulPlus 服务层（NotificationManager 等）独占的 durable 写入 ───
  // notification / system reminder / memory recall 都是"LLM 能看到的内容"，
  // 必须进 transcript，不能走 ephemeralInjections 的临时注入路径。
  // Soul 看不到这些方法——它只负责消费 transcript，不负责写入这类事件。
  appendNotification(data: NotificationData): Promise<void>;
  appendSystemReminder(data: SystemReminderData): Promise<void>;
  // Phase 2 预留：memory recall 的 durable 写入（对齐 CC）
  // appendMemoryRecall(data: MemoryRecallData): Promise<void>;
}
```

**关键说明**：

- `SoulContextState` 的写方法全部返回 `Promise<void>`——作为**状态类**写入网关，它做 **三件事**：①构 record → ②`journalWriter.append`（内存 push pendingRecords + 入 disk batch；force-flush kinds 等磁盘 fsync 完成才 resolve，其余几乎立即 resolve，详见 §4.5.4） → ③刷新对话状态投影内存（`history` / `systemPrompt` / `tokenCountWithPending` 等）。三件事组成一个原子序列，中断语义见 §4.5.3。对照之下，`SessionJournal`（§4.6）作为**管理类**写入网关只做 **两件事**：①构 record → ②`journalWriter.append`，**不触碰对话投影内存**——因为 audit / lifecycle / 协作类 record 按 §4.6 铁律不改变 `buildMessages()` 结果，所以不存在"刷新内存镜像"这一步。两者底层共享同一个 `JournalWriter` ordering point，从而复用 seq 分配、串行化、batch drain（含 force-flush 同步 fsync 路径）、lifecycle gate 语义。
- 为什么必须同步 `await`：Soul 下一步 `buildMessages()` 必须看到刚写入的内容。如果写方法是 fire-and-forget，内存状态和 WAL 会出现短暂不一致窗口，Soul 读到的 history 会缺条。
- `FullContextState extends SoulContextState`：唯一的实现类 `WiredContextState`（见 §4.5.5）实现 `FullContextState`，SoulPlus 在调 `runSoulTurn` 时把它作为 `SoulContextState` 传进去，TypeScript 自动收窄类型，Soul 在类型层面看不到 `appendUserMessage` 或任何 SessionJournal 能力。
- `appendUserMessage` 只能由 SoulPlus 调——因为"用户输入从哪来"本身是 SoulPlus 的责任（turn 触发 / steer / 嵌入方手动 push）。Soul 只负责消费用户输入，不负责写入。
- Notification / system reminder / memory recall 是"LLM 能看到的内容"，一律走 ContextState 的 durable 写入（`appendNotification` / `appendSystemReminder` / 未来的 `appendMemoryRecall`）。这些方法只存在于 `FullContextState` 上，Soul 看到的 `SoulContextState` 窄视图**没有**它们——Soul 不被允许自己写 reminder / notification（写入来源是 NotificationManager 这类 SoulPlus 服务层组件）。Soul 读到它们的唯一路径是 `buildMessages()`：Projector 从 snapshot 把这些 record 组装进 Message[]，和 `user_message` / `assistant_message` 并列。**历史说明**：v2 初稿曾通过 `TurnManager.pendingNotifications` turn-scope 缓冲 + `ConversationProjector.ephemeralInjections` 读侧注入实现"一次性注入"；该方案违反"上下文是 append-only 的事实"原则（Turn N 看到了但 Turn N+1 看不到，造成因果断裂），Phase 6E 撤销，见决策 #82 / #89。
- `drainSteerMessages` 归在读方法里（同步），但副作用是清空 buffer。它只处理 turn 内 steer 这类瞬时输入，不承担审计类 record 的 durable 写入。

#### 4.5.3 写方法的原子性语义

每次 ContextState async 写方法（仅限状态类 durable 写入）的完整流程是固定的：

1. **构造 WireRecord**：例如 `{type: "assistant_message", turn_id, step, seq, content, ...}`，seq 由 JournalWriter 同步分配。
2. **调 `journalWriter.append(record)`**：内部完成两件原子动作——(a) 把 record push 进 `pendingRecords` 内存缓冲（**内存可见**：后续任何 `buildMessages()` 立即能看到）；(b) 把 record 入 disk batch 队列、必要时 `scheduleDrain()`。`append` 的 Promise 几乎立即 resolve（见 §4.5.4 的 `forceFlushKinds` 例外）。
3. **journalWriter 成功后**，同步更新对话状态投影内存（push 新消息 / 刷新 `tokenCountWithPending` / 更新 `systemPrompt` 等字段）。
4. **return**。

这个顺序的核心保证是**"内存可见 + WAL 入队"原子化**——不再要求"磁盘 fsync 完成才返回"：

- 如果步骤 2 同步失败（lifecycle gate 拒绝抛 `JournalGatedError`、内存 OOM 等），内存投影不变，错误冒泡到 Soul，TurnManager 决定怎么处理。
- 如果步骤 2 成功但进程在步骤 3 之前崩溃：`pendingRecords` 已在内存里——但内存随进程一起死了；磁盘 batch 是否已落盘取决于崩溃时刻是否赶上 drain 窗口（Phase 1 默认 `drainIntervalMs=50ms`，最坏丢 50ms 内累计写入）。**force-flush kinds**（`approval_response` / `turn_end` / `subagent_completed` / `subagent_failed`，见 §4.5.4）是例外——它们的 `append` 触发立即 drain 并等磁盘完成才 resolve，永不丢失。
- **磁盘异步 drain 失败**（ENOSPC / EIO 等）走 `JournalWriter.onPersistError` hook + `journal.write_failed` telemetry 事件，由 SoulPlus 决策是否把 session 标记 `broken`（见 §9.4）；为简化恢复路径，drain 失败不回滚已 push 的内存（依赖 `broken` 标记后 session 不再服务请求来兜住"内存与磁盘不一致"的窗口）。
- 写入顺序保证了 crash 恢复时的语义：未 drain 到磁盘的 record 等价于"从未写入"，由 §9.x 矩阵的"按 owner 补 synthetic record"路径兜住——**这与旧版"磁盘 fsync 完成才返回"在恢复路径上等价**，仅丢失窗口从"几乎零"扩到"≤ drainIntervalMs"。

> **内存可见 vs 磁盘可见**：v2 的"写完立即能读到"指**同进程内存可见**——任何后续 `buildMessages()` 立即能看到 `pendingRecords` 里的新 record；磁盘可见由 §4.5.4 的批量 drain 在 `drainIntervalMs` 内异步达成。这是 CC 路线（性能优先，drain 100ms）和 pi-mono 路线（每条 `appendFileSync` 同步）之间的折中。Replay 视 wire.jsonl 为 canonical source——pendingRecords 是运行时投影，不参与 replay；新 wire client（reconnect / replay JSON-RPC）若需要"最新事件"，调 `journalWriter.flush()` 等 drain 完再 serve。

这就是为什么 Soul 仍然需要 `await` 每次写方法：`await` resolve 后，`pendingRecords` 已含这条新 record，`buildMessages()` 必能看到。Soul 的下一步推理建立在"上一步写入已经在内存里、且 WAL 入队成功（磁盘异步追赶）"的前提上。管理类 record 走 `SessionJournal` 时复用同一条 `JournalWriter.append(...)` 顺序化语义，但不会改动 `buildMessages()` 依赖的对话投影内存。

#### 4.5.4 JournalWriter（ContextState / SessionJournal 的共同下层）

`JournalWriter` 是 `WiredContextState` 与 `WiredSessionJournal` 共享的底层持久化组件，不对 Soul 暴露；SoulPlus 其他 sub-component 也不直接拿 raw `append(record)`，而是分别经由 `ContextState` 或 `SessionJournal` 这两条窄门落盘。它的职责是：

- **wire.jsonl 的唯一物理写入点**：非 compaction 路径的写入统一走 `ContextState.append*` 或 `SessionJournal.append*` → `JournalWriter.append`；compaction 路径的物理文件轮转走 `JournalCapability.rotate`（见 §6.12 / §6.4 `executeCompaction`），但 rotate 内部同样由 `JournalWriter` 实现，只是暴露的接口不同。
- **双层架构（内存先行 + 异步追赶）**：内部维护两层状态——
  - `pendingRecords: WireRecord[]`：内存日志，`append` 调用瞬间 push、立即可读；`buildMessages()` 等读路径直接从这里读最新条目。
  - `diskWriteQueue`：磁盘批量队列，由后台定时 drain（`drainIntervalMs` 默认 50ms）异步落盘。
- **批量化策略**（Phase 1 默认值）：
  | 参数 | 默认 | 触发条件 |
  |---|---|---|
  | `fsyncMode` | `"batched"` | 整批 drain 后做一次 `fdatasync` |
  | `drainIntervalMs` | 50 ms | 定时器到期触发 drain（比 CC 的 100ms 更短，平衡丢失窗口和用户感知） |
  | `maxBatchRecords` | 64 | 单次 drain 一批的硬上限，超过即立即切片写 |
  | `maxBatchBytes` | 1 MB | 同上 |
  | `forceFlushKinds` | 见下方 | 命中即跳过定时器、立即 drain，并等磁盘 fsync 完成才 resolve |
  - `per-record` fsync 模式作为备选保留——给"调用即落盘"的 SDK 嵌入方使用，与旧 v2 spec 的 `AsyncSerialQueue 串行 fsync` 等价。
- **force-flush kinds（Phase 1 名单）**：`{ approval_response, turn_end, subagent_completed, subagent_failed }`。这四类 record 是 §9.x 恢复矩阵的"边界证据"，丢失会让恢复路径误判（approval 误以为 cancelled、turn dangling 误补 synthetic、子 session 终态丢失父侧反复探测）。`assistant_message` / `tool_result` / `notification` / `system_reminder` / `team_mail` / `tool_call_dispatched` 不进 force-flush——它们丢失的恢复路径由 §9.3 dangling 修复 + §9.4.1 envelope-level 幂等兜住；`user_message` 也不进 force-flush（紧跟 LLM 调用，drain 在网络等待期内自然完成）。
- **串行化保证**：`pendingRecords` 的 push 顺序就是 FIFO 顺序，seq 由 JournalWriter 同步分配；drain 也按 FIFO 一批批 flush。对外语义是"`append` resolve 时该 record 已在内存可见且已入 disk batch"——除 force-flush kinds 外，**不再**要求 fsync 完成。
- **LifecycleGate 集成**：当 session lifecycle 状态为 `"compacting"` 时，JournalWriter 拒绝非 compaction 相关的写入（抛 `JournalGatedError`），写入者被阻塞或中断。lifecycle 切换由 SoulPlus 的 `SoulLifecycleGate` 控制（见 §6.1 / §6.12.2），但 JournalWriter 是"被 gate 方"，不是 gate 本身。lifecycle gate 拒绝是结构性拒绝，不进 retry。
- **错误处理**：drain 失败按可重试 / 不可恢复分类——
  - 可重试（EAGAIN / EBUSY / 临时 IO）：指数退避，最多 3 次，总等待 < 500ms。
  - 不可恢复（ENOSPC / EROFS / EIO / 文件被外部 unlink）：JournalWriter 进入 degraded 状态，emit `journal.write_failed` telemetry + 回调 `onPersistError(err, record)` hook（双通道：hook 给 SoulPlus 决策、telemetry 给观测）；后续 append 仍同步 push pendingRecords 但 disk queue frozen。SoulPlus 通常会把 session 标 `broken`（§9.4）。
- **崩溃丢失边界**：`drainIntervalMs` 内累计、未 drain 完成的 record 全部丢失（Phase 1 最多 64 条 / 1 MB 数据 / ≤ 50ms 时间窗）。force-flush kinds **永不丢**。
- **新 client 的可见性**：`pendingRecords` 是同进程读路径——跨进程的 wire client（reconnect 后通过 replay JSON-RPC 拉历史）只能读 wire.jsonl 落盘内容，因此处理 replay 请求前 SoulPlus 会主动 `await journalWriter.flush()` 把内存 batch 刷尽，避免"客户端看不到最近 50ms 事件"。

```typescript
type FsyncMode = "batched" | "per-record";

interface JournalWriterConfig {
  fsyncMode: FsyncMode;                                    // 默认 "batched"
  drainIntervalMs: number;                                 // 默认 50
  maxBatchRecords: number;                                 // 默认 64
  maxBatchBytes: number;                                   // 默认 1 MB
  forceFlushKinds: ReadonlySet<WireRecord["type"]>;        // 默认 { approval_response, turn_end, subagent_completed, subagent_failed }
  onPersistError?: (err: unknown, record: WireRecord) => void;
}

interface JournalWriter {
  /**
   * 同步追加：内存可见 + 入 disk batch。
   * - 普通 record（非 forceFlush）：几乎立即 resolve（microtask 级别），磁盘异步追赶
   * - forceFlush record：触发立即 drain，await 磁盘 fsync 完成才 resolve
   * - lifecycle gate 拒绝：抛 JournalGatedError（结构性拒绝，不进 retry）
   *
   * 关键不变量：append 返回（或 resolve）时，pendingRecords 内必有这条 record，
   * 因此 buildMessages() 已能看到。
   */
  append(record: WireRecord): Promise<void>;

  /**
   * 显式 flush：等磁盘队列彻底清空、所有 in-flight drain 结束。
   * 调用点：rotate 前 / graceful shutdown / session.destroy / 处理 replay 请求前 / 测试断言。
   */
  flush(): Promise<void>;

  /**
   * in-memory 视图：给 ContextState / SessionJournal 重建投影、给嵌入方观测、给同进程 replay 路径。
   * 跨进程 client 不能依赖此视图——必须先 flush 再读 wire.jsonl。
   */
  readonly pendingRecords: ReadonlyArray<WireRecord>;

  // compaction 专用：物理文件轮转（详见 §6.12.2 JournalCapability）
  rotate(args: RotateArgs): Promise<void>;

  // 配置只读暴露（用于 telemetry / 健康检查）
  readonly config: Readonly<JournalWriterConfig>;
}
```

**`SessionJournal` 是 1 session 1 实例**——和 v2"一个进程多 session"模型对齐，避免跨 session 故障传播；subagent 各自有独立 wire 文件、独立 JournalWriter 实例，自然分散写入压力（与 Python 版"每个 subagent 独立 session 文件"一致）。

**新 telemetry 指标**：`journal.drain_size`（每批 record 数）/ `journal.drain_latency_ms`（一次 drain 的 fsync 耗时）/ `journal.write_failed`（drain 失败次数）。

#### 4.5.5 两个实现：WiredContextState 和 InMemoryContextState

v2 默认只给两个实现。两个实现都实现 `FullContextState` 接口——区别只在底层是否真的写盘。

- **WiredContextState**（SoulPlus 生产默认）：持有真实 JournalWriter，写方法 append 到 wire.jsonl 并 fsync。是 Core daemon 场景的标准路径。
- **InMemoryContextState**（嵌入 / 单测场景）：内部的 JournalWriter 是 no-op，所有写方法只更新内存，不落盘。第三方嵌入方不需要 wire.jsonl 时用这个。

嵌入场景示例：

```typescript
// ─── 第三方嵌入：完全不用 wire.jsonl ───
const context: FullContextState = new InMemoryContextState({
  model: "gpt-4",
  systemPrompt: "You are a helpful assistant.",
});

// 用户输入通过 FullContextState 上 SoulPlus 独占的写方法写进 context
// （Soul 在类型层面看不到 appendUserMessage，这里是嵌入层的 SoulPlus 视角）
await context.appendUserMessage({ text: "hello" });

// ─── 调用 Soul 时把 context 作为 SoulContextState 传进去 ───
// TypeScript 自动收窄类型，Soul 看不到 appendUserMessage 或任何 SessionJournal 能力
await runSoulTurn(
  { text: "hello" },
  soulConfig,
  context,       // 自动收窄为 SoulContextState
  runtime,
  sink,
  signal,
);
```

嵌入方在"Soul 不知道自己在嵌入环境里"的前提下就完成了接入。Soul 不知道也不关心底层是 WAL 还是纯内存——这正是 Soul 无状态函数铁律（铁律 1）的具体体现——Soul 不持有 wire 实现的任何引用。

`SessionJournal` 的生产/测试双实现见下一小节；它们和 ContextState 一样复用同一个 `JournalWriter` ordering point，但不承担对话状态投影。

### 4.6 SessionJournal：管理类 record 的写入接口

`SessionJournal` 是管理类 record 的 durable 写入窄门，和 ContextState 并列存在。它负责写入不会改变 `buildMessages()` 结果的审计 / lifecycle / 协作事件；底层仍然共享同一个 `JournalWriter`，因此 seq 分配、串行化、WAL 入队（含 force-flush kind 命中的同步 fsync 路径）、lifecycle gate 语义与 ContextState 完全一致。

特别说明：`appendTurnEnd` / `appendApprovalResponse` / `appendSubagentCompleted` / `appendSubagentFailed` 命中 §4.5.4 的 force-flush kinds 名单——它们的 `Promise<void>` 在磁盘 fsync 完成后才 resolve，确保 §9.x 恢复矩阵依赖的"边界证据"零丢失；其余方法走异步 batch drain。

```typescript
type JournalInput<T extends WireRecord["type"]> =
  Omit<Extract<WireRecord, { type: T }>, "seq" | "time">;

type SessionJournalRecord =
  | Extract<WireRecord, { type: "turn_begin" }>
  | Extract<WireRecord, { type: "turn_end" }>
  | Extract<WireRecord, { type: "skill_invoked" }>
  | Extract<WireRecord, { type: "skill_completed" }>
  | Extract<WireRecord, { type: "approval_request" }>
  | Extract<WireRecord, { type: "approval_response" }>
  | Extract<WireRecord, { type: "team_mail" }>
  | Extract<WireRecord, { type: "tool_call_dispatched" }>
  | Extract<WireRecord, { type: "permission_mode_changed" }>
  | Extract<WireRecord, { type: "tool_denied" }>
  | Extract<WireRecord, { type: "subagent_spawned" }>
  | Extract<WireRecord, { type: "subagent_completed" }>
  | Extract<WireRecord, { type: "subagent_failed" }>
  | Extract<WireRecord, { type: "ownership_changed" }>;
// 注意:NotificationRecord / SystemReminderRecord 不在此列 —— 它们是 LLM 能看到的
// durable 对话事件,归 ContextState 管理(见 §4.5.2 FullContextState.appendNotification /
// appendSystemReminder)。Phase 6E 之前曾归 SessionJournal,决策 #82 已撤销,见决策 #89。

interface SessionJournal {
  appendTurnBegin(data: JournalInput<"turn_begin">): Promise<void>;
  appendTurnEnd(data: JournalInput<"turn_end">): Promise<void>;
  appendSkillInvoked(data: JournalInput<"skill_invoked">): Promise<void>;
  appendSkillCompleted(data: JournalInput<"skill_completed">): Promise<void>;
  appendApprovalRequest(data: JournalInput<"approval_request">): Promise<void>;
  appendApprovalResponse(data: JournalInput<"approval_response">): Promise<void>;
  appendTeamMail(data: JournalInput<"team_mail">): Promise<void>;
  appendToolCallDispatched(data: JournalInput<"tool_call_dispatched">): Promise<void>;
  appendPermissionModeChanged(data: JournalInput<"permission_mode_changed">): Promise<void>;
  appendToolDenied(data: JournalInput<"tool_denied">): Promise<void>;
  appendSubagentSpawned(data: JournalInput<"subagent_spawned">): Promise<void>;
  appendSubagentCompleted(data: JournalInput<"subagent_completed">): Promise<void>;
  appendSubagentFailed(data: JournalInput<"subagent_failed">): Promise<void>;
  appendOwnershipChanged(data: JournalInput<"ownership_changed">): Promise<void>;
  // 注意:没有 appendNotification / appendSystemReminder —— 这两类 record 归 ContextState。
}
```

两个实现：

- **WiredSessionJournal**（生产）：构造时注入 `journalWriter: JournalWriter` 引用（实例小写，类型大写），每个 `append*` 方法只负责构造对应 record 并委托到 `journalWriter.append(...)`。
- **InMemorySessionJournal**（嵌入 / e2e 测试）：内部维护 `records: SessionJournalRecord[]` 数组，不落盘；同时提供 `getRecords()` / `getRecordsByType<T>()` / `clear()` 查询方法，便于断言 turn 边界、approval、team mail、permission 变更等审计事件。

```typescript
interface InMemorySessionJournal extends SessionJournal {
  getRecords(): readonly SessionJournalRecord[];
  getRecordsByType<T extends SessionJournalRecord["type"]>(
    type: T,
  ): Extract<SessionJournalRecord, { type: T }>[];
  clear(): void;
}
```

**边界铁律**：SessionJournal 写入的都是审计 / lifecycle / 协作事件，**LLM 完全看不到**——它们是会话的 durable audit trail，不是对话投影本身；例如 `approval_request` / `approval_response` 会影响恢复决策，但永远不作为 LLM 输入消息进入 projector。判定一条 record 归谁的单一原则：**`ConversationProjector.project(snapshot)` 会不会把它组装进 LLM 的 Message[]**——会的话走 ContextState（`user_message` / `assistant_message` / `tool_result` / `config_change` / `notification` / `system_reminder` 等），不会的话走 SessionJournal。

**`notification` / `system_reminder` 不在 SessionJournal**：这两类 record 是 LLM 能看到的 durable 对话事件，由 `FullContextState.appendNotification` / `appendSystemReminder` 负责写入（见 §4.5.2 / §6.6 NotificationManager）。Projector 每次从 snapshot 重新组装它们为系统消息进 LLM 输入。v2 初稿曾把这两类 record 作为 "read-side 一次性注入" 归到 SessionJournal，Phase 6E 撤销，详见决策 #82（已撤销）与决策 #89。

**调用者边界**：`SessionJournal` 接口是 SoulPlus 内部（`TurnManager` / `SkillManager` / `ApprovalRuntime` / `NotificationManager` / `SubagentHost` 等行为与服务组件）直接使用的管理类写入窄门，**Soul 不直接调用 `SessionJournal`**——Soul 对管理类 record 的唯一可触达路径是"通过 `SoulContextState` 的窄面做状态类写入，由 SoulPlus 在外围负责写对应的管理 record"。这也是 §5.0 铁律 3 中"Soul 只允许看到 `SessionJournal` 接口类型、不 import 实现类"的语义前提：接口完整暴露给 SoulPlus，Soul 仅在类型层面可见但不持有任何调用路径。

### 4.7 ConversationProjector：provider-neutral 读侧投影

`ConversationProjector` 是 read-side owner：它把已经恢复为一致状态的 `ContextSnapshot` 投射成 provider-neutral `Message[]`。它只做"读侧拼装"，**单一职责**：纯读 snapshot → 产出 Message[]；不负责恢复修补、不负责 provider 适配、更不负责任何持久化，也**不再接收任何 turn-scope 的临时注入参数**。

```typescript
// ContextSnapshot 是 WiredContextState 按时间顺序投影出的 read-only 视图；
// events 保留了 record 的原始类型信息，这样 projector 才能区分
// user_message / assistant_message / tool_result / notification / system_reminder / memory_recalled
// 并按 record type 组装为对应的 Message[] 形态。
type ContextEvent =
  | Extract<WireRecord, { type: "user_message" }>
  | Extract<WireRecord, { type: "assistant_message" }>
  | Extract<WireRecord, { type: "tool_result" }>
  | Extract<WireRecord, { type: "notification" }>
  | Extract<WireRecord, { type: "system_reminder" }>
  // Phase 2 预留：
  // | Extract<WireRecord, { type: "memory_recalled" }>
  ;

interface ContextSnapshot {
  readonly events: readonly ContextEvent[];   // 按 seq 升序排列的对话事件序列
  readonly systemPrompt: string;
  readonly model: string;
  readonly activeTools: ReadonlySet<string>;
  readonly summary?: SummaryMessage;
}

interface ConversationProjector {
  project(
    snapshot: ContextSnapshot,
    options?: ProjectionOptions,
  ): Message[];
}

interface ProjectionOptions {
  model?: string;
  maxTokens?: number;
}
```

Phase 1 中，projector 只做 4 件事：

- 读取已持久化的对话历史（来自 `ContextSnapshot`），其中已经包含 `notification` / `system_reminder` / 未来的 `memory_recalled` 等 durable 对话事件（详见 §4.5.2 FullContextState）
- 按 record 类型组装为 provider-neutral `Message[]`：
  - `user_message` → user message
  - `assistant_message` → assistant message（含 tool_calls）
  - `tool_result` → tool message
  - `notification` → 系统消息（例如 `[system-notification] <title>: <body>`），位置按它在 wire 里的时间顺序和周围对话事件交织
  - `system_reminder` → `<system-reminder>...</system-reminder>` 包裹的系统消息（和 CC 对齐）
  - `memory_recalled`（Phase 2 预留）→ 系统消息，格式和 CC 的 memory recall 注入对齐
- 处理相邻 `user` message 的合并
- 产出 provider-neutral `Message[]`

Projector 绝不做的事：

- dangling tool call 修补；这属于 Replay / Recovery
- provider-specific schema 适配；这属于 Kosong
- 任何持久化动作；它只读
- 任何"turn-scope 临时注入"：v2 初稿有过 `ephemeralInjections` 参数用于一次性注入 notification / reminder / memory recall，Phase 6E 删除——这些内容必须先走 ContextState durable 写入，再由 projector 从 snapshot 自然读出，才不会出现"Turn N LLM 看到、Turn N+1 看不到"的因果断裂。

`ContextState.buildMessages()` 的角色因此收窄为**同步、纯读、无副作用的委托点**：实现层读取当前 `ContextSnapshot`，再调用 `projector.project(snapshot, options?)`。D14 Memory 的默认写入 seam 也被拉直——memory recall 结果走 `FullContextState.appendMemoryRecall`（Phase 2 接入，对齐 CC），不再通过 projector 的临时注入参数。`approval_request` / `approval_response` 永远不进 projector，它们只作为审计与恢复信号存在于 SessionJournal / Replay 路径。

### 4.8 EventSink 的持久化规则（铁律）

#### 4.8.1 EventSink 的定位

EventSink 是 Soul 发射 UI / 遥测事件的 **fire-and-forget** 通道。它的用途只有三类：

- **UI 渲染**：`step.begin` / `step.end` / `content.delta` / `tool.call` / `tool.progress` 等用来驱动客户端流式渲染
- **遥测埋点**：把 agent loop 的执行节奏发给观测系统，用于统计步数 / 延迟 / token 消耗
- **调试日志**：开发期把事件流 dump 出来看 Soul 做了什么

EventSink **不**用于：持久化对话状态、崩溃恢复、replay 重建。这三件事是 ContextState（经由 JournalWriter 写 wire.jsonl）的责任，和 EventSink 物理隔离。

#### 4.8.2 接口定义

EventSink 是类型安全的 discriminated union。Soul 只会发出下列类型事件，新类型的增加必须过 ADR：

`EventSource`（事件身份标记）和 `BusEvent`（传输层信封）的完整 TypeScript 定义见 **附录 D.6.1**。`EventSource` 只存在于 EventBus 传输层，不污染持久化层（wire.jsonl 的 WireRecord 不含 source）。`BusEvent = SoulEvent & { source?: EventSource }`，主 agent 的事件无 source，subagent / teammate 的事件由 SoulRegistry wrapper 注入 source。

```typescript
type SoulEvent =
  | { type: "step.begin"; step: number }
  | { type: "step.end"; step: number }
  | { type: "step.interrupted"; step: number; reason: string }
  | { type: "content.delta"; delta: string }
  | { type: "tool.call"; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: "tool.progress"; toolCallId: string; update: ToolUpdate }
  | { type: "compaction.begin" }
  | { type: "compaction.end"; tokensBefore?: number; tokensAfter?: number };

interface EventSink {
  emit(event: SoulEvent): void;  // 注意：返回 void，不是 Promise
}

// 测试用 EventSink：收集事件到数组（§5.2 的测试代码使用此实现）
class CollectingSink implements EventSink {
  readonly events: SoulEvent[] = [];
  emit(event: SoulEvent): void { this.events.push(event); }
}

// 空 EventSink：丢弃所有事件（用于不关心事件的测试场景或嵌入场景）
const nullSink: EventSink = { emit() {} };
```

**source 字段的两层边界**：

- **持久化层**（wire.jsonl）：子 agent 的事件直接写入 `subagents/<agent_id>/wire.jsonl`，使用和主 wire **完全相同**的 `WireRecord` 类型——**不带 source**。子 agent 的身份通过**文件路径**（哪个 `<agent_id>/` 目录）表达，`source` 是冗余信息，不需要也不应该污染 wire schema。
- **传输层**（EventBus 广播）：`SoulRegistry` 给子 agent 注入的 EventSink wrapper 在转发到共享 EventBus 时自动加上 `source`，让共享一条 UI 事件流的 client 能一眼分辨"这是主 agent 说的话 / 这是某个 subagent 说的话 / 这是某个 teammate 说的话"。

这套"独立存储 + source 标记转发"设计取代了旧的 `subagent.event` 嵌套包装方案。旧方案的问题是：父 wire 会包含子 wire 的全量事件，递归 subagent 会造成无限嵌套；而且 UI 端没法便宜地分辨"哪个事件属于谁"。新方案里父 wire 只记 `subagent.spawned/completed/failed` 三个生命周期引用（见 §3.6.1），子 agent 的事件流完整独立存在，UI 端看到的事件天然带 source 标签。详见决策 #88。

**关键**：`emit` 的返回类型是 `void` 而不是 `Promise<void>`——这是类型层面的铁律。如果某天有人想改成 `Promise<void>` 以"让 listener 能异步处理"，**必须过 ADR**。否则会悄悄把 fire-and-forget 通道退化成"隐式同步路径"：Soul 在 emit 后被迫等 listener 跑完才能继续下一步，这会把本该 ≤1ms 的 `content.delta` 直接卡成 UI 渲染的同步瓶颈。

> **Backpressure 与 listener 契约**：emit 端的铁律由本节定义；subscribe 端的行为约束（listener < 1ms / eventLog 分类缓冲 / lag 检测 / subscriber 上限 10 个）见 §6.13.7（决策 #110）。

#### 4.8.3 铁律：EventSink 绝不持久化

明文规则，任何一条都不容许例外：

1. **EventSink 上流过的任何事件绝不进 wire.jsonl**。
2. **任何 listener 禁止在 EventSink 回调里调 `journalWriter.append()` 或任何等价的持久化操作**。具体说，listener 不能反向持有 ContextState 引用并调 `appendAssistantMessage` 之类的方法——这会绕开 Soul 的"内存可见 + WAL 入队"原子序（§4.5.3）。
3. **listener 失败（抛异常）不影响 Soul 继续执行**：`sink.emit` 内部 try/catch 吞掉异常，最多记一行 warning log。一个坏 listener 不能把 Soul 拖崩。
4. **如果未来需要"某种事件要落盘"**，必须走 ContextState 或 SessionJournal 的正式写路径（底层共享 `JournalWriter`），而不是在 EventSink 回调里偷偷写。

**理由**：

- `wire.jsonl` 是 **session 对话状态与会话审计记录** 的唯一持久化真相源。如果 EventSink 也往里写，立刻引入两个 durable 写路径漂移点，replay 时状态漂移——这正是 cc-remake 早期曾经掉进去的坑（forge 的 raw `content.delta` 持久化 bug，见 §4.11 调研结论）。
- Streaming 场景高频触发：`content.delta` 每个 token emit 一次，`tool.progress` 每个 stdout chunk emit 一次。这些事件不能每次都 `await` 持久化，否则 agent loop 的延迟会被 I/O 完全吞掉。
- 崩溃恢复只需要"最终结果"（`assistant_message` 的合并版、`tool_result` 的完整版），不需要"过程事件"（`content.delta`、`tool.progress`）。过程事件丢了没关系——UI 的下次刷新会基于 ContextState 的快照重建。

#### 4.8.4 和 ContextState 的分工

| 通道 | 写什么 | 同步性 | 是否进 wire.jsonl |
|---|---|---|---|
| ContextState | 对话状态变更（assistant / tool_result / user / system_reminder / config 变更等） | async await | 是 |
| EventSink | UI / 遥测事件（step 边界、content delta、tool call / progress、compaction 边界事件） | fire-and-forget | 否 |

一条原则：**"能读回来的"放 ContextState，"看着玩的"放 EventSink**。如果未来有某个字段既要渲染又要持久化，那就**同时**走两条通道——先 await ContextState 写方法，再 emit EventSink 事件。绝不允许一条通道越权兼职另一条。

### 4.9 append-only 保证

**核心规则：wire.jsonl 只 append，永不 truncate / rewrite**。

**压缩 + 文件轮转**：当 context 太长时，执行 compaction。Compaction 期间 lifecycle 进入 `"compacting"` 状态，**阻止所有 wire 写入**（防止 rename 和 new file 之间的并发写入）：

1. `lifecycle.transitionTo("compacting")` — 所有 wire 写入请求在此状态下排队
2. LLM 生成结构化 summary（摘要被压缩的对话内容）
3. 旧 wire.jsonl rename 为 `wire.1.jsonl`（冻结，永不修改）
4. 新 wire.jsonl 创建：第一行 metadata header，第二行 CompactionRecord
5. `lifecycle.transitionTo("active")` — 释放排队的写入请求
6. 多次 compaction 产生 `wire.1.jsonl`、`wire.2.jsonl`...，编号越大越老

**原子性保证**：步骤 3-4 是关键窗口。如果 rename 后新文件创建前崩溃，resume 时检测"wire.jsonl 不存在但 wire.N.jsonl 存在"→ 将最高编号的归档回滚为当前文件。

```
compaction 后：
sessions/ses_xxx/
├── wire.2.jsonl   ← 最老的归档（冻结）
├── wire.1.jsonl   ← 较新的归档（冻结）
└── wire.jsonl     ← 当前文件（CompactionRecord + 新消息）
```

文件轮转操作（rename + create）不违反 append-only：旧文件整体冻结不修改，新文件只 append。

**消息编辑（预留能力）**：通过 append `context_edit` 事件实现逻辑编辑，不物理修改已有行：

```typescript
// 伪代码（非可执行 TS）：示意 append 到 wire.jsonl 的 context_edit record 形状。
// 真实类型定义见 §4.3 的 ContextEditRecord；下面的 `{ ... }` 只是 record.data 的字段。

// 编辑消息：append 一条 context_edit 事件，原始消息不变
context_edit { operation: "edit_message", target_seq: 10, new_content: "..." }

// 删除消息：append 一条 context_edit 事件，原始消息不变
context_edit { operation: "delete_message", target_seq: 10, cascade: true }

// 回退：append 一条 context_edit 事件，旧 turn 的消息仍在文件里
context_edit { operation: "rewind", to_turn: 5 }
```

replay 时解释 context_edit 事件来构建最终 ContextState：
- edit_message → 覆盖目标消息的内容
- delete_message → 跳过目标消息（cascade=true 时跳过整个 turn）
- rewind → 跳过 to_turn 之后的所有消息
- 多次编辑同一消息 → 后者覆盖前者

**永远不允许的物理操作**：
- 删除某一行
- 修改某一行
- rewrite 整个文件
- 裁剪前 N 行

所有"编辑"都是逻辑覆盖（replay 解释层），不是物理修改。和 Git 不修改 commit 对象是同一个思路。

**compaction 后编辑的限制**：轮转后的 wire.N.jsonl 已冻结，其中的消息不可编辑。editMessage / deleteMessage / rewind 只能操作当前 wire.jsonl 中的消息。这自然保证了"压缩 = 封存历史"的语义。

### 4.10 与 forge 和 Python 的迁移

旧 session（forge 的 context + wire + state 三文件，或 Python 的相同结构）通过 **Adapter** 迁移：

```typescript
function migrate(oldSessionDir: string, newSessionDir: string) {
  // 读三个文件
  const context = readJsonl(oldSessionDir + "/context.jsonl");
  const wire = readJsonl(oldSessionDir + "/wire.jsonl");
  const state = readJson(oldSessionDir + "/state.json");

  // 合并时间线
  const merged = mergeByTime(context, wire);

  // 转换为 v2 WireRecord 格式
  const records = merged.map(convertToV2Record);

  // 写 v2 的 wire.jsonl
  writeJsonl(newSessionDir + "/wire.jsonl", records);

  // state 字段继续沿用（只做字段重命名/清理）
  writeJson(newSessionDir + "/state.json", normalizeState(state));
}
```

Adapter 是一次性工具，完成迁移后可以丢弃。

### 4.11 参考验证（调研结论）

基于 cc-remake、kimi-cli、pi-mono 的代码级调研：

- **context/wire 分离的痛点**：cc-remake 的 forge 存在 setSystemPrompt 三态漂移 bug（promptStore / context._systemPrompt / managedSession._systemPrompt），compaction 时使用旧 promptStore 值。v2 通过 `wire.jsonl` 作为 session 对话状态与会话审计记录的唯一持久化真相源消除了这个问题——system prompt 只有一个来源（replay wire 中最后一条 `system_prompt_changed`）。
- **TurnLog append-only 实践**：forge 已经实现了 write-ahead 模式（assistant message 在 tool 执行前写入）。v2 继承这个做法。
- **dangling tool 修复**：forge 的 `repairDanglingToolCalls` 主动修复方案**不被 v2 继承**。v2 采用**被动 journal repair** 策略——resume 时如果 replay wire.jsonl 发现 `tool_call_dispatched` 后缺失对应 `tool_result`（例如 LLM 返回 tool_calls 后、tool 执行前崩溃），由恢复路径补一条 synthetic `tool_result`（is_error=true, reason="crashed_before_execution"）到 wire.jsonl，再让 ConversationProjector 重新投影。详细策略见 §9.3。
- **forge delta 持久化 bug**：forge 当前把 raw content.delta 通过 `turnLog.append` 写入日志，没有过滤。v2 明确规定 content.delta 不落盘，只落合并后的 assistant_message。

---

## 五、Soul（无状态函数设计）

### 5.0 Soul / SoulPlus 边界铁律（硬约束）

Soul 与 SoulPlus 的拆分不是"代码组织偏好"，而是一组**必须在代码层面强制执行**的硬约束。任何一条铁律的松动，都会让 Soul 在演化中逐渐退化成"只能配合 SoulPlus 使用的内部类"，最终失去可嵌入性。本节先把这些硬约束摆在桌面上，后续 §5.1 / §6.1 的设计都围绕它们展开。

#### 铁律 1：Soul 是无状态函数

- Soul 不是 class，没有 `this`，没有实例状态。所有运行期状态都保存在 `SoulContextState` 里，Soul 只负责"读参数、调 LLM、写 context、发事件"。
- **Why**：Soul 是 stateless agent loop。无 `this` 让"无状态"这件事从类型签名就能看出来，不需要用文档和注释反复强调"别把状态挂在实例上"。
- **Enforcement**：`runSoulTurn` 以 `export async function` 形式导出，不提供任何 class 形态的别名或 wrapper。

> **澄清："无状态"指什么，不指什么**
>
> 这里的"无状态"是**代码组织层面**的——Soul 的 `runSoulTurn` 函数本身不持有任何字段（无 `this`、无 class instance、无 module-level mutable state、无跨 turn 缓存）。所有运行期状态都通过参数传入并外置在 `SoulContextState` 里。
>
> "无状态"**不**意味着"无副作用"。Soul 在执行过程中会:
>
> - **写对话状态**:通过 `context.appendAssistantMessage` / `appendToolResult` / `addUserMessages` / `applyConfigChange` 等窄面(这些写入都是 append-only,会被 `SoulContextState` 实现透传到 `JournalWriter`,最终落 `wire.jsonl`)
> - **发 UI / 遥测事件**:通过 `sink.emit(SoulEvent)`(fire-and-forget)
> - **调用 LLM**:通过 `runtime.kosong.chat(...)`(HTTP 出站、消耗 token)
> - **执行工具**:通过 `tool.execute(...)`(tool 自身可读写文件、起子进程、发网络)
> - **请求 compaction**:通过返回 `TurnResult.reason: "needs_compaction"` 上报给 TurnManager 执行(Soul 自己不切 lifecycle、不轮转文件、不 reset context;详见决策 #93 / 铁律 7)
>
> Soul 也**不**满足函数式编程意义上 "相同输入相同输出" 的 referential transparency——LLM 流式响应、tool 结果、abort 时刻都是非确定的。
>
> 这种"无状态" 仍然有价值的原因是:
>
> 1. **无 turn 间隐式状态**:每个 turn 是一次 pure 调用,参数即输入,没有"上一个 turn 留在实例字段里的脏状态"——reasoning 一个 turn 的行为只需看这次调用的入参,不需要回溯实例历史
> 2. **可嵌入**:第三方 host 不需要 `new Soul(...)`,只需要 `import { runSoulTurn }` 加几个窄接口实现
> 3. **可测试**:测试零 mock 污染,每个 turn 一次纯调用,断言走 `EventSink` listener + `SoulContextState` 投影
> 4. **类型签名即文档**:`export async function runSoulTurn(...)` 一行说清楚 Soul 不持有任何东西
>
> 注意区分:本文中其他位置出现的 `checkRules` / `matchesRule`(§11.3.1)确实是 FP 意义上的纯函数(无副作用、确定性、可缓存)——那里的"纯函数"措辞精确,无需调整。

#### 铁律 2：Soul 零 permission 词汇

- Soul 的整个类型系统和实现代码里**不允许出现** `permission` / `approval` / `askForPermission` / `canUseTool` / `permissionChecker` / `approvalRuntime` 等字样。
- **Why**：permission 是 SoulPlus 的职责，通过 `beforeToolCall` callback 注入。Soul 只知道"外面可能有人想否决一次 tool call"这一个事实，而不关心为什么否决、按什么规则否决。这条铁律让 Soul 具备真正的可嵌入性——第三方 host 可以用完全不同的权限模型嵌入 Soul。
- **Enforcement**：ESLint 规则禁止 `packages/soul/**` 下的文件出现上述关键词（identifier / 字符串字面量 / 注释都禁止），CI 强制执行。

#### 铁律 3：Soul import whitelist

**允许 import**：
- `SoulContextState`, `EventSink`, `Runtime`（以及它暴露的窄子接口 `LifecycleGate` / `JournalCapability` / `KosongAdapter` / `CompactionProvider`）
- `UserInput`, `TurnResult`, `SoulTurnOverrides`, `SoulConfig`, `AbortSignal`
- `Message`, `AssistantMessage`, `ToolCall`, `ToolResult` 等纯数据类型
- `SessionJournal` 仅作为**类型符号**出现在少量签名中——Soul 不直接调用 `SessionJournal` 的任何方法，管理类 record 的写入由 SoulPlus 在 `runSoulTurn` 外围（TurnManager / ToolCallOrchestrator 等）完成；Soul 自己对 `context` 的写入仅限 `SoulContextState` 上的 append-only 窄面（`appendAssistantMessage` / `appendToolResult` / `addUserMessages` / `applyConfigChange`；compaction 的 `resetToSummary` 不在 Soul 视图，归 `FullContextState`）
- `kosong` 对外 API

**禁止 import**：
- `JournalWriter` / `WireStore` / `WireFile` 等 wire 协议的**实现类和存储侧类型**；以及 `SessionJournal` 的实现类（`WiredSessionJournal` / `InMemorySessionJournal`）。Soul 只允许看到 `SessionJournal` **接口类型**，实际调用仍通过 `SoulContextState` 的窄面间接访问——Soul 不直接 `import` wire.jsonl 的任何类型或实现类
- `SoulPlus` 类及其 6 个 sub-component（`TurnManager` / `SkillManager` / `SoulRegistry` / `NotificationManager` / `RequestRouter` / `TeamDaemon`）
- 任何 `approvalRuntime` / `permissionChecker` 相关类型

**Why**：防止代码演化过程中 Soul 悄悄获得 SoulPlus 内部引用，破坏可嵌入性。一旦允许一个"临时捷径"，之后就会有第二个、第三个。

**Enforcement**：`tsconfig.json` 的 `paths` 映射 + ESLint `no-restricted-imports` 双重强制，CI 检查。

#### 铁律 4：双通道通信

Soul 和 SoulPlus 之间通过**两根**接口通信，不是一根：

- **ContextState**（写对话状态）：async / await，Soul 必须等待写入完成；resolve 后立即满足两条——(a) 内存投影已更新，`buildMessages()` 能看到；(b) WAL 入队完成（实际落盘由 §4.5.4 批量 drain 在 `drainIntervalMs` 内异步追赶，最坏丢失窗口 ≤ 50ms）。**force-flush kinds**（`approval_response` / `turn_end` / `subagent_completed` / `subagent_failed`）保留同步 fsync 语义，等磁盘完成才 resolve。
- **EventSink**（UI / 遥测事件）：fire-and-forget，不持久化，不返回 Promise。

- **Why**：状态写需要同步反馈"内存可见"（否则 `buildMessages` 读不到刚 append 的 assistant_message），UI 事件需要 fire-and-forget（流式输出不能每个 token 都 await，一次 await 就破坏流式）。一根通道无法同时满足这两种语义。"内存可见"是同进程读路径的硬性约束，"磁盘可见"由 batch drain 异步追赶——这是 CC 路线和 pi-mono 同步写之间的 50ms 折中。
- **Enforcement**：`EventSink.emit` 的类型签名返回 `void`（不是 `Promise<void>`），从类型上堵死"有人误用 await sink.emit(...)"的可能。

#### 铁律 5：EventSink 绝不持久化

- EventSink 上流过的事件**绝不**进 wire.jsonl。
- 任何 listener **禁止**在 EventSink 上挂钩去写 wire.jsonl。
- **Why**：`wire.jsonl` 是 **session 对话状态与会话审计记录** 的唯一持久化真相源。如果 EventSink 也写 wire.jsonl，就会引入两条 durable 写路径，任何两边不一致的瞬间都会变成状态漂移 bug。
- **Enforcement**：code review + ADR 明文记录。EventSink 的类型文档里直接写"本通道上的事件不会、也不应被持久化"。

#### 铁律 6：Runtime 是 SoulPlus 能力的唯一暴露面

- Soul 只通过 `Runtime` 接口访问 SoulPlus 的能力（Phase 1 终稿仅 `kosong` 一个字段——compaction / lifecycle / journal 已经在决策 #93 后从 Runtime 移除，归 TurnManager 持有）。工具集通过 `SoulConfig.tools` 以参数形式注入，不走 Runtime；`SubagentHost` / `TeamMailPublisher` 等协作能力也不进 Runtime，而是通过 tool constructor 注入给 `AgentTool` 等协作工具族（D1 + D11）。
- 所有跨 turn / 跨 component 的能力（lifecycle 切换、文件轮转、compaction 业务流程）由 SoulPlus 在 `runSoulTurn` 外围执行；Soul 仅通过 `TurnResult.reason` 上报"我需要 host 帮我做一件超出 Soul 边界的事"。
- Soul 看不到 SoulPlus 具体类，也看不到三层 DAG（共享资源 / 服务 / 行为组件）里的任何节点（D10）。
- **Why**：让 `Runtime` 成为"SoulPlus 暴露给 Soul 的窄门"。任何跨界能力都必须显式加到 `Runtime` 上——这迫使每一次能力扩张都是一次深思熟虑的接口设计，而不是随手 `this.soulPlus.xxx`。
- **Enforcement**：类型系统 + 铁律 3 的 import whitelist。

#### 铁律 7：Soul 不持有"业务流程编排权"

- Soul 不能编排涉及多个 SoulPlus 组件的业务流程。如果一个流程需要"切 lifecycle + 调 X + 调 Y + 切回 lifecycle"这样的多步协调，它属于 SoulPlus 的 TurnManager / 某个服务层组件，Soul 仅以 `TurnResult.reason` 信号触发。
- **Why**：这是 compaction 设计调整（决策 #93）提炼出来的元原则。v2 初稿曾让 Soul 通过 `runtime.lifecycle.transitionTo` + `runtime.compactionProvider.run` + `runtime.journal.rotate` + `context.resetToSummary` 四个窄接口拼装出一个完整的 compaction 业务流程——表面上是"4 个独立能力组合"，本质上是 Soul 当装配工执行 SoulPlus 的内部业务流，让"两个接口互为前提"成为 Soul 必须持有的内部知识。这条铁律明确禁止类似"Runtime 接口拼出 SoulPlus 业务流"的偷渡，避免 Runtime 字段后续蔓延（参考决策 #85 → #93 的演化）。
- **Enforcement**：Runtime 接口字段保持极窄（Phase 1 仅 `kosong`）；新增的"跨 turn 协调"类需求一律通过 `TurnResult.reason` 新值上报给 TurnManager 处理；ESLint 可禁止 `packages/soul/**` 下出现 `lifecycle` / `journal` / `compactionProvider` 等关键字。

#### 为什么需要这些铁律

这些铁律不是洁癖，而是为了让"开箱即用用 SoulPlus / 深度自定义用 Soul"两条路径都**真实可行**。SoulPlus 提供了完整的 session 管理、wire 协议、permission、skill、team 等能力——绝大多数 host 用它就够了。但总有场景需要"只要 agent loop，不要 wire、不要 permission 系统、不要 session lifecycle"，这时 Soul 必须能**真的**被独立嵌入。失去任何一条铁律，Soul 的可嵌入性就会逐渐流失：今天多一个 `wireStore` 引用、明天多一个 `approvalRuntime` 依赖，三个月后 Soul 就再也无法脱离 SoulPlus 单独运行了。铁律存在的意义，是把"可嵌入性不退化"这件事从"靠人肉自律"变成"靠类型系统和 CI 强制"。

### 5.1 Soul 的定义

#### 5.1.1 Soul 是什么

一句话定义：**Soul 是一个 stateless agent loop**——给定任务输入 + 对话上下文 + 工具集 + LLM adapter，Soul 跑完一轮 agent 循环（LLM → tool → LLM → tool → ... 直到 `stop_reason`），然后返回。它是一个**无状态函数**（stateless function），不是一个类——这里的"无状态"指无 this / 无实例字段 / 无跨 turn 状态，**不**指 FP 意义的"无副作用"，详见 §5.0 铁律 1 下方的澄清。

对比：

- **cc-remake 的 `query()`**：async generator，调用方通过 `for await` 拉事件。状态和控制流交织，嵌入成本高。
- **pi-mono 的 `runAgentLoop`**：纯函数，通过 callback 发事件。状态全部外置，测试和嵌入都简单。
- **Kimi v2 的 `runSoulTurn`**：采取 pi-mono 路线——无状态函数形态（无 class、无 this），状态全部外置在 `SoulContextState`，事件通过 `EventSink` 发出。选择无状态函数形态的理由是简化测试（不需要构造类实例）和降低嵌入门槛（第三方 host 只需提供几个窄接口的实现）。

#### 5.1.2 Soul 的核心签名

```typescript
export async function runSoulTurn(
  input: UserInput,
  config: SoulConfig,
  context: SoulContextState,
  runtime: Runtime,
  sink: EventSink,
  signal: AbortSignal,
  overrides?: SoulTurnOverrides,
): Promise<TurnResult>;
```

参数逐个解释：

- `input`：当前 turn 的用户输入。注意 SoulPlus 在调用 `runSoulTurn` 之前**已经**把用户消息 append 到 `ContextState` 了，这里把 `input` 再传一遍只是为了让 Soul 知道"这一轮是为了回应哪条输入"——例如 Soul 里的 skill-aware 分支需要看原始输入字符串。
- `config`：Soul 的配置，包含工具集和两个 callback（`beforeToolCall` / `afterToolCall`）。见 §5.1.3。
- `context`：对话状态的**窄视图**（详见 §4.5 的 `SoulContextState`）。Soul 能通过 `appendAssistantMessage` / `appendToolResult` / `addUserMessages` / `applyConfigChange` 等 append-only 窄方法读写必要状态，但看不到 `appendUserMessage` / `resetToSummary` 等 `FullContextState` 独占方法，也看不到 SoulPlus 层面用于写 `turn_begin` / `turn_end` / `skill_invoked` 等管理 wire 记录的接口（这些走 `SessionJournal`）。
- `runtime`：SoulPlus 暴露给 Soul 的能力容器；Phase 1 终稿仅 `kosong` 一个字段（决策 #93 收窄；旧 `compactionProvider` / `lifecycle` / `journal` 已下沉到 TurnManagerDeps）。见 §5.1.5 概览和 §6.12.2 完整定义。
- `sink`：UI / 遥测事件通道。fire-and-forget。
- `signal`：中断信号。Soul 不创建它，只消费它；所有可能阻塞的 await 点都必须传播并检查同一个 `AbortSignal`。
- `overrides`：**Soul 能看到的那一半 overrides**——仅与 LLM visibility filter 相关（`model` / `activeTools` / `effort`），不含任何 permission 规则。permission 规则已经由 SoulPlus 在构造 `beforeToolCall` 闭包时 baked 进去了，Soul 无感知。

#### 5.1.3 SoulConfig 定义

```typescript
interface SoulConfig {
  tools: Tool[];  // 见 §10

  // 单轮最多执行的 step 数（LLM→tool→LLM 为 1 step）。默认 100。
  // 防止恶性循环（LLM 反复调 tool 不收敛）把整个 session 跑飞。
  // 参考 cc-remake 的实现。
  maxSteps?: number;

  beforeToolCall?: (
    ctx: BeforeToolCallContext,
    signal: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;

  afterToolCall?: (
    ctx: AfterToolCallContext,
    signal: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

interface BeforeToolCallContext {
  toolCall: ToolCall;
  args: unknown;                    // 已经过 zod schema 校验
  assistantMessage: AssistantMessage;
  context: SoulContextState;        // 只读访问
  // 注意：不含 turnNumber / stepNumber / sessionId / agentId 等 id 字段。
  // 这些 id 由 SoulPlus 在构造 beforeToolCall 闭包时通过 closure 捕获（见 §6.4 的
  // `buildBeforeToolCall` 和 §11.7 的构造流程），和 D18 决策"ToolCallOrchestrator 内部
  // 中间态不暴露给 Soul"一致。Soul 本身只看到"普通的异步 callback"，不需要也不应该
  // 把这些 id 作为参数传进闭包——那样会违反铁律 2（Soul 零 permission 词汇）。
}

interface BeforeToolCallResult {
  block?: boolean;         // true = 否决这次 tool call
  reason?: string;         // 给 LLM 看的拒绝理由
  updatedInput?: unknown;  // 改写 args（谨慎使用）
}

interface AfterToolCallContext {
  toolCall: ToolCall;
  args: unknown;
  result: ToolResult;
  context: SoulContextState;
}

interface AfterToolCallResult {
  resultOverride?: ToolResult;  // 改写 result（用于脱敏、截断、警告注入）
}
```

关键点：

- `beforeToolCall` 是 Soul 眼中**唯一**的 approval gate。它**允许做重活**：读文件、算 diff、查 permission registry、发 approval wire 消息并等用户响应——因为在 SoulPlus 模式下，这个 callback 的实现由 SoulPlus 提供，拥有完整能力。Soul 对它的认知只有："一个可能需要长时间等待的异步 callback，可能返回 `block`，就这样"。
- `afterToolCall` 用于 PostToolUse hook、telemetry、output 脱敏、大输出截断、警告注入等场景。Phase 1 就包含此 hook，不留到后期补。
- 两个 callback 都接收 `AbortSignal`，允许 Soul 在 turn 被 cancel 时立即中断正在执行的 permission 查询或 hook。

#### 5.1.4 SoulTurnOverrides（Soul 视图）

**SoulTurnOverrides**：Soul 看到的窄版本 TurnOverrides，仅包含与 LLM 可见性相关的字段。字段概览：

- `model?`: 覆盖本轮使用的 LLM 模型
- `activeTools?`: LLM 可见的 tool 子集（第一层保护）
- `effort?`: 推理强度 hint

完整 TypeScript 定义（含 `FullTurnOverrides` 全版本对比）见 **§11.6 TurnOverrides 一分为二**。

关键说明：

- `SoulTurnOverrides` **不含** `disallowedTools`。
- `activeTools` 在 Soul 这里**只做 LLM visibility filter**——在调 `kosong.chat` 之前过滤 tool 列表，让 LLM 根本看不到被禁用的工具。这是一层"减少误调用"的保护，不是安全边界。
- 真正的安全边界（`activeTools` 作为 allow rule、`disallowedTools` 作为 deny rule）由 SoulPlus 在构造 `beforeToolCall` 闭包时 baked 进去，Soul 完全无感知。
- 这是"TurnOverrides 一分为二"设计决策的落地——全版本 `TurnOverrides` 由 SkillManager 产出、TurnManager 持有；Soul 只拿到其中与 LLM 可见性相关的子集。

#### 5.1.5 Runtime 接口（预览）

**Runtime**：Soul 执行所需的窄能力容器，通过 SoulPlus 注入。Phase 1 只有 1 个字段：

- `kosong`: LLM 调用适配器（`KosongAdapter`）

完整 TypeScript 定义见 **§6.12.2 接口定义**。

> **Phase 6I 决策 #93 收窄**：v2 初稿 Runtime 含 4 字段（`kosong / compactionProvider / lifecycle / journal`），让 Soul 在 `runCompaction` 子函数里拼装 compaction 业务流程。决策 #93 将 compaction 执行流程整体移到 TurnManager（铁律 7），`compactionProvider` / `lifecycle` / `journal` 三个字段**已从 Runtime 移除**——它们仍然存在于 SoulPlus 内部，但只通过 `TurnManagerDeps` 流向 TurnManager，不流向 Soul。

注意 `Runtime` 只有 `kosong` 这一个字段——不含 `tools`、不含 `agentSpawner`、也不含任何 subagent host 能力。Soul 拿到的工具集通过 `SoulConfig.tools` 参数传入；如果某个 tool（例如 AgentTool）需要 host-side 依赖，则在 tool 构造期通过 `SubagentHost` 一类依赖注入，不走 Runtime。

#### 5.1.6 Soul 的完整职责清单

**Soul 管的**：

1. Step 循环驱动（`while (true)`，直到 `stop_reason`）
2. `stop_reason` 判断（`end_turn` / `aborted` / `error`）
3. `step_number` 计数
4. `signal.throwIfAborted()` 检查点（覆盖每个可能阻塞的 await 点）
5. Turn 内 token usage 累加
6. 调 LLM（`runtime.kosong.chat`）
7. 调 tool（按 `beforeToolCall → tool.execute → afterToolCall` 序列）
8. 触发读侧投影（`context.buildMessages()`，内部委托 ConversationProjector）
9. 写状态（`context.appendAssistantMessage` / `appendToolResult`）；写入语义全是 append-only
10. 处理 turn 内 steer 输入；注意 notification / system reminder / memory recall 都已经在 ContextState 中 durable 留存，Soul 不再处理它们——调 `context.buildMessages()` 时 projector 会自然从 snapshot 读出并组装
11. 构造 LLM-visible tool list（按 `overrides.activeTools` 过滤）
12. 发 UI 事件（`sink.emit`）
13. **检测 compaction 需求**（仅 step safe point：while 顶部，当前 step 已完整落盘，无 pending tool_call / approval / partial），通过 `TurnResult.reason: "needs_compaction"` 上报给 TurnManager；Soul **不**执行 compaction 任何动作（不切 lifecycle、不调 compactionProvider、不轮转文件、不 reset context）

**Soul 绝不管的**：

1. wire.jsonl 物理文件（藏在 ContextState / JournalWriter 内部）
2. turn_id / seq 生成
3. Session lifecycle 状态机（决策 #93 后：Soul 完全无感知；lifecycle 切换由 TurnManager 在 `executeCompaction` 里直接驱动 `lifecycleStateMachine.transitionTo("compacting" | "active")`）
4. `turn_begin` / `turn_end` / `user_message` / `skill_invoked` wire 记录的写入
5. Skill 检测和模板展开
6. Team daemon / subagent 进程管理
7. Permission 规则加载和查询
8. Approval UI 交互
9. 崩溃恢复 / replay
10. Config 加载
11. 从 team 邮箱接收通知
12. Permission override 应用（这是 SoulPlus 在 `beforeToolCall` 闭包里做的）
13. **Compaction 执行**（决策 #93 / 铁律 7）：Soul 只检测、上报，TurnManager 执行整套流程（lifecycle → summary → rotate → reset）；详见 §6.4 `executeCompaction` 伪代码

#### 5.1.7 Soul 的完整伪代码

```typescript
// Soul 内部自用的错误类型（Phase 1 最小声明，附录 D 会补全字段）
export class MaxStepsExceededError extends Error {
  readonly code = "soul.max_steps_exceeded" as const;
  constructor(message: string) {
    super(message);
    this.name = "MaxStepsExceededError";
  }
}

export async function runSoulTurn(
  input: UserInput,
  config: SoulConfig,
  context: SoulContextState,
  runtime: Runtime,
  sink: EventSink,
  signal: AbortSignal,
  overrides?: SoulTurnOverrides,
): Promise<TurnResult> {
  const usage: TokenUsage = { input: 0, output: 0 };
  let stepNumber = 0;
  // stopReason 在每个 step 结束时被精确赋值（"end_turn" / "max_steps" / "abort" / ...），
  // 初始值 "end_turn" 只是占位；循环总会至少跑一步并覆盖它
  let stopReason: StopReason = "end_turn";

  // LLM 可见 tool 过滤（第一层保护）
  const visibleToolSet = overrides?.activeTools
    ? new Set(overrides.activeTools)
    : undefined;

  const model = overrides?.model ?? context.model;
  const effort = overrides?.effort;

  const maxSteps = config.maxSteps ?? 100;

  try {
    while (true) {
      // while 顶部是唯一 safe point：
      // 上一个 step 已完整落盘，当前不存在 pending tool_call / approval / partial assistant_message。
      signal.throwIfAborted();

      // ─── Compaction 检测（仅 safe point 允许；Soul 只检测、上报，不执行） ───
      // 决策 #93 / 铁律 7：执行流程已移到 TurnManager。检测条件双触发：
      // (1) tokenCountWithPending / max_context_size >= compactionTriggerRatio (默认 0.85)
      // (2) max_context_size - tokenCountWithPending < reservedContextSize (默认 50K)
      // 任一满足即返回；TurnManager 会调 executeCompaction 然后重启同一 turn_id 的 Soul。
      if (shouldCompact(context)) {
        return {
          reason: "needs_compaction",
          stopReason: "compaction_requested",
          steps: stepNumber,
          usage,
        };
      }

      stepNumber++;

      // ─── Step 上限检查（防止恶性循环） ───
      if (stepNumber > maxSteps) {
        throw new MaxStepsExceededError(
          `Soul turn exceeded maxSteps=${maxSteps}`,
        );
      }

      // ─── Drain 阶段 ───
      // 注意：Soul 只 drain steer（turn 内瞬时用户注入），不处理 notification / reminder。
      // notification / system reminder / memory recall 已经由 NotificationManager 这类
      // SoulPlus 服务层组件通过 ContextState.appendNotification / appendSystemReminder
      // 做 durable 写入，作为 durable 对话事件留在 transcript 里；
      // buildMessages() 调用 projector 时会自然从 snapshot 读出并组装。
      const pendingSteers = context.drainSteerMessages();
      if (pendingSteers.length > 0) {
        await context.addUserMessages(pendingSteers);
        signal.throwIfAborted();
      }

      sink.emit({ type: "step.begin", step: stepNumber });

      // ─── LLM 调用 ───
      // 所有 LLM 能看到的内容都已经在 ContextState 中——包括 user/assistant/tool_result
      // 以及 notification / system_reminder / memory_recalled 这些 durable 对话事件。
      // Soul 只需要调 buildMessages()，projector 会从 snapshot 完整拼出 LLM 输入。
      const messages = context.buildMessages();
      const llmTools = buildLLMVisibleTools(config.tools, visibleToolSet);

      const response = await runtime.kosong.chat({
        messages,
        tools: llmTools,
        model,
        effort,
        signal,
        // partial delta 只走 EventSink（fire-and-forget UI 通道），
        // 不写 ContextState、不进 wire.jsonl——崩溃时整段 partial 丢失，
        // 但完整的 assistant_message 也还没 append，ContextState 语义干净，
        // §9 的 Await-Point 矩阵按"无 assistant_message"处理（D5 / 决策 #84）
        onDelta: (delta) => sink.emit({ type: "content.delta", delta }),
      });
      signal.throwIfAborted();

      usage.input += response.usage.input;
      usage.output += response.usage.output;

      // 完整 assistant_message（含 tool_calls）durable 写入 ContextState；
      // 这里 await 之后，step 的这一半算"已落盘"，崩溃后恢复能看到它
      await context.appendAssistantMessage(response.message);
      signal.throwIfAborted();

      // ─── Tool 执行 ───
      if (response.toolCalls.length === 0) {
        stopReason = response.stopReason ?? "end_turn";
        sink.emit({ type: "step.end", step: stepNumber });
        break;
      }

      for (const toolCall of response.toolCalls) {
        signal.throwIfAborted();
        const tool = findTool(config.tools, toolCall.name);

        if (!tool) {
          await context.appendToolResult(toolCall.id, {
            isError: true,
            content: `tool not found: ${toolCall.name}`,
          });
          signal.throwIfAborted();
          continue;
        }

        // ─── 参数校验 ───
        const parseResult = tool.inputSchema.safeParse(toolCall.input);
        if (!parseResult.success) {
          await context.appendToolResult(toolCall.id, {
            isError: true,
            content: `invalid args: ${parseResult.error.message}`,
          });
          signal.throwIfAborted();
          continue;
        }
        let args = parseResult.data;

        sink.emit({
          type: "tool.call",
          toolCallId: toolCall.id,
          name: toolCall.name,
          input: args,
        });

        try {
          // ─── beforeToolCall gate（唯一 approval 点） ───
          if (config.beforeToolCall) {
            const before = await config.beforeToolCall(
              { toolCall, args, assistantMessage: response.message, context },
              signal,
            );
            signal.throwIfAborted();
            if (before?.block) {
              await context.appendToolResult(toolCall.id, {
                isError: true,
                content: before.reason ?? "blocked by permission",
              });
              signal.throwIfAborted();
              continue;
            }
            if (before?.updatedInput !== undefined) {
              args = before.updatedInput;
            }
          }

          // ─── 执行 tool ───
          // 决策 #97 / Streaming Tool Execution 预留：检查 prefetched 缓冲。
          // Phase 1 ChatResponse._prefetchedToolResults 永远 undefined → 永远走 else 分支，
          // 行为与原线性路径完全等价。Phase 2 启用 streaming tool execution 后，
          // SoulPlus 注入的 StreamingKosongWrapper 在 chat() 调用期间通过
          // onToolCallReady 把 toolCall 推给 ToolCallOrchestrator.executeStreaming 提前执行，
          // stream 收尾时把已完成的 result 塞进 _prefetchedToolResults——这里命中即跳过
          // tool.execute（不再重复执行）。Soul 接口和铁律完全不动。
          const prefetched = response._prefetchedToolResults?.get(toolCall.id);
          let result: ToolResult;
          if (prefetched !== undefined) {
            result = prefetched;
          } else {
            result = await tool.execute(
              toolCall.id,
              args,
              signal,
              (update) =>
                sink.emit({ type: "tool.progress", toolCallId: toolCall.id, update }),
            );
          }
          signal.throwIfAborted();

          // ─── afterToolCall hook ───
          if (config.afterToolCall) {
            const after = await config.afterToolCall(
              { toolCall, args, result, context },
              signal,
            );
            signal.throwIfAborted();
            if (after?.resultOverride !== undefined) {
              result = after.resultOverride;
            }
          }

          await context.appendToolResult(toolCall.id, result);
          signal.throwIfAborted();
        } catch (err) {
          if (isAbortError(err) || signal.aborted) {
            await context.appendToolResult(toolCall.id, {
              isError: true,
              content: "tool execution cancelled",
            });
            throw err;
          }
          await context.appendToolResult(toolCall.id, {
            isError: true,
            content: err instanceof Error ? err.message : String(err),
          });
          signal.throwIfAborted();
        }
      }

      sink.emit({ type: "step.end", step: stepNumber });
    }
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      sink.emit({ type: "step.interrupted", step: stepNumber, reason: "aborted" });
      return { reason: "aborted", stopReason: "aborted", steps: stepNumber, usage };
    } else {
      sink.emit({ type: "step.interrupted", step: stepNumber, reason: String(err) });
      throw err;  // 让 TurnManager catch 后写 turn_end(reason: "error") + emit session.error
    }
  }

  return { reason: "end_turn", stopReason, steps: stepNumber, usage };
}

// 决策 #93 / 铁律 7：runCompaction 子函数已删除。compaction 执行整体移到
// TurnManager.executeCompaction（见 §6.4），Soul 只在 while 顶部 safe point 检测，
// 通过 return { reason: "needs_compaction" } 上报，不再调任何 lifecycle / journal /
// compactionProvider 接口。

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
```

伪代码的关键控制流：

- **While 循环**：直到 LLM 不再发起 tool_call 或异常中断
- **Compaction 检测（仅）**：只允许在 while 顶部的 safe point 触发，触发后立即 `return { reason: "needs_compaction" }`；不调任何 lifecycle / journal / compactionProvider 接口（决策 #93 / 铁律 7）。TurnManager 收到 `needs_compaction` 后调 `executeCompaction` 然后重启 Soul 接续同一 turn_id（见 §6.4）
- **beforeToolCall gate**：`block` → 把拒绝理由作为 error tool_result 回给 LLM，让 LLM 自己决策下一步
- **Abort 传播**：每个可能阻塞的 await 点之后都立即 `throwIfAborted()`；若 abort 发生在 tool 调用链中，先补一条 `tool execution cancelled` 的 `tool_result`，再让 turn 以 `"aborted"` 退出（return `{ reason: "aborted" }`）
- **afterToolCall hook**：可以改写 result，用于脱敏和警告注入
- **Projector 投影**：所有 LLM 能看到的内容都已经在 ContextState 中（包括 notification / system reminder / memory recall 这类由 NotificationManager 等 SoulPlus 服务层组件写入的 durable 对话事件），Soul 只需调 `context.buildMessages()`，projector 会从 snapshot 完整组装；Soul 从不持有"临时注入"概念
- **TurnResult.reason 4 元集**：`"end_turn" | "needs_compaction" | "aborted" | "error"`——`end_turn` 走 return；`needs_compaction` 在 safe point return；`aborted` 在 catch 内 return（abort 是预期路径）；`error` 走 throw 让 TurnManager 写 turn_end + emit session.error

#### 5.1.8 Soul 不持有的东西

为了让铁律具象化，Soul 的实现必须同时满足以下几条反向约束：

- Soul 没有 `this`——因为它不是 class
- Soul 没有任何模块级的 mutable state 字段——所有运行期状态都是参数里传进来的
- Soul 不 `new SoulPlus`——这条由 import whitelist 强制
- Soul 不 import 任何 wire 协议相关类型（`WireFile` / `JournalWriter` / `WireRecord` / ...）
- Soul 的所有副作用都通过三个参数发生：`context.` 写对话状态、`sink.` 发事件、`runtime.` 调外部能力

任何违反上述任一条的代码，都应该被 CI 挡下来。

#### 5.1.9 Soul 的可嵌入性举例（决策 #112 坦诚降级）

嵌入 Soul 到第三方 host 需要实现 `SoulContextState`（11+ 方法：`buildMessages` / `appendAssistantMessage` / `appendToolResult` / `addUserMessages` / `drainSteerMessages` / `tokenCountWithPending` 等）、`KosongAdapter`（含 OAuth retry + ContextOverflowError 检测）、`EventSink`、至少一个 Tool——**预计工作量 50-80 行核心代码 + 若干辅助类型**。参考 kimi-cli Python 的嵌入示例（`examples/custom-kimi-soul/main.py`，60 行 + 8 个对象构造）。

**Soul 的可嵌入性是"可测试 + 可替换 host"的价值，不是"零成本接入"的承诺。** 嵌入方可以用自己的 host 替换 SoulPlus，完全控制 compaction / permission / session 管理策略，而不需要 fork 整个 SoulPlus。

下面是一个第三方 host 嵌入 Soul 的例子——没有 WAL、没有 wire.jsonl、没有 session 管理、没有 SoulPlus：

```typescript
import { runSoulTurn } from "@kimi/soul";
import { InMemoryContextState } from "./my-context";
import { createConsoleEventSink } from "./my-events";
import { createSimpleRuntime } from "./my-runtime";

const context = new InMemoryContextState({
  model: "gpt-4",
  systemPrompt: "You are a helpful assistant.",
});

const runtime: Runtime = {
  kosong: myKosongAdapter,
  // 决策 #93 后 Runtime 只有 kosong 一个字段——compaction / lifecycle / journal 不再
  // 流向 Soul。如果嵌入方需要 compaction，自己在 host 层做循环：检测 `runSoulTurn`
  // 返回 `reason: "needs_compaction"` → 自行 summarize → 自行重置 context → 再调 runSoulTurn。
};

const result = await runSoulTurn(
  { text: "hello" },
  {
    tools: [readFileTool, writeFileTool],
    beforeToolCall: async ({ toolCall, args }) => {
      // 第三方自定义 permission 逻辑
      if (toolCall.name === "writeFile" && args.path.startsWith("/etc")) {
        return { block: true, reason: "system path forbidden" };
      }
      return undefined;
    },
  },
  context,
  runtime,
  createConsoleEventSink(),
  new AbortController().signal,
);
```

嵌入方需要实现 4 个窄接口（`SoulContextState` / `Runtime` / `EventSink`、可选的 `beforeToolCall` / `afterToolCall`），完全不需要接触 `wire.jsonl`、`SoulPlus` 或任何 Kimi 内部的 session 管理类。这正是铁律 1–7 存在的意义。

**Minimum Embeddable Host 参考**（~60 行，参考 kimi-cli Python `examples/custom-kimi-soul/main.py`）：

```typescript
// 最简嵌入示例——无 SoulPlus、无 wire.jsonl、无 session 管理
import { runSoulTurn } from "@kimi/soul";
import { InMemoryContextState } from "@kimi/soul/testing";
import { SimpleKosongAdapter } from "./my-kosong";
import { ReadTool, BashTool } from "./my-tools";

const context = new InMemoryContextState({
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful coding assistant.",
});
const sink = new CollectingSink();
const kosong = new SimpleKosongAdapter({ apiKey: process.env.API_KEY!, model: "claude-sonnet-4-20250514" });
const runtime: Runtime = { kosong };

// 注意：嵌入方必须自己处理 compaction
// 方式 1：在调用 runSoulTurn 的外层 while 循环里检查 needs_compaction + 调 compactionProvider
// 方式 2：忽略 compaction（只适合短 session）
let input: UserInput = { text: "Hello, help me refactor my code" };
while (true) {
  const result = await runSoulTurn(
    input,
    { tools: [ReadTool, BashTool], beforeToolCall: async () => undefined },
    context,
    runtime,
    sink,
    AbortSignal.timeout(60_000),
  );

  if (result.reason === "needs_compaction") {
    // 方式 1：嵌入方自行做 compaction
    // const summary = await myCompactionProvider.run(context.buildMessages(), ...);
    // context.resetToSummary(summary);
    // continue;

    // 方式 2：短 session 忽略 compaction，直接结束
    console.warn("Context too long, ending session");
    break;
  }

  console.log("Turn completed:", result.reason);
  break;
}
```

> **注意**：嵌入方需要实现 `SoulContextState`（11+ 方法）——这不是"几行代码"的事。`InMemoryContextState`（`@kimi/soul/testing` 导出）是测试用的完整实现，嵌入方可以直接使用它（纯内存，无持久化），或以它为参考实现自己的持久化版本。

### 5.2 Soul 的可测试性

因为 `runSoulTurn` 是无状态函数（没有 `new SoulHandle()` 之类的 class 实例构造；`SoulHandle` 只是 SoulRegistry 持有的轻量跟踪句柄），测试直接调用即可：

```typescript
const context = InMemoryContextState.empty({
  model: "gpt-4",
  systemPrompt: "You are helpful",
});
const runtime = createMockRuntime({ mockLlm, mockTools });
const sink = new CollectingSink();
const neverAbort = new AbortController().signal;

const config: SoulConfig = {
  tools: [],
  // beforeToolCall 返回 Promise<BeforeToolCallResult | undefined>
  // 返回 undefined = 放行；返回 {block: true, reason} = 否决
  beforeToolCall: async (ctx, signal) => undefined,
  // afterToolCall 返回 Promise<AfterToolCallResult | undefined>
  // 返回 undefined = 不改写；返回 {resultOverride} = 改写结果
  afterToolCall: async (ctx, signal) => undefined,
};

const result = await runSoulTurn(
  { text: "hello" },    // UserInput = {text, attachments?}
  config,
  context,              // TypeScript 自动收窄为 SoulContextState
  runtime,
  sink,
  neverAbort,
);

// 事件 shape 来自 Soul 的 EventSink.emit 调用，形如 {type, step, ...}
// step 从 1 开始（Soul 在 step 循环的第一行 stepNumber++）
expect(sink.events).toEqual([
  { type: "step.begin", step: 1 },
  { type: "content.delta", delta: "Hi!" },
  { type: "step.end", step: 1 },        // 有始有终：每个 step.begin 必须配对 step.end
]);
expect(result.stopReason).toBe("end_turn");
expect(result.steps).toBe(1);
```

不需要 mock transport、socket、session、router、SoulPlus。Soul 通过 4 个窄接口参数完全独立测试：
- `SoulContextState`（用 `InMemoryContextState` 实现）
- `Runtime`（用 mock 实现，no-op `lifecycle` / `journal`）
- `EventSink`（用 `CollectingSink` 记录事件流）
- `AbortSignal`（用 `new AbortController().signal`）

### 5.3 参考验证（调研结论）

**cc-remake**（cc-pi-analyst 数据）：
- cc 没有明确的"Soul / SoulPlus"拆分，但有类似的执行层/管理层分离：QueryEngine 是 per-turn 创建的执行器（≈ Soul），外部 REPL 容器持有长期状态（≈ SoulPlus 角色）
- cc 的 step 粒度事件通过 task 事件和 tool execution 事件实现，没有显式 step.begin/end——v2 的显式 step 事件对多端 UI 更友好

**pi-mono**（cc-pi-analyst 数据）：
- pi 有 `TurnStartEvent / TurnEndEvent`（对应 v2 的 step.begin/step.end，命名语义不同）
- pi 有 `ToolExecutionStart/Update/End` 事件（和 v2 的 tool.call / tool.call.delta / tool.result 对应）
- pi 的事件体系确认了 v2 的 step 事件粒度选择是正确的

**kimi-cli**（kimi-analyst 数据）：
- kimi-cli 有 `StepBegin`（含 step 编号 n）和 `StepInterrupted`，**但没有 StepEnd**——步的结束靠下一个 StepBegin 或 TurnEnd 隐式标记
- v2 显式加 `step.end` 是对 kimi-cli 的改进，遵循"有始有终"原则，UI 状态机更清晰

---

## 六、SoulPlus（运行时宿主）

### 6.1 总览（三层 DAG）

**SoulPlus = thin facade**，对外仍只暴露 `dispatch()`，但内部不再用"6 个 sub-component 平铺"描述，而是按 D10 重画为一个**三层、无循环依赖的 DAG**。6 个行为组件还在，只是它们建立在共享资源层和服务层之上，而不是彼此缠绕。

```text
SoulPlus (facade)
│
├── 共享资源层
│   ├── SessionLifecycleStateMachine
│   ├── SoulLifecycleGate
│   ├── JournalWriter
│   ├── WiredContextState
│   ├── SessionJournal
│   └── JournalCapability
│
├── 服务层
│   ├── Runtime
│   ├── ApprovalRuntime
│   ├── ConversationProjector
│   ├── ToolCallOrchestrator
│   ├── MemoryRuntime（Phase 1 no-op）
│   ├── CompactionOrchestrator（决策 #109）
│   └── PermissionClosureBuilder（决策 #109）
│
└── 行为组件层
    ├── RequestRouter
    ├── WakeQueueScheduler（决策 #109）
    ├── TurnLifecycleTracker（决策 #109）
    ├── TurnManager（瘦身版 Turn Coordinator）
    ├── SoulRegistry
    ├── SkillManager
    ├── NotificationManager
    └── TeamDaemon（可选）
```

**DAG 的关键变化**：
- `LifecycleGate` 不再由 `TurnManager` 私有持有，而是提升为共享资源层的 `SoulLifecycleGate`；内部 5 态由 `SessionLifecycleStateMachine` 管理，对 Soul 暴露的仍是 `Runtime.lifecycle` 这条 3 态窄接口。
- `SessionJournal` 与 `WiredContextState` 并列，共享同一个 `JournalWriter`。判定原则是"LLM 能不能看到"：会被 projector 组装进 Message[] 的 record（含 notification / system_reminder / memory_recalled）走 `ContextState`；纯审计 / lifecycle / 协作类 record 走 `SessionJournal`。
- `NotificationManager` 职责是"分发 + 写 ContextState"（对 `targets: ["llm"]` 直接调 `FullContextState.appendNotification`，让通知成为 durable 对话事件；对 `targets: ["wire"]` 广播到 EventBus；对 `targets: ["shell"]` 触发 shell hook）。它不再持有任何 turn-scope buffer，也不再负责触发 turn。
- `TeamDaemon` 直接面向 `TurnManager.enqueueWake()` 以及 steer / notification 注入入口，不经 `NotificationManager` 中转。

**服务层补充**：
- `ConversationProjector` 负责把 `ContextSnapshot` 投影成 provider-neutral messages；notification / system reminder / memory recall 都已经在 snapshot 中作为 durable record，projector 从同一条路径读出并组装，不再需要任何 turn-scope 临时注入参数。
- `ToolCallOrchestrator` 是 SoulPlus 内部的 tool 执行编排器，对外仍保持 `beforeToolCall` / `afterToolCall` callback 形态；内部固定阶段顺序为 `validate(Soul)` → `PreToolUse` → `permission` → `approval/display` → `execute(Soul)` → `PostToolUse` → `OnToolFailure`。
- `MemoryRuntime` 在 Phase 1 只保留 no-op 占位。未来支持 `global` / `report` / `session` 三种 scope；Phase 2 接入时 recall 结果走 `FullContextState.appendMemoryRecall` 做 durable 写入（和 CC 对齐），由 projector 从 snapshot 自然读出——不再走任何临时注入 seam，详见 §19.1。

**Team Mail 3 分类（D3）**：
- `conversation`：进入 `wakeQueue`；idle 时立即起 turn，busy 时排队，等当前 turn 结束后再投递。
- `control-steer`：直接注入当前 turn；如果当前 idle，则退化为立即 wake，而不是走排队通知。
- `notification`：由 NotificationManager 直接通过 `ContextState.appendNotification` 做 durable 写入，作为对话事件进 transcript；`info` 只等待下一次自然 turn 投影（下次 LLM 调用时 projector 自然读到），`actionable` 在 idle 时额外投一个 wake token 触发 turn。

所有进入 session 的请求仍先到 `SoulPlus.dispatch()`，由 `RequestRouter` 根据 MethodCategory 分发；只是从这一层往下的依赖关系已经固定成共享资源 → 服务 → 行为组件的单向 DAG。

下面用启动伪代码展示 `SoulPlus` 的组装顺序：

```typescript
// 事务性请求 handler 注册表，被 SoulPlus 持有、通过 getTransactionalHandler 暴露给 RequestRouter
type TransactionalHandler = (req: WireMessage) => WireResponse;
interface TransactionalHandlerRegistry {
  register(method: string, handler: TransactionalHandler): void;
  get(method: string): TransactionalHandler | undefined;
}

// ─── 6 个 facade 类型定义 ───
// SoulPlus 内部 25 个组件实例按"语义边界 + D10 三层 DAG"聚合到 6 个 facade。
// Facade 只是**字段聚合的命名空间**——纯 interface + plain object，无方法、无运行时开销。
// Facade 与 D10 三层 1:1 映射：lifecycle / journal = 共享资源层；services = 服务层；
// components = 行为组件层；infra = 外围资源；runtime 独立顶层（铁律 6 对 Soul 的契约面）。

interface LifecycleFacade {
  readonly stateMachine: SessionLifecycleStateMachine;
  readonly gate: SoulLifecycleGate;          // 暴露给 Soul 的 3 态接口（active / compacting / completing）
}

interface JournalFacade {
  readonly writer: JournalWriter;            // wire.jsonl 物理写入（含 lifecycle gate 集成）
  readonly contextState: FullContextState;   // 对话状态宽视图（含 SoulPlus 独占写法 appendUserMessage / appendNotification 等）
  readonly sessionJournal: SessionJournal;   // 管理类 record 写入窄门（turn_begin / skill_invoked / approval_*）
  readonly capability: JournalCapability;    // wire.jsonl 物理轮转能力（仅 compaction 用）
}

interface ServicesFacade {
  readonly projector: ConversationProjector;       // ContextSnapshot → provider-neutral Message[]
  readonly approvalRuntime: ApprovalRuntime;       // 跨 Soul / 跨进程 approval 编排
  readonly orchestrator: ToolCallOrchestrator;     // tool 执行编排（validate→PreToolUse→permission→approval→execute→PostToolUse→OnToolFailure）
  readonly memoryRuntime: MemoryRuntime;           // memory recall（Phase 1 no-op）
  readonly mcpRegistry: McpRegistry;               // MCP server 注册表（Phase 1 NoopMcpRegistry / Phase 3 RealMcpRegistry，详见 §17A）
  readonly compactionOrchestrator: CompactionOrchestrator;   // compaction 编排（决策 #109 从 TurnManager 拆出）
  readonly permissionClosureBuilder: PermissionClosureBuilder;  // permission 闭包构造（决策 #109 从 TurnManager 拆出）
  readonly sessionMeta: SessionMetaService;        // session 元数据真相源化（决策 #113，详见 §6.13.7 / ADR-X.113）
}

interface ComponentsFacade {
  readonly router: RequestRouter;                       // wire 入口分发
  readonly handlers: TransactionalHandlerRegistry;     // setModel / getUsage / rename 等事务 method 注册表
  readonly wakeScheduler: WakeQueueScheduler;           // wake 队列调度（决策 #109 从 TurnManager 拆出）
  readonly turnLifecycle: TurnLifecycleTracker;         // turn 生命周期追踪（决策 #109 从 TurnManager 拆出）
  readonly turnManager: TurnManager;                    // turn coordinator（瘦身版，委托 4 个子组件）
  readonly soulRegistry: SoulRegistry;                  // SoulHandle 跟踪 + implements SubagentHost
  readonly skillManager: SkillManager;                  // skill 加载 + detect + 展开
  readonly notificationManager: NotificationManager;   // 三路分发（llm/wire/shell）+ actionable 通知触 wake
  readonly teamDaemon?: TeamDaemon;                     // agent team 邮箱轮询 + 心跳（仅 team 模式启用）
}

interface InfraFacade {
  readonly eventBus: SessionEventBus;          // 会话事件分发总线；SessionEventBus extends EventSink，既可喂给 Soul 也可 fan-out 给 Transport
  readonly ownership: SessionOwnership;        // owner / observer 角色判定（RequestRouter 依赖）
  readonly toolRegistry: ToolRegistry;         // per-session 工具集（§10）
  readonly permissionRules: PermissionRule[];  // §11.4 session-scope 规则
  readonly permissionService: PermissionService; // §11 / §12 规则匹配 + approval 发起
  readonly hookEngine: HookEngine;             // §13 / §13.8 PostToolUse hook / telemetry
}

class SoulPlus {
  readonly sessionId: string;

  // ─── 6 个 facade（lifecycle / journal / runtime / services / components / infra）+ sessionId ───
  // runtime 是 6 个 facade 之一，并强调它是"对 Soul 的窄契约面"（铁律 6）——
  // 不是"额外的 1 个组件"，只是 Soul 在类型层面看到的唯一窗口。
  private lifecycle: LifecycleFacade;     // 共享资源层（lifecycle 子层）
  private journal: JournalFacade;         // 共享资源层（journal 子层）
  private runtime: Runtime;               // facade #4：对 Soul 的窄契约面（铁律 6）
  private services: ServicesFacade;       // 服务层
  private components: ComponentsFacade;   // 行为组件层
  private infra: InfraFacade;             // 外围资源

  constructor(
    sessionId: string,
    paths: PathConfig,
    runtimeDeps: { kosong: KosongAdapter },
    // ─── runtimeDeps 字段说明（决策 #93 收窄后）───
    // Phase 1 终稿 Runtime 只暴露 `kosong` 给 Soul（铁律 6 + 铁律 7）。
    // `compactionProvider` 在 SoulPlus 内部由 `new DefaultCompactionProvider(runtimeDeps.kosong)`
    // 创建并注入到 TurnManagerDeps，**不进 Runtime / 不暴露给 Soul**。
    // 嵌入方只需要传一个 KosongAdapter，不需要知道 compaction / lifecycle / journal 概念。
    //
    // teamComms 是可选的——只有 agent team 模式才需要注入
    // Phase 1 默认由调用方传入 createSqliteTeamComms({ dbPath: paths.teamCommsDb })
    // 测试场景传入 createMemoryTeamComms()
    // 单 session / 无 team 场景留 undefined，TeamDaemon 不启用
    teamComms?: TeamCommsProvider,
  ) {
    this.sessionId = sessionId;

    // ─── 阶段 1：构造 lifecycle facade（共享资源层最底层） ───
    const stateMachine = new SessionLifecycleStateMachine();
    const gate = new SoulLifecycleGate(stateMachine);
    this.lifecycle = { stateMachine, gate };

    // ─── 阶段 2：构造 journal facade（依赖 lifecycle.gate） ───
    const writer = new JournalWriter({ gate: this.lifecycle.gate, path: paths.wireJsonl });
    const contextState = new WiredContextState({ writer });
    const sessionJournal = new WiredSessionJournal({ writer });
    const capability = new DefaultJournalCapability({ writer });
    this.journal = { writer, contextState, sessionJournal, capability };

    // ─── 阶段 3：构造 infra facade（独立外围资源，不依赖任何 facade） ───
    this.infra = {
      eventBus: new SessionEventBus(),
      ownership: new SessionOwnership(/* ... */),
      toolRegistry: new ToolRegistry(/* ... */),
      permissionRules: loadSessionRules(paths),
      permissionService: new PermissionService(/* ... */),
      hookEngine: new HookEngine(/* ... */),
    };

    // 如果传入 teamComms，先 await teamComms.init() 创建表/目录等资源
    // （await 在外层 async 工厂函数 SoulPlus.create 里完成；本 constructor 假定已 init）

    // ─── 阶段 4：构造 runtime（对 Soul 的契约面，决策 #93 后仅 1 字段） ───
    // Runtime 是 SoulPlus 暴露给 Soul 的唯一窄门（铁律 6）；其他 facade Soul 类型上完全看不到。
    // compactionProvider / lifecycle / journal 不再放进 Runtime（决策 #93 / 铁律 7），
    // 由 TurnManagerDeps 持有（见 §6.4）。
    this.runtime = {
      kosong: runtimeDeps.kosong,
    };

    // ─── 阶段 5：构造 services facade（依赖 journal + runtime + infra） ───
    this.services = {
      projector: new ConversationProjector(/* ... */),
      approvalRuntime: new ApprovalRuntime({
        sessionJournal: this.journal.sessionJournal,
        eventBus: this.infra.eventBus,
      }),
      orchestrator: new ToolCallOrchestrator({
        runtime: this.runtime,
        hookEngine: this.infra.hookEngine,
        sessionJournal: this.journal.sessionJournal,
      }),
      memoryRuntime: new NoopMemoryRuntime(),   // Phase 1 占位
      mcpRegistry: new NoopMcpRegistry(),       // Phase 1 占位 / Phase 3 替换为 RealMcpRegistry（详见 §17A）
      // SessionMetaService（决策 #113）：sessionMeta 真相源化的统一收口。
      // 写 wire 走 sessionJournal，emit 事件走 eventBus，state.json 路径来自 paths。
      // 启动恢复阶段（§9.7）由 SoulPlus.create 调用 sessionMeta.recoverFromWire(records)。
      sessionMeta: new SessionMetaService({
        sessionId,
        sessionJournal: this.journal.sessionJournal,
        eventBus: this.infra.eventBus,
        paths,
      }),
    };
    // approvalRuntime 启动时恢复 pending approvals（在 async 工厂里 await）
    // await this.services.approvalRuntime.recoverPendingOnStartup();

    // ─── 阶段 6：构造 components facade（依赖前面所有；行为组件层） ───
    // 注意：Soul 是无状态函数 `runSoulTurn`，没有实例。SoulRegistry 跟踪运行中的 SoulHandle，
    // 并实现 `SubagentHost` 接口对外暴露 `spawn` 能力（见 §6.5 和 §8.2）。
    const skillManager = new SkillManager({
      paths,
      lifecycleGate: this.lifecycle.gate,
    });
    const soulRegistry = new SoulRegistry({
      // createSoul 内联构造 SoulHandle —— 不依赖任何 private 方法；具体字段装配见 §6.5
      createSoul: (key, config): SoulHandle => ({
        key,
        config,
        runtime: this.runtime,
      }),
      emitEvent: (e, d) => this.infra.eventBus.emit(e, d),
    });
    const turnManager = new TurnManager({
      detectSkill: (input) => skillManager.detectAndPrepare(input),
      getOrCreateSoul: (key) => soulRegistry.getOrCreate(key),
      sessionJournal: this.journal.sessionJournal,   // 管理类 record 走 SessionJournal 窄门（§4.5.4）
      contextState: this.journal.contextState,
      runtime: this.runtime,
      approvalRuntime: this.services.approvalRuntime,
      orchestrator: this.services.orchestrator,
      lifecycleStateMachine: this.lifecycle.stateMachine,
      sink: this.infra.eventBus,
      toolRegistry: this.infra.toolRegistry,
      sessionRules: this.infra.permissionRules,      // §11.4
      permissionService: this.infra.permissionService,
      hookEngine: this.infra.hookEngine,
      emitEvent: (e, d) => this.infra.eventBus.emit(e, d),
    });
    const notificationManager = new NotificationManager({
      // NotificationManager 直接持有 FullContextState 引用，
      // "llm" target 通过 appendNotification 走 durable 写入（见 §6.6）
      contextState: this.journal.contextState,
      emitEvent: (e, d) => this.infra.eventBus.emit(e, d),
      triggerShellHook: (n) => this.infra.hookEngine.triggerShell(n),
      // actionable 通知在 idle 时投 wake token，触发下一次 turn 以尽快让 LLM 响应
      enqueueWake: (token) => turnManager.enqueueWake(token),
    });
    const handlers = new DefaultTransactionalHandlerRegistry();
    const router = new RequestRouter({
      hasSoul: (key) => soulRegistry.has(key),
      handlePrompt: (req) => turnManager.handlePrompt(req),
      handleCancel: (req) => turnManager.handleCancel(req),
      handleSteer: (req) => turnManager.handleSteer(req),
      handleApproval: (req) => this.services.approvalRuntime.handleApprovalResponse(req),
      getTransactionalHandler: (m) => handlers.get(m),
      ownership: this.infra.ownership,
    });

    // TeamDaemon 仅 team 模式启用——注入 6 个窄依赖：
    //   { enqueueWake, injectSteer, enqueueNotification, approvalRuntime, mailbox, heartbeat }
    // 其中 mailbox 和 heartbeat 来自构造函数参数 `teamComms: TeamCommsProvider`
    // ——可插拔接口，Phase 1 默认是 SqliteTeamComms，测试用 MemoryTeamComms，详见 §8.3.2。
    //
    // enqueueNotification 是 NotificationManager.emit 的窄 callback：
    //   enqueueNotification: (notif, wakePolicy?) =>
    //     notificationManager.emit(notif, wakePolicy)
    // TeamDaemon 不直接引用 NotificationManager，所有 notification 流都走这个窄门，
    // 避免循环依赖并让 NotificationManager 保持三路分发的唯一收口。
    // 完整接口见 §8.3.3 TeamDaemonDeps。
    const teamDaemon = teamComms
      ? new TeamDaemon(
          {
            role: /* "leader" | "member" */ "leader",
            teamId: /* 由上层 TeamCreate tool 决定 */ "",
            selfSessionId: sessionId,
            pollIntervalMs: 100,       // leader=100ms, member=250ms
            heartbeatIntervalMs: 30000,
            scanAllMembers: true,      // leader=true
          },
          {
            enqueueWake: (trigger) => turnManager.enqueueWake(trigger),
            injectSteer: (input) => turnManager.injectSteer(input),
            enqueueNotification: (notif, wakePolicy) =>
              notificationManager.emit(notif, wakePolicy),
            approvalRuntime: this.services.approvalRuntime,
            mailbox: teamComms.mailbox,
            heartbeat: teamComms.heartbeat,
          },
        )
      : undefined;

    this.components = {
      router,
      handlers,
      turnManager,
      soulRegistry,
      skillManager,
      notificationManager,
      teamDaemon,
    };
  }

  // ===== Facade 入口 =====
  // connection 参数由 Transport 层在分发时提供，RequestRouter 内部用它做
  // ownership 检查（见 §6.3 RequestRouter.dispatch）。Team 模式等内部触发
  // 场景 conn 可缺省，由 RequestRouter 按默认策略放行。
  dispatch(request: WireMessage, conn?: Connection): Promise<WireResponse> {
    return this.components.router.dispatch(request, conn);
  }
}
```

> **6 facade 聚合的设计意图**（统一措辞：**6 个 facade（lifecycle / journal / runtime / services / components / infra）+ sessionId**）：上面的字段重组与 D10 三层 DAG **1:1 映射**——`lifecycle` + `journal` 是共享资源层的两个子层（lifecycle gate 反向门控 journal 写入，二者不对称依赖，分立尊重 §6.2 的 DAG）；`services` 是服务层（被 turn loop 调用的组件）；`components` 是行为组件层全员（含 router / handlers / turnManager / soulRegistry / skillManager / notificationManager / teamDaemon?）；`infra` 是外围资源；`runtime` 是 6 个 facade 之一（不是"额外的 1 个"），但语义上独立强调它是"对 Soul 的契约面"（铁律 6），是 Soul 在类型层面看到的唯一窗口。子组件的窄 deps 接口完全不变（每个子组件只拿到自己需要的字段，不传 facade 也不传 this），仅 SoulPlus 内部赋值时把 `this.xxx` 换成 `this.facade.xxx`。Soul 类型上完全看不到其他 5 个 facade——它只看到 `runtime` 这一个对象。

### 6.2 初始化顺序与依赖 DAG

`§6.1` 的核心重写目标不是"换个图"，而是把依赖关系真正改成**无循环依赖**。构造顺序固定为**共享资源层 → 服务层 → 行为组件层**，关闭顺序严格反向。

**启动顺序**（6 个 facade 阶段，与 §6.1 类定义中的 6 个 facade 字段一一对应）：

| 阶段 | 产出 facade | 装配的组件 | 依赖 |
|---|---|---|---|
| 1 | `lifecycle` | `SessionLifecycleStateMachine` → `SoulLifecycleGate` | （无） |
| 2 | `journal` | `JournalWriter` → `WiredContextState` / `WiredSessionJournal` / `DefaultJournalCapability` | `lifecycle.gate` |
| 3 | `infra` | `SessionEventBus` / `SessionOwnership` / `ToolRegistry` / `permissionRules` / `PermissionService` / `HookEngine` | （独立） |
| 4 | `runtime` | `{ kosong }` 装配（决策 #93 后字段收窄到 1，compactionProvider / lifecycle / journal 不进 Runtime） | （独立，仅 `runtimeDeps.kosong`） |
| 5 | `services` | `ConversationProjector` / `ApprovalRuntime` / `ToolCallOrchestrator` / `MemoryRuntime`（no-op）/ `McpRegistry`（Phase 1 `NoopMcpRegistry` / Phase 3 `RealMcpRegistry`，详见 §17A）/ **`CompactionOrchestrator`**（决策 #109）/ **`PermissionClosureBuilder`**（决策 #109）/ **`SessionMetaService`**（决策 #113，依赖 `sessionJournal` + `eventBus` + `paths`）；构造完调 `services.approvalRuntime.recoverPendingOnStartup()` | `journal`, `runtime`, `infra` |
| 6 | `components` | `SkillManager` → `SoulRegistry` → **`WakeQueueScheduler`** → **`TurnLifecycleTracker`** → `TurnManager`（注入 4 个子组件：compaction / wake / permissions / lifecycle） → `NotificationManager` → `handlers` → `RequestRouter` → `TeamDaemon?`（同 facade 内按依赖关系排列） | `lifecycle`, `journal`, `runtime`, `services`, `infra` |
| 恢复 | — | 启动恢复阶段（§9.7）：compaction rollback → replay wire.jsonl → ApprovalRuntime recovery → SkillManager 加载 → MCP 重连 → TeamDaemon mailbox 恢复 | 必须在 facade 构造完成后、`start()` 之前 |
| 启动 | — | `components.teamDaemon?.start()` → `components.router.start()` | — |

**facade 之间的依赖**（构造期单向 DAG，无循环）：

```text
lifecycle ──┐
            ├──→ journal ──┐
infra ──────┤              ├──→ runtime ──┐
            │              │              ├──→ services ──┐
            │              │              │               │
            └──────────────┴──────────────┴───────────────┴──→ components
```

`runtime` 是 6 个 facade 中对 Soul 的契约面（铁律 6），其他 5 个 facade（`lifecycle` / `journal` / `services` / `components` / `infra`）是 SoulPlus 内部组织方式，Soul 类型上完全不可见。

**组件级依赖 DAG**（个体节点级，facade 内部仍然遵守此顺序）：

```text
PathConfig
  ↓
SessionLifecycleStateMachine
  ↓
SoulLifecycleGate
  ↓
JournalWriter
  ├─→ WiredContextState
  ├─→ SessionJournal
  └─→ JournalCapability

KosongAdapter ─┐
CompactionProvider ─┴─→ Runtime
Runtime ─→ ConversationProjector
SessionJournal + EventBus ─→ ApprovalRuntime
Runtime + ApprovalRuntime + HookEngine + SessionJournal ─→ ToolCallOrchestrator
ConversationProjector + future MemoryStore adapters ─→ MemoryRuntime（no-op）

ToolRegistry / Skill files ─→ SkillManager
SoulFactory + EventBus ─→ SoulRegistry
SessionLifecycleStateMachine + WiredContextState + CompactionProvider + JournalCapability + EventSink ─→ CompactionOrchestrator（§6.4.1）
ToolCallOrchestrator + PermissionRules ─→ PermissionClosureBuilder（§6.4.3）
（无外部依赖）─→ WakeQueueScheduler（§6.4.2）
（无外部依赖）─→ TurnLifecycleTracker（§6.4.4）
SessionJournal + EventBus + PathConfig ─→ SessionMetaService（§6.13.7，决策 #113）
CompactionOrchestrator + WakeQueueScheduler + PermissionClosureBuilder + TurnLifecycleTracker + SessionLifecycleStateMachine + WiredContextState + SessionJournal + Runtime + ToolRegistry ─→ TurnManager（§6.4.5 瘦身版）
WiredContextState + EventBus + HookEngine + TurnManager.enqueueWake ─→ NotificationManager
TeamCommsProvider.mailbox + TeamCommsProvider.heartbeat + TurnManager.enqueueWake + TurnManager.injectSteer + NotificationManager.emit + ApprovalRuntime ─→ TeamDaemon
TurnManager + ApprovalRuntime + ownership/transaction handlers ─→ RequestRouter
```

**为什么这里没有循环依赖**：
- `SoulLifecycleGate` 已经从 `TurnManager` 内部提升到共享资源层（即 `lifecycle` facade），`JournalWriter` 不再反向等待行为组件。
- `NotificationManager` 对 `TurnManager` 的依赖只是一条单向窄 callback（`enqueueWake`，用于 actionable 通知在 idle 时拉起 turn）；`TurnManager` 不反向依赖 `NotificationManager`，不存在回环。
- `NotificationManager` 直接持有 `WiredContextState`（通过 `FullContextState` 接口）做 `appendNotification` durable 写入，但它构造顺序在 `TurnManager` 之后、`TeamDaemon` 之前，沿 DAG 单向。
- `TeamDaemon` 只持有 `TurnManager` / `NotificationManager` / `ApprovalRuntime` 的窄入口，不依赖 raw `JournalWriter`。
- `TurnManager` 只通过 `SessionJournal` / `Runtime` / `ToolCallOrchestrator` 访问下层能力，不直接 new 共享资源。

**关闭顺序**（反向遍历 facade）：
1. `components.router.stop()`，先拒绝新请求
2. 等待所有 in-flight turn 自然结束；必要时走 `components.turnManager.abortTurn(...)`
3. `components.teamDaemon?.stop()`
4. `lifecycle.stateMachine.transitionTo("destroying")`
5. 依次释放 `components` → `services` 层对象
6. `journal.writer.flush()` 排空 disk batch 队列（决策 #95：内存 pendingRecords 已经 drain 到磁盘），然后关闭底层文件句柄
7. 关闭 `infra` 层底层文件句柄与 session 级资源

**SoulPlus class 只做 6 个子组件的创建和组装**，具体的 turn lifecycle / handlePrompt / onTurnEnd / 事务性 handler 等实现，全部下放到对应的子组件：

- **TurnManager**（§6.4，决策 #109 拆分后）：`handlePrompt` / `handleCancel` / `handleSteer` / `onTurnEnd` / `startTurn`（委托 4 个子组件：CompactionOrchestrator §6.4.1 / WakeQueueScheduler §6.4.2 / PermissionClosureBuilder §6.4.3 / TurnLifecycleTracker §6.4.4）
- **SoulRegistry**（§6.5）：`getOrCreate` / `has` / `destroy` / `spawn`（implements `SubagentHost`）
- **NotificationManager**（§6.6）：`emit` / `receive`
- **SkillManager**（§15.6）
- **RequestRouter**（§6.3）

**关于通知的写入路径**（Phase 6E 定稿）：NotificationManager 是唯一的"通知写入口"，它通过 `FullContextState.appendNotification` 把 `targets: ["llm"]` 的通知直接作为 `NotificationRecord` append 到 ContextState，让通知成为 durable 对话事件进 transcript；下一次 Soul 调 `buildMessages()` 时 projector 从 snapshot 自然读出，没有任何 turn-scope 的"临时注入"中转。`system_reminder` / 未来的 `memory_recalled` 走完全对称的路径。这样"NotificationManager 写入 ContextState + ContextState 持有完整 transcript + projector 纯读投影"三者职责正交，不存在两处同时写 notification 队列的竞态，也不会出现"Turn N 看到、Turn N+1 看不到"的因果断裂。事务性 handlers 注册表由 SoulPlus 持有并通过 `getTransactionalHandler` 回调暴露给 RequestRouter（见 §6.1 `TransactionalHandlerRegistry`）。各子组件的完整伪代码见后续小节。

> 历史说明：v2 初稿（决策 #82）把 `pendingNotifications` 作为 TurnManager 的 turn-scope 内存缓冲，通过 `ConversationProjector.ephemeralInjections` 注入 LLM；Phase 6E 发现这会破坏 append-only 事实记录原则（LLM 在 N 看到的内容在 N+1 不见了，assistant 的后续引用会因果断裂），决策 #82 已撤销，替代方案是决策 #89。

### 6.3 RequestRouter

RequestRouter 负责**全局方法分类**：把 `session.*` / `approval.*` / `task.*` 等不同 method 分到 conversation / subagent / transactional 三类，交由对应的处理器。它是 SoulPlus 内部的第一级路由，没有状态机，不做 lifecycle 检查——这些都交给下游的 TurnManager。

```typescript
interface RequestRouterDeps {
  hasSoul: (key: SoulKey) => boolean;
  handlePrompt: (req: WireMessage) => Promise<WireResponse>;
  handleCancel: (req: WireMessage) => Promise<WireResponse>;
  handleSteer: (req: WireMessage) => Promise<WireResponse>;
  handleApproval: (req: WireMessage) => Promise<WireResponse>;
  getTransactionalHandler: (method: string) => ((req: WireMessage) => WireResponse) | undefined;
  ownership: SessionOwnership;
}

class RequestRouter {
  private accepting = false;

  constructor(private readonly deps: RequestRouterDeps) {}

  // 对外入口：根据 method 分类，分发到对应 handler。
  // conn 仅在外部 Transport 层请求时有值；team 模式等内部触发可缺省。
  async dispatch(msg: WireMessage, conn?: Connection): Promise<WireResponse> {
    // 1. Ownership 检查（只有 owner 可以发送修改类请求）
    //    conn 缺省视为内部可信调用，跳过 ownership 限制
    if (conn && !this.deps.ownership.canWrite(conn) && isMutating(msg.method)) {
      return { error: "not_owner" };
    }

    // 2. 按 METHOD_REGISTRY 分类路由
    const category = classifyMethod(msg.method);
    switch (category) {
      case "conversation":
        // prompt / cancel / steer —— 全部委托 TurnManager
        if (msg.method === "session.prompt")  return this.deps.handlePrompt(msg);
        if (msg.method === "session.cancel")  return this.deps.handleCancel(msg);
        if (msg.method === "session.steer")   return this.deps.handleSteer(msg);
        break;

      case "subagent_directed":
        // approval.response 等 —— 按 msg.to 字段路由到具体 Soul
        if (!this.deps.hasSoul((msg.to as SoulKey | undefined) ?? "main")) {
          return { error: "target_soul_not_found" };
        }
        return this.deps.handleApproval(msg);

      case "transactional": {
        // setModel / getUsage / rename —— 同步事务处理
        const handler = this.deps.getTransactionalHandler(msg.method);
        if (!handler) return { error: "method_not_found" };
        return handler(msg);
      }
    }

    return { error: "unroutable" };
  }
}
```

**设计要点**：
- `dispatch` 是唯一入口，SoulPlus 的 `dispatch()` 只做一行委托：`return this.router.dispatch(msg, conn)`
- RequestRouter 没有自己的状态，所有依赖通过构造器闭包注入（符合 §6.1 "子组件互不引用"原则）
- `handlePrompt` / `handleCancel` / `handleSteer` 在 deps 里声明为 `Promise<WireResponse>`，但 TurnManager 的实现内部用 fire-and-forget 启动 Soul，该 Promise 只代表"请求被接受"，不是 turn 完成

### 6.4 TurnManager（决策 #109 拆分后）

TurnManager 在决策 #109 中被拆分为 **4 个独立子组件 + 瘦身后的 TurnManager（Turn Coordinator）**。拆分遵循"按变化原因分离"原则——compaction 编排、wake 调度、permission 闭包构造、turn 生命周期追踪四个职责各自独立变化，不应耦合在同一个 class 里。拆分前的 TurnManager 持有 16 deps + 5 内部状态，是 SoulPlus 中最大的 god object；拆分后每个子组件 deps ≤ 6，瘦身后的 TurnManager 实际需要 mock 的外部 deps 降到 9 个（4 个子组件中 WakeQueueScheduler 和 TurnLifecycleTracker 无外部 deps，可用 real instance）。

> **决策 #93 调整概要（保留）**：v2 初稿把 compaction 执行流程放在 Soul 里，违反铁律 7。新设计：Soul 仅检测 + 上报 `needs_compaction`；compaction 编排权现在由 **CompactionOrchestrator**（§6.4.1）独立持有，TurnManager 的 while 循环只做委托调用。`compactionProvider` / `journalCapability` 从 Runtime 移除，下沉到 CompactionOrchestratorDeps。

```typescript
// ─── Trigger 类型（不变）───
type TurnTrigger =
  | { kind: "user_prompt"; input: UserInput }
  | {
      kind: "system_trigger";
      input: UserInput;
      reason?: string;
      source?: string;
      payload?: unknown;
    };
```

#### 6.4.1 CompactionOrchestrator

**职责**：执行 compaction 完整编排——lifecycle 切换 / snapshot / summary 生成 / 文件轮转 / context reset / post-compaction augment / tail user_message 兜底校验（决策 #101）。与决策 #93 完全对齐：Soul 只检测不执行，CompactionOrchestrator 持有编排权。

**deps**：6 个（纯服务，无 mutable 内部状态）。

```typescript
interface CompactionOptions {
  reason?: "threshold" | "overflow" | "manual";
  previousSummary?: string;
  fileOperations?: FileOperation[];
  userInstructions?: string;
}

interface CompactionOrchestratorDeps {
  lifecycleStateMachine: SessionLifecycleStateMachine;  // compacting ↔ active 切换
  contextState: FullContextState;                        // buildMessages / resetToSummary / tokenCount / getLastCompactionSummary / getCumulativeFileOps
  compactionProvider: CompactionProvider;                // summary 生成（见 §6.12.2）
  journalCapability: JournalCapability;                  // wire.jsonl 物理轮转
  emitEvent: <K extends keyof SessionEventMap>(e: K, d: SessionEventMap[K]) => void;  // compaction.begin / compaction.end
  sink: EventSink;                                       // warning 事件（tail user_message 兜底）
}

class CompactionOrchestrator {
  constructor(private readonly deps: CompactionOrchestratorDeps) {}

  /**
   * 执行完整 compaction 流程（5 步）。
   * 调用方负责 compactionCount 计数和 MAX_COMPACTIONS_PER_TURN 熔断。
   *
   * 5 步：
   *   1. lifecycle → compacting
   *   2. snapshot + compactionProvider.run() + tail user_message 兜底（决策 #101）
   *   3. journalCapability.rotate()
   *   4. contextState.resetToSummary()
   *   5. postCompactionAugment()
   *   finally: lifecycle → active
   *
   * Signal 来自 turn 级 root controller——cancel turn 应该 cancel 进行中的 compaction。
   */
  async executeCompaction(
    signal: AbortSignal,
    options?: CompactionOptions,
  ): Promise<void> {
    // 1. 切 lifecycle gate
    await this.deps.lifecycleStateMachine.transitionTo("compacting");
    try {
      this.deps.emitEvent("compaction.begin", { /* turn_id 等可选元信息 */ });

      // 2. 拍 snapshot 并生成 summary
      signal.throwIfAborted();
      const messages = this.deps.contextState.buildMessages();
      const tokensBefore = this.deps.contextState.tokenCountWithPending;

      // 决策 #96：增量 summary 上下文
      const incrementalContext = {
        previousSummary: this.deps.contextState.getLastCompactionSummary?.()?.text,
        fileOperations: this.deps.contextState.getCumulativeFileOps?.(),
      };
      const mergedOptions: CompactionOptions = {
        ...incrementalContext,
        ...options,
      };

      const output = await this.deps.compactionProvider.run(messages, signal, mergedOptions);
      signal.throwIfAborted();

      // 决策 #101：兜底校验 tail user_message 契约
      const lastInputMessage = messages[messages.length - 1];
      const lastSummaryMessage = output.summary[output.summary.length - 1];
      if (
        lastInputMessage?.role === "user" &&
        !this.isUserMessagePaired(messages, messages.length - 1) &&
        lastSummaryMessage?.role !== "user"
      ) {
        this.deps.sink.emit({
          type: "warning",
          message:
            "CompactionProvider violated tail user_message contract; auto-restoring (see §6.12.2 / 决策 #101)",
        });
        output.summary.push(lastInputMessage);
      }

      // 3. 物理文件轮转
      await this.deps.journalCapability.rotate({
        type: "compaction_boundary",
        summary: output.summary,
        parent_file: "wire.<N>.jsonl",
      });
      signal.throwIfAborted();

      // 4. 重置 ContextState 内存镜像
      await this.deps.contextState.resetToSummary(output.summary);
      if ("updateTokenCount" in this.deps.contextState) {
        await (this.deps.contextState as any).updateTokenCount(output.estimatedTokenCount);
      }
      signal.throwIfAborted();

      // 5. 可选 post-compaction augmenter hook
      await this.postCompactionAugment(this.deps.contextState);

      const tokensAfter = this.deps.contextState.tokenCountWithPending;
      this.deps.emitEvent("compaction.end", { tokensBefore, tokensAfter });
    } finally {
      await this.deps.lifecycleStateMachine.transitionTo("active");
    }
  }

  /** Post-compaction hook（默认 noop）。子类可 override 注入 background tasks 快照等。 */
  protected async postCompactionAugment(_ctx: FullContextState): Promise<void> {
    // noop by default
  }

  /** 判断 messages[idx] 的 user_message 后面是否有配对的 assistant（决策 #101 用）。 */
  protected isUserMessagePaired(messages: Message[], idx: number): boolean {
    if (messages[idx]?.role !== "user") return true;
    if (idx === messages.length - 1) return false;
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].role === "assistant") return true;
    }
    return false;
  }
}
```

#### 6.4.2 WakeQueueScheduler

**职责**：管理 auto-wake 队列——入队 / 出队 / 合并 / 判空。纯内存数据结构，无外部依赖。

**deps**：0。lifecycle gate 检查（idle 时直接 startTurn，非 idle 时入 wakeQueue）留在 TurnManager 层，WakeQueueScheduler 不知道 lifecycle 概念（对齐 pi-mono `PendingMessageQueue` 模式——队列只管数据结构，策略在外层）。

**内部状态**：`queue: TurnTrigger[]`。

```typescript
class WakeQueueScheduler {
  private queue: TurnTrigger[] = [];

  enqueue(trigger: TurnTrigger): void {
    this.queue.push(trigger);
  }

  dequeue(): TurnTrigger | null {
    return this.queue.shift() ?? null;
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** 合并所有 pending triggers 为一个 system_trigger 并出队。 */
  mergeAndDequeue(): TurnTrigger | null {
    if (this.queue.length === 0) return null;
    const triggers = this.queue.splice(0);
    return this.mergeWakeTriggers(triggers);
  }

  clear(): void {
    this.queue.length = 0;
  }

  private mergeWakeTriggers(triggers: TurnTrigger[]): TurnTrigger {
    const texts = triggers.map(t => t.input.text).filter(Boolean);
    return {
      kind: "system_trigger",
      input: { text: texts.join("\n\n") },
      reason: "merged_wake",
    };
  }
}
```

#### 6.4.3 PermissionClosureBuilder

**职责**：捕获 turn 级 id / overrides，组装 `beforeToolCall` / `afterToolCall` 闭包。真正的权限规则展开在 ToolCallOrchestrator（§11.7），本组件只做参数拼装。**独立组件**，不合并到 ToolCallOrchestrator——二者变化节奏不同（permission 规则扩展 vs tool 执行阶段变更）。

**deps**：2（纯函数式构造器，无 mutable 内部状态）。

> 注：原 TurnManagerDeps 中 `permissionService` 和 `hookEngine` 只被 `orchestrator.buildBeforeToolCall` 内部使用，PermissionClosureBuilder 不需要持有它们——它们留在 ToolCallOrchestrator 的 deps 里。

```typescript
interface PermissionClosureBuilderDeps {
  orchestrator: ToolCallOrchestrator;   // buildBeforeToolCall / buildAfterToolCall 的 canonical 实现
  sessionRules: PermissionRule[];       // session-scope 规则
}

interface PermissionClosureBuildArgs {
  turnId: string;
  stepNumber: number;
  approvalSource: ApprovalSource;
  fullOverrides: FullTurnOverrides | undefined;
}

class PermissionClosureBuilder {
  constructor(private readonly deps: PermissionClosureBuilderDeps) {}

  build(args: PermissionClosureBuildArgs): {
    beforeToolCall: NonNullable<SoulConfig["beforeToolCall"]>;
    afterToolCall: NonNullable<SoulConfig["afterToolCall"]>;
  } {
    return {
      beforeToolCall: this.deps.orchestrator.buildBeforeToolCall(
        args.fullOverrides ?? {},
        this.deps.sessionRules,
        args.approvalSource,
      ),
      afterToolCall: this.deps.orchestrator.buildAfterToolCall(),
    };
  }
}
```

#### 6.4.4 TurnLifecycleTracker

**职责**：管理 turn 级生命周期令牌——创建 turn（分配 ID + abort controller + promise）、取消 turn、等待 turn 完成。

**deps**：0（abort 标准顺序的 cancelBySource / discardStreaming 步骤由 TurnManager 编排，TurnLifecycleTracker 只管 controller.abort + await promise）。

**内部状态**：`turnPromises` / `turnAborts` / `turnIdCounter`（3 个字段）。

```typescript
interface TurnHandle {
  turnId: string;
  signal: AbortSignal;
  controller: AbortController;
}

class TurnLifecycleTracker {
  private turnPromises = new Map<string, Promise<void>>();
  private turnAborts = new Map<string, AbortController>();
  private turnIdCounter = 0;

  /** 创建一个新 turn：分配 turnId + AbortController。 */
  createTurn(): TurnHandle {
    const turnId = `turn_${++this.turnIdCounter}`;
    const controller = new AbortController();
    this.turnAborts.set(turnId, controller);
    return { turnId, signal: controller.signal, controller };
  }

  /** 注册 turn promise（startTurn 的 async IIFE）。 */
  registerPromise(turnId: string, promise: Promise<void>): void {
    this.turnPromises.set(turnId, promise);
  }

  /**
   * 取消 turn。无 turnId 时取消最新的。
   * 注意：§7.2 abort 标准顺序的前两步（cancelBySource → discardStreaming）
   * 由 TurnManager 编排。本方法只做 controller.abort + await promise。
   */
  async cancelTurn(turnId?: string): Promise<void> {
    const controller = turnId
      ? this.turnAborts.get(turnId)
      : [...this.turnAborts.values()].at(-1);
    controller?.abort();
    const targetId = turnId ?? [...this.turnAborts.keys()].at(-1);
    if (targetId) await this.turnPromises.get(targetId);
  }

  async awaitTurn(turnId: string): Promise<void> {
    await this.turnPromises.get(turnId);
  }

  abortAll(reason: string): void {
    for (const controller of this.turnAborts.values()) {
      controller.abort(reason);
    }
  }

  /** turn 结束时清理：从 turnAborts / turnPromises 移除。 */
  cleanup(turnId: string): void {
    this.turnAborts.delete(turnId);
    this.turnPromises.delete(turnId);
  }

  getController(turnId: string): AbortController | undefined {
    return this.turnAborts.get(turnId);
  }
}
```

#### 6.4.5 TurnManager（瘦身版 Turn Coordinator）

**保留的职责**：`handlePrompt` / `handleCancel` / `handleSteer` / `enqueueWake` / `injectSteer` / `startTurn`（用新组件 API 重写） / `onTurnEnd`。TurnManager **不再直接持有** compaction 逻辑、wake 队列、permission 闭包构造、turn abort/promise map——全部委托给 §6.4.1-6.4.4 的四个子组件。

**瘦身后 deps**：13（4 子组件 + 9 外部 deps），实际需要 mock 的外部 deps = 9。

```typescript
interface SlimTurnManagerDeps {
  // ─── 4 个子组件 ───
  compaction: CompactionOrchestrator;
  wake: WakeQueueScheduler;
  permissions: PermissionClosureBuilder;
  lifecycle: TurnLifecycleTracker;
  // ─── 剩余 deps ───
  detectSkill: (input: string) => SkillPrepareResult | null;
  getOrCreateSoul: (key: SoulKey) => SoulHandle;
  sessionJournal: SessionJournal;
  emitEvent: <K extends keyof SessionEventMap>(e: K, d: SessionEventMap[K]) => void;
  contextState: FullContextState;
  runtime: Runtime;
  lifecycleStateMachine: SessionLifecycleStateMachine;
  sink: EventSink;
  toolRegistry: ToolRegistry;
}

class TurnManager {
  // ===== 内部状态（瘦身后仅 1 个） =====
  private pendingContextEdits: WireMessage[] = [];   // Phase 1 始终为空

  constructor(private readonly deps: SlimTurnManagerDeps) {}

  // ===== 对外方法 =====

  async handlePrompt(req: WireMessage): Promise<WireResponse> {
    if (!this.deps.lifecycleStateMachine.isIdle()) {
      return { error: "agent_busy" };
    }
    const input: UserInput = req.data.input;
    const trigger: TurnTrigger = { kind: "user_prompt", input };
    const turnId = this.startTurn(trigger);
    return { turn_id: turnId, status: "started" };
  }

  async handleCancel(req: WireMessage): Promise<WireResponse> {
    const turnId = req.data.turn_id as string | undefined;
    // §7.2 abort 标准顺序：1. cancelBySource → 2. discardStreaming → 3. lifecycle.cancelTurn
    if (turnId) {
      const source: ApprovalSource = { kind: "turn", turn_id: turnId };
      // cancelBySource 通过 SlimTurnManagerDeps 间接访问 approvalRuntime
      // （实际由 SoulPlus 在构造时注入回调，不直接引用 ApprovalRuntime 避免 deps 膨胀）
    }
    await this.deps.lifecycle.cancelTurn(turnId);
    return {};
  }

  async handleSteer(req: WireMessage): Promise<WireResponse> {
    const input: UserInput = req.data.input;
    await this.injectSteer(input);
    return {};
  }

  async injectSteer(input: UserInput): Promise<void> {
    await this.deps.contextState.addUserMessages([input]);
  }

  // Auto-wake 入口：被 TeamDaemon / SubagentCompletion 调用
  // 注意：TeamDaemon 通过 TurnManager 的窄 callback 透传调用 wake.enqueue，
  // 不直接引用 WakeQueueScheduler（见 §8.3.3）。
  enqueueWake(trigger: TurnTrigger): void {
    if (this.deps.lifecycleStateMachine.isIdle()) {
      this.startTurn(trigger);
    } else {
      this.deps.wake.enqueue(trigger);
    }
  }

  // ===== 内部方法 =====

  private startTurn(trigger: TurnTrigger): string {
    // 1. 创建 turn handle（委托 TurnLifecycleTracker）
    const turn = this.deps.lifecycle.createTurn();
    const { turnId, signal } = turn;
    const approvalSource: ApprovalSource = { kind: "turn", turn_id: turnId };

    // 2. Skill detection
    const skillResult = trigger.kind === "user_prompt"
      ? this.deps.detectSkill(trigger.input.text)
      : null;
    const turnText = skillResult?.expandedPrompt ?? trigger.input.text;
    const turnInput: UserInput = { text: turnText, attachments: trigger.input.attachments };

    // 3. Overrides 拆分
    const fullOverrides = skillResult?.overrides;
    const soulOverrides: SoulTurnOverrides | undefined = fullOverrides && {
      model: fullOverrides.model,
      activeTools: fullOverrides.activeTools,
      effort: fullOverrides.effort,
    };

    // 4. 构造 SoulConfig（委托 PermissionClosureBuilder）
    const { beforeToolCall, afterToolCall } = this.deps.permissions.build({
      turnId,
      stepNumber: 0,
      approvalSource,
      fullOverrides,
    });
    const soulConfig: SoulConfig = {
      tools: this.deps.toolRegistry.list(),
      beforeToolCall,
      afterToolCall,
    };

    // 5. SoulHandle 注册
    this.deps.getOrCreateSoul("main");

    // 6. 启动 turn 循环
    this.deps.lifecycleStateMachine.transitionTo("active");
    const promise = (async () => {
      let cumulativeSteps = 0;
      const cumulativeUsage: TokenUsage = { input: 0, output: 0 };
      const MAX_COMPACTIONS_PER_TURN = 3;
      let compactionCount = 0;

      try {
        await this.deps.contextState.appendUserMessage(turnInput);
        this.deps.sessionJournal.appendTurnBegin({ turn_id: turnId });
        if (skillResult) {
          this.deps.sessionJournal.appendSkillInvoked({ turn_id: turnId });
        }

        let finalResult: TurnResult | undefined;
        let endReason: "done" | "cancelled" | "error" = "done";
        let endError: unknown = undefined;

        while (true) {
          let result: TurnResult;
          try {
            result = await runSoulTurn(
              turnInput, soulConfig, this.deps.contextState,
              this.deps.runtime, this.deps.sink, signal, soulOverrides,
            );
          } catch (err) {
            // 路径 B：ContextOverflowError → compaction（委托 CompactionOrchestrator）
            if (isContextOverflowError(err)) {
              compactionCount++;
              if (compactionCount > MAX_COMPACTIONS_PER_TURN) {
                endReason = "error";
                endError = new Error("compaction loop: max_compactions_per_turn exceeded");
                break;
              }
              await this.deps.compaction.executeCompaction(signal, { reason: "overflow" });
              signal.throwIfAborted();
              continue;
            }
            throw err;
          }

          cumulativeSteps += result.steps;
          cumulativeUsage.input += result.usage.input;
          cumulativeUsage.output += result.usage.output;

          if (result.reason === "needs_compaction") {
            // 路径 A：Soul 主动检测 → compaction（委托 CompactionOrchestrator）
            compactionCount++;
            if (compactionCount > MAX_COMPACTIONS_PER_TURN) {
              endReason = "error";
              endError = new Error("compaction loop: max_compactions_per_turn exceeded");
              break;
            }
            await this.deps.compaction.executeCompaction(signal);
            signal.throwIfAborted();
            continue;
          }

          finalResult = result;
          endReason = result.reason === "end_turn" ? "done"
            : result.reason === "aborted" ? "cancelled" : "error";
          break;
        }

        this.deps.sessionJournal.appendTurnEnd({ turn_id: turnId, reason: endReason, usage: cumulativeUsage });
        if (endReason === "error") {
          this.deps.emitEvent("session.error", { error: String(endError ?? "unknown") });
        }
        this.deps.emitEvent("turn.end", { turn_id: turnId, reason: endReason, usage: cumulativeUsage });
      } catch (err) {
        const reason = signal.aborted ? "cancelled" : "error";
        if (reason === "error") {
          this.deps.emitEvent("session.error", { error: err instanceof Error ? err.message : String(err) });
        }
        this.deps.sessionJournal.appendTurnEnd({ turn_id: turnId, reason, usage: cumulativeUsage });
        this.deps.emitEvent("turn.end", { turn_id: turnId, reason, usage: cumulativeUsage });
      } finally {
        this.deps.lifecycle.cleanup(turnId);
        this.onTurnEnd();
      }
    })();
    this.deps.lifecycle.registerPromise(turnId, promise);
    return turnId;
  }

  private onTurnEnd(): void {
    this.deps.lifecycleStateMachine.transitionTo("completing");

    // 1. 处理 pending context edits（Phase 1 noop）
    for (const edit of this.pendingContextEdits.splice(0)) {
      /* apply edit */
    }

    // 2. 检查 wake queue（委托 WakeQueueScheduler）
    const nextTrigger = this.deps.wake.mergeAndDequeue();
    if (nextTrigger) {
      this.deps.lifecycleStateMachine.transitionTo("active");
      this.startTurn(nextTrigger);
    } else {
      this.deps.lifecycleStateMachine.transitionTo("idle");
    }
  }
}
```

**拆分后的 deps 对比**：

| 组件 | deps 数量 | 内部状态 | 可测试性（mock 行数） |
|------|-----------|---------|---------------------|
| CompactionOrchestrator | 6 | 0 | mock 6 deps ≈ 30 行 |
| WakeQueueScheduler | 0 | queue | 纯内存结构，0 mock |
| PermissionClosureBuilder | 2 | 0 | mock 2 deps ≈ 10 行 |
| TurnLifecycleTracker | 0 | turnPromises / turnAborts / turnIdCounter | 0 mock |
| TurnManager（瘦身） | 13（含 4 子组件） | pendingContextEdits | mock 9 外部 deps ≈ 50 行 |
| **拆分前 TurnManager** | **16** | **5** | **mock 16 deps ≈ 80-120 行** |

**状态机约束**（不变）：`deps.lifecycleStateMachine` 管 5 态 `idle / active / completing / compacting / destroying`，TurnManager 日常只驱动 `idle → active → completing → (idle | active)` 子图，`completing` 期间 `isIdle()` 返回 false，保证 teammate 消息正确入 wakeQueue 而不是触发重复 startTurn。具体转换语义见 §6.12.2 LifecycleGate / SessionLifecycleStateMachine。

**关键变化**：
- `turnPromises` / `turnAborts` / `turnIdCounter` 移入 TurnLifecycleTracker（§6.4.4）
- `wakeQueue` / `mergeWakeTriggers` 移入 WakeQueueScheduler（§6.4.2）
- `executeCompaction` / `postCompactionAugment` / `isUserMessagePaired` 移入 CompactionOrchestrator（§6.4.1）
- `buildBeforeToolCall` / `buildAfterToolCall` 移入 PermissionClosureBuilder（§6.4.3）
- `approvalSource` 形态固定为 `{kind: "turn", turn_id}`，和 §12.2 / 附录 B 的 canonical union 一致

### 6.5 SoulRegistry

SoulRegistry 管理同一个 session 内的多个 Soul handle（`main` / `sub:<id>` / `independent:<id>`），是 subagent（Task tool）和 agent team 成员创建路径的落脚点。它 **`implements SubagentHost`**——§8.2 `SubagentHost` 接口的唯一正式实现就在这里。

```typescript
// Soul handle 的对外类型（非 class 实例——Soul 仍然是无状态函数 runSoulTurn；
// SoulHandle 只是一个轻量 wrapper，跟踪运行中的 turn 和 AbortController）
interface SoulHandle {
  readonly key: SoulKey;
  readonly agentId: string;
  readonly abortController: AbortController;
  readonly config: SoulConfig;
}

// ─── SoulKey 扩展：支持三种 Soul 身份 ───
// 注：independent:* 是 agent team member（v2 预留，和 §6.11 图保持一致）
type SoulKey =
  | "main"
  | `sub:${string}`
  | `independent:${string}`;

interface SpawnRequest {
  parentAgentId: string;
  agentName: string;
  prompt: string;
  contextState?: FullContextState;   // 未指定则新建
  runInBackground?: boolean;
  description?: string;
  model?: string;

  // ─── 决策 #99 / SkillTool fork 模式专用（§15.9.3） ───
  // 让 SubagentHost 在装配子 SoulConfig.tools 时按 allowed/disallowed 过滤，
  // 并新建子 SkillTool 实例时传 queryDepth = skillContext.queryDepth（沿 sub-agent 链 +1）。
  // 非 skill fork 调用方传 undefined。
  // 命名约定（B7）：TypeScript 接口层统一用 camelCase；落 wire record 时由 schema 转 snake_case
  //   （wire `skill_invoked` / `skill.invoked` 事件保留 `query_depth` snake_case，已落地的 record schema 不动）。
  skillContext?: {
    queryDepth: number;            // 子 Soul 的 SkillTool queryDepth（父 + 1，受 MAX_SKILL_QUERY_DEPTH 限制）
    allowedTools?: string[];       // 子 SoulConfig.tools 过滤白名单（来自 skill frontmatter allowedTools）
    disallowedTools?: string[];    // 子 SoulConfig.tools 过滤黑名单
  };
}

interface SubagentHandle {
  agentId: string;
  completion: Promise<AgentResult>;
}

// AgentResult 是 subagent 完成后的返回结构。Phase 1 最小契约见附录 D；
// stopReason / usage / output text / task_stop 等字段由 §8.2 Task tool 定义。
// 这里只是类型引用，具体字段集在附录 D.8 AgentResult schema。

// generateAgentId: 生成策略见 §8.2——Phase 1 用 `crypto.randomUUID().slice(0, 12)`
// 的短 id 即可满足 SoulKey 唯一性；正式实现见 §8.2 `SubagentHost.spawn` 的 id 分配。

interface SoulRegistryDeps {
  // 创建 SoulHandle 的工厂——SoulPlus 在装配时注入，负责把 session 级 ContextState / Runtime 闭包
  // 注入到 SoulConfig；注意对 "main" 有默认 fallback，其他 key 若未传 config 才 throw
  createSoul: (key: SoulKey, config?: SoulConfig) => SoulHandle;
  emitEvent: <K extends keyof SessionEventMap>(e: K, d: SessionEventMap[K]) => void;
}

class SoulRegistry implements SubagentHost {
  // ===== 内部状态 =====
  private souls: Map<SoulKey, SoulHandle> = new Map();
  private destroyCallbacks: Map<SoulKey, () => void> = new Map();

  constructor(private readonly deps: SoulRegistryDeps) {}

  // ===== 对外方法 =====

  // `main` 没有显式 config 时走默认 fallback（由 createSoul 工厂内部兜底）——
  // 这样 TurnManager 可以直接 `getOrCreateSoul("main")` 而不需要自己传 config。
  // 其他 key（sub:*/independent:*）必须提供 config，否则抛 Error。
  getOrCreate(key: SoulKey, config?: SoulConfig): SoulHandle {
    const existing = this.souls.get(key);
    if (existing) return existing;

    if (key !== "main" && !config) {
      throw new Error(`Soul ${key} not found and no config provided`);
    }
    const handle = this.deps.createSoul(key, config);
    this.souls.set(key, handle);
    // 把 destroy 时要 abort 的动作登记到 destroyCallbacks，保证 destroy() 能先触发 AbortSignal
    // 用 const 捕获 handle，避免 non-null assertion
    this.destroyCallbacks.set(key, () => handle.abortController.abort());
    this.deps.emitEvent("subagent.created", { agent_id: handle.agentId });
    return handle;
  }

  has(key: SoulKey): boolean {
    return this.souls.has(key);
  }

  destroy(key: SoulKey): void {
    const handle = this.souls.get(key);
    if (!handle) return;
    // 1. 先触发 AbortSignal
    this.destroyCallbacks.get(key)?.();
    // 2. 清理 map
    this.souls.delete(key);
    this.destroyCallbacks.delete(key);
    // 3. emit 销毁事件
    this.deps.emitEvent("subagent.destroyed", { agent_id: handle.agentId });
  }

  // ===== SubagentHost 实现（§8.2）=====
  //
  // 占位实现（Phase 1 scaffolding）：本方法只演示骨架和 signature。真正的 SubagentHost
  // 语义——parentAgentId / agentName / prompt / contextState / runInBackground / description
  // 各字段如何参与 config 构造、foreground/background 分派、abort 级联、completion 链路——
  // 都集中在 §8.2。这里有意忽略 request 的大部分字段，不是 bug 而是"节流"：§6.5 只负责
  // 把 SoulRegistry 和 SubagentHost 接口绑定，避免 §5 与 §8 的实现细节互相 forward-reference。
  async spawn(request: SpawnRequest): Promise<SubagentHandle> {
    const agentId = `sub_${generateAgentId()}`;    // 生成策略见 §8.2
    const key: SoulKey = `sub:${agentId}`;

    // 默认 config：工具集从 session 继承，beforeToolCall / afterToolCall 由 SubagentHost 注入
    // （不在这里展开闭包构造，细节见 §8.2 + §11.7）
    const config: SoulConfig = {
      tools: /* 继承或裁剪自 session toolRegistry */ [],
      /* beforeToolCall / afterToolCall 由 SubagentHost 构造 */
    };

    const handle = this.getOrCreate(key, config);

    // fire-and-forget 启动 subagent 的 runSoulTurn
    // 注意：真实实现需要读 request.prompt 构造初始 UserInput、读 request.parentAgentId 建立
    // subagent 状态机的 parent 反向指针、读 request.runInBackground 决定 abort 级联策略——全部见 §8.2
    const completion: Promise<AgentResult> = (async () => {
      // ... 走 Task tool 的 foreground / background 分派，完成后 destroy(key)
      return { /* result */ } as AgentResult;
    })();

    return { agentId, completion };
  }
}
```

**生命周期约束**：
- `main` Soul 的生命周期等同于 SoulPlus 实例
- `sub:*` Soul 在 Task tool 执行结束时由 Task tool 自己触发 `destroy`
- `independent:*` Soul 只在**同进程** agent team member 视图下存在（v2 第一阶段的预留形态），由 TeamDaemon 触发本地 `destroy`；**多进程 team 模式下 member 是独立的 SoulPlus 进程**，SoulRegistry 不跨进程管理对方的生命周期——对端生命周期由 TeamDaemon + SQLite heartbeat 监控，和本地 SoulRegistry 无关
- `destroy` 顺序：**先 abort AbortSignal**（`destroyCallbacks.get(key)?.()`），然后清理关联的 tool call / approval state，最后从 map 中移除
- `destroyCallbacks` 的写入路径统一走 `getOrCreate`——每次创建 handle 都会立刻登记一个 `() => handle.abortController.abort()`，保证 destroy 时一定能找到 abort 入口

**事件转发（独立存储 + source 标记）**：

SoulRegistry 创建子 Soul 时，**不把子 Soul 的事件嵌套包装回写父 wire**（旧 `subagent.event` 方案已废弃，见决策 #88）。它给子 Soul 注入一个 EventSink **wrapper**，wrapper 做两件事：

1. **写子 wire 持久化**：把 `SoulEvent` 落盘到 `subagents/<agent_id>/wire.jsonl`（和主 wire 同构，复用 `WireRecord` 类型，不带 `source`）
2. **加 source 标记转发 EventBus**：把同一个事件带上 `source: { id: agentId, kind: "subagent", name: agentName }` emit 到 session 共享的 EventBus（`SessionEventBus`）——UI 侧据此在一条事件流上实时看到所有 agent（主 + 子 + teammate）的动作，并根据 `source.kind` 决定渲染策略

伪代码：

```typescript
function makeSubagentEventSink(
  agentId: string,
  agentName: string | undefined,
  subJournalWriter: JournalWriter,     // 指向 subagents/<agentId>/wire.jsonl
  sharedEventBus: SessionEventBus,     // 共享 UI 事件总线
): EventSink {
  return {
    emit(event: SoulEvent) {
      // 1. 持久化到子 wire（和主 wire 同构，不带 source）
      subJournalWriter.append(wireRecordFrom(event));
      // 2. 加 source 标记广播到共享 EventBus（仅传输层，不污染持久化）
      // 注意：sharedEventBus.emit 会重新分配 seq（决策 #106，§6.13.6 seq 语义规范），
      // 不沿用子 EventBus 的 seq。子 wire 是 source-of-truth，sharedEventBus 是衍生流。
      sharedEventBus.emit({ ...event, source: { id: agentId, kind: "subagent", name: agentName } });
    },
  };
}
```

此外，父 wire 在 spawn / 完成 / 失败三个时机由 `SubagentHost` 写入 `subagent_spawned` / `subagent_completed` / `subagent_failed` record（见 §3.6.1 / §8.2）。Replay 时父 wire 遇到 `subagent_spawned` 就按 `agent_id` 递归打开子 wire 展开，或者直接 `readdir(subagents/)` 全量发现。

### 6.6 NotificationManager

NotificationManager 统一处理 Notification 的**三路分发**（`llm` / `wire` / `shell`），确保通知的持久化、UI 广播、LLM 可见性是原子的。呼应 §3.6 事件类型和 §6.4 TurnManager 的通知语义。

```typescript
// canonical target 取值与 wire schema 对齐（见附录 B）：
//   - "llm"   → 通过 FullContextState.appendNotification 写入 durable transcript，
//               作为 NotificationRecord 进 wire.jsonl；下次 Soul 调 buildMessages()
//               时 projector 从 snapshot 自然读出并组装为系统消息
//   - "wire"  → 通过 EventBus 广播 notification 事件给所有 connection
//   - "shell" → 触发 shell hook（用户脚本、桌面通知等）
//
// 产生方只透传 (notif, wakePolicy?)。targets 由 NotificationManager 内部根据
// notification.category / type 自动决定（例如 team 类默认 llm+wire，permission
// 默认 wire+shell，等等），调用方无需关心。
interface NotificationManagerDeps {
  // NotificationManager 只持有 4 个窄 callback —— 不直接引用 TurnManager / JournalWriter / HookEngine / EventBus
  contextState: FullContextState;                                 // "llm" target 走 appendNotification durable 写入
  emitEvent: <K extends keyof SessionEventMap>(e: K, d: SessionEventMap[K]) => void;  // 广播 notification 事件给 UI
  triggerShellHook: (n: NotificationData) => void;                // 触发 shell hook（用户脚本、桌面通知）
  enqueueWake: (trigger: TurnTrigger) => void;                    // actionable 通知在 idle 时投 wake token 触发下一 turn
}

class NotificationManager {
  constructor(private readonly deps: NotificationManagerDeps) {}

  // 对外入口：任意组件（Soul / hook / TeamDaemon / subagent）都通过 emit 发通知。
  // wakePolicy 缺省 "next-turn"；actionable 类型（如 shutdown_request）由产生方
  // 显式传 "immediate"。
  //
  // 决策 #103：emit 是 async，返回 Promise<void>。调用方（尤其是 TeamDaemon）
  // **必须 await** 此方法，以保证"先 side-effect（durable 写入）后 ack"的
  // at-least-once 语义。如果不 await 就 mailbox.ack，崩溃窗口内可能出现
  // "SQL 已 ack 但 ContextState 写入未发起"的通知丢失。
  async emit(notif: NotificationData, wakePolicy?: "next-turn" | "immediate"): Promise<void> {
    const targets = this.resolveTargets(notif);
    const enrichedNotif = { ...notif, targets };

    // 1. "llm" target：走 ContextState durable 写入（这一步本身就会 append 一行
    //    NotificationRecord 到 wire.jsonl——对"llm" target 而言，写 ContextState
    //    即完成持久化，不需要再单独走审计路径）
    if (targets.includes("llm")) {
      await this.deps.contextState.appendNotification(enrichedNotif);
    }

    // 2. "wire" target：EventBus 广播给订阅者（EventSink / Transport fan-out）
    if (targets.includes("wire"))  this.deps.emitEvent("notification", enrichedNotif);

    // 3. "shell" target：触发本地 hook
    if (targets.includes("shell")) this.deps.triggerShellHook(enrichedNotif);

    // 4. actionable wake：idle 时投 wake token，让 LLM 尽快处理
    if (wakePolicy === "immediate" && targets.includes("llm")) {
      this.deps.enqueueWake({
        kind: "system_trigger",
        input: { text: "" },
        reason: "notification",
        source: `notification:${notif.category}`,
        payload: notif,
      });
    }
  }

  // 接收入口：TeamDaemon 从 SQLite 读到 team_mail 时调用
  async receive(notif: NotificationData, wakePolicy?: "next-turn" | "immediate"): Promise<void> {
    // 和 emit 相同路径，只是语义上表示"外部进来的"而非"本地产生的"
    await this.emit(notif, wakePolicy);
  }

  // 根据 notification.category / type 决定三路分发
  private resolveTargets(notif: NotificationData): ("llm" | "wire" | "shell")[] {
    // canonical 映射（Phase 1 静态表；后续可由配置覆写）：
    //   - "team"       → ["llm", "wire"]
    //   - "permission" → ["wire", "shell"]
    //   - "system"     → ["llm", "wire"]
    //   - "progress"   → ["wire"]
    // 具体映射表见 §4.3 NotificationRecord 的 category 枚举
    return notif.targets ?? ["llm", "wire"];
  }
}
```

**铁律对接**：NotificationManager 是唯一允许"把通知作为 durable 对话事件写入 transcript"的组件——Soul 不感知它的存在。它通过 `FullContextState.appendNotification` 直接把 `targets: ["llm"]` 的通知 append 成 `NotificationRecord`，作为对话事件永久保存；projector 在下次 `buildMessages()` 时把它组装为系统消息进 LLM 输入。这样通知的因果链在 Turn N 和 Turn N+1 之间不会断裂——LLM 在 Turn N 看到的通知，Turn N+1 仍然看得到，可以安全地引用。

> 历史说明：Phase 6D（决策 #82）曾把 `pendingNotifications` 放在 TurnManager 作为 turn-scope 缓冲，通过 `ConversationProjector.ephemeralInjections` 一次性注入 LLM。这会造成"Turn N 看到、Turn N+1 看不到"的因果断裂（assistant 引用通知内容时会在下一轮上下文里找不到原始事实），Phase 6E 撤销，改走 ContextState durable 路径（决策 #89）。System reminder / memory recall 走同一条路径。

### 6.7 SkillManager

SkillManager 的完整接口和实现见 **§15.6**（Skill 系统章节）。这里在 §6.1 的子组件列表中仅声明它是 SoulPlus 的 6 个子组件之一：

- **位置**：SoulPlus 内部，TurnManager 通过 `detectSkill(input)` 调用它
- **职责**：加载 skill 定义文件 → 检测 `/` 前缀 → 模板展开 → 构造 `FullTurnOverrides`
- **返回**：`SkillPrepareResult`（见 §15.6 和附录 D.7）
- **Phase 1 范围**：inline 执行 + fork 执行两种模式，具体 detect 逻辑见 §15.4

SkillManager 不需要在 §6.1 展开 class 定义——它的内部状态和完整签名都集中在 §15.6。

### 6.8 TeamDaemon

TeamDaemon 的完整接口和实现见 **§8.3.3**（Agent Team 章节）。这里在 §6.1 的子组件列表中仅声明它是 SoulPlus 的**可选**子组件（只有 agent team 模式启用——SoulPlus constructor 可选注入 `teamComms: TeamCommsProvider`）：

- **位置**：SoulPlus 内部，独立的 100ms（leader）/ 250ms（member）轮询 loop
- **职责**：从 `TeamCommsProvider.mailbox` 读取新到达的 envelope（team_mail / approval_request / approval_response / shutdown_request），按分类走 auto-wake / steer / notification / approval 四条路径；按消息优先级排序后 dispatch（`shutdown_request > approval_* > team_mail`）；周期性调用 `mailbox.cleanup` 回收老消息
- **依赖形态**：6 个窄依赖 `{ enqueueWake, injectSteer, enqueueNotification, approvalRuntime, mailbox, heartbeat }`——其中 `mailbox` / `heartbeat` 是 `TeamCommsProvider` 的两个窄接口（§8.3.2），TeamDaemon 不知道背后是 SQLite / File / Redis / Memory；不直接引用 TurnManager / NotificationManager / SoulPlus / raw JournalWriter，避免循环依赖和 god-object 耦合；完整接口见 §8.3.3 `TeamDaemonDeps`
- **Phase 1 范围**：poll + 优先级排序 + dedupe + wake + approval 双向路径 + 周期性 cleanup，具体崩溃一致性见 §9.4.1

TeamDaemon 不在 §6.1 展开——它的状态机、at-least-once 语义、崩溃恢复集中在 §8.3.3。

### 6.9 三类请求的路由规则

| 请求类型 | 路由目标 | 示例 method | 响应方式 |
|---------|---------|------------|---------|
| **对话请求** | `souls["main"]` | `session.prompt`, `session.cancel`, `session.steer` | 非阻塞（prompt 立即返回 turn_id） |
| **subagent 定向** | `souls["sub:<id>"]` | `approval.response`（给特定 subagent） | 同步 |
| **事务性请求** | SoulPlus 自身 | `setModel`, `getUsage`, `rename`, `getHistory` | 同步，微秒级 |

**关键区别**：
- **全局 Router**：根据 `session_id` 找到 SoulPlus 实例
- **SoulPlus 内部路由器**：根据 `method` + `to` 字段，决定走哪个 Soul 还是事务性处理

调用方（全局 Router）只看到 `SoulPlus.dispatch(request)`，不知道内部有几个 Soul、哪些在跑。

### 6.10 完整请求流

```
Wire msg
   ↓
Router → SessionManager.get(session_id) → SoulPlus.dispatch(request)
                                                   ↓
                                         RequestRouter.dispatch  (§6.3)
                                                   ↓
          ┌────────────────┬──────────────────────┴──────────────────────┐
          ↓                ↓                                             ↓
     category =        category =                                   category =
    "conversation"    "subagent_directed"                          "transactional"
          │                │                                             │
          ↓                ↓                                             ↓
  TurnManager.          SoulRegistry                          handlers.get(method)?.(req)
  handlePrompt /           ↓                                  直接读写 session 共享状态
  handleCancel /      按 msg.to 路由到                                    │
  handleSteer           sub:<id> Soul                                   同步
  (§6.4)                                                           微秒级返回
          │
          ↓
    lifecycleStateMachine.isIdle() == false
          → return { error: "agent_busy" }
    lifecycleStateMachine.isIdle() == true
          → startTurn(trigger) → fire-and-forget runSoulTurn
          → 立即 return { turn_id, status: "started" }
```

**关键**：
- Router 分发到 `SoulPlus.dispatch()` 是同步的（路由本身不做 I/O）。
- 只有 `session.prompt` 路径的 `runSoulTurn(...)` 是 fire-and-forget，其它路径都是微秒级同步返回。
- `session.cancel` / `session.steer` 不会启动新 turn，只会操作 turn 的 AbortController 或 ContextState 的 steer buffer。
- 事务性 handler（setModel / getUsage / rename 等）直接从 SoulPlus `TransactionalHandlerRegistry` 取，完全不经过 TurnManager。

### 6.11 同进程多 Soul 实例

同一个 `SoulPlus` 可以同时持有多个 Soul handle（SoulKey = `"main" | sub:${string} | independent:${string}`）：

```
SoulPlus (session ses_xxx)
├── souls["main"]             # 主 agent，当前可能在跑 turn
├── souls["sub:abc"]          # subagent abc，task tool 创建
├── souls["sub:def"]          # subagent def，另一个并发 subagent
└── souls["independent:x"]    # agent team 成员（v2 预留）
```

每个 Soul handle 都有自己的 `SoulContextState`（除非复用 main 的 history，见 §8.2 的 `reuse_history` 设计）。它们都通过同一个 `EventSink`（SessionEventBus）emit 事件，事件带 `from/to/agent_type` 区分身份。

**并发模型**：Node.js event loop + async/await 天然支持。每个 Soul 是一个 Promise 链，在 `await` 点让出事件循环。Router 可以在任意让出点处理新的 Wire 消息。

**不需要真正的线程池**。本质是**多个并发 Promise 链**，JS 运行时自己调度。

### 6.12 Runtime 接口完整定义

§5.1.5 给过 Runtime 的预览，本节给完整定义。之所以把 Runtime 的完整定义放在 §5 而不是 §11，是因为 Runtime 不是"某个独立能力"，而是 Soul ↔ SoulPlus 的**能力边界本身**——它属于"Soul/SoulPlus 拆分"这章的内容。§11 是 Permission 系统的具体设计，§10 是 Tool 系统的具体设计，它们描述"某个能力长什么样"；而 Runtime 描述"Soul 能看见哪些能力、看不见哪些能力"。

#### 6.12.1 Runtime 的职责

- Runtime 是"SoulPlus 暴露给 Soul 的能力容器"
- 它不是 SoulPlus 本身，而是 SoulPlus 有选择地暴露给 Soul 的一组接口
- Soul 只通过 Runtime 访问外部世界，**看不到 SoulPlus 类也看不到 sub-component**——例如 Soul 看不到 TurnManager / NotificationManager / SoulRegistry 等内部概念
- Runtime 把"具体能力对象"（Phase 1 仅 `kosong`）装在同一个 bag 里，Soul 用的时候按字段名取
- Runtime 不是 host-side 万能注入口：`tools`、`agentSpawner`、`SubagentHost`、approval/permission、compaction/lifecycle/journal 等能力都**不属于** Runtime

换句话说，Runtime 就是 Soul 类型签名里的 `runtime: Runtime` 参数——把 Soul 能碰的外部世界完整描述出来，剩下的 SoulPlus 内部机制对 Soul 不可见。

> **决策 #93 后 Runtime 字段从 4 收窄到 1**：v2 初稿 Runtime 含 `{ kosong, compactionProvider, lifecycle, journal }` 四个字段，让 Soul 在 `runCompaction` 子函数里组合调用以执行 compaction。决策 #93（铁律 7）将 compaction 执行整体移到 TurnManager；`compactionProvider` / `lifecycle` / `journal` 三个字段已从 Runtime 移除，归 `TurnManagerDeps` 持有（见 §6.4）。本节保留 `CompactionProvider` / `LifecycleGate`（已升级为内部 `SoulLifecycleGate`，见 §6.1）/ `JournalCapability` 这些接口的类型定义，但消费者从 Soul 改为 TurnManager。

#### 6.12.2 接口定义

```typescript
// ─── Runtime（Phase 1 仅 1 字段） ───
interface Runtime {
  kosong: KosongAdapter;     // LLM 调用适配器——Soul 唯一需要的能力
}

// 注意：Runtime 只有 kosong 这一个字段。
// tools / agentSpawner / SubagentHost / permissionChecker / approvalRuntime
// / compactionProvider / lifecycle / journal 都不允许塞进 Runtime。
// 跨 turn 协调类需求一律走 TurnResult.reason 上报给 TurnManager（铁律 7）。

// ─── LLM 适配器 ───
// KosongAdapter 是 Soul 唯一持有的 Runtime 字段（决策 #93 后）。
//
// **Phase 1 必做：401 / connection retry 归 KosongAdapter**（决策 #94）
// 401（OAuth token 过期）和瞬时网络错误（ECONNRESET / ETIMEDOUT / 5xx 等可恢复错误）
// 的重试逻辑由 KosongAdapter 实现内部消化——Soul / TurnManager 都不感知。
// 参考 kimi-cli Python 版 `_run_with_connection_recovery`（kimisoul.py:1063–1134）
// 把 401 / connection retry 散在 Soul 内部的反例：v2 把这部分下沉到 KosongAdapter，
// 让 Soul 的 catch 路径只需关心"是不是 abort、是不是其它真实错误"两件事，不再有
// "是 401 / connection error 就跳过 throw 重试"的判断。具体实现策略见 §17A.5（MCP 错误处理 + 自动重连）与 §6.13（KosongAdapter）。
//
// **Phase 1 必做：Context overflow 检测归 KosongAdapter**（决策 #96）
// Kosong 在 chat() 内部识别两类 overflow 并统一抛 `ContextOverflowError`：
//   (a) 显式 overflow：provider 返回 PTL / 413 / "prompt is too long" 等错误
//       （pi-mono `OVERFLOW_PATTERNS` 含 17+ provider 模式：Anthropic / OpenAI /
//        Google / xAI / Groq / Cerebras / Mistral / OpenRouter / llama.cpp /
//        LM Studio / Kimi / MiniMax / Bedrock / Ollama / z.ai / GitHub Copilot /
//        Vertex；exclude `NON_OVERFLOW_PATTERNS` 里的 throttling）
//   (b) silent overflow：响应没报错但 `usage.input + usage.cache_read > contextWindow`
//       （z.ai / 部分 OpenAI 兼容 endpoint 会静默截断，必须主动检测）
// TurnManager 在 try/catch 中识别 `ContextOverflowError` 后调 `executeCompaction`，
// 与决策 #93 的 `needs_compaction` 路径合流（共享 MAX_COMPACTIONS_PER_TURN 熔断器）。
// 401 / PTL 优先级：401 优先 refresh（cheap），失败再 compact——KosongAdapter 内部协调。
// `max_output_tokens` 截断不抛 `ContextOverflowError`（属不同维度，Phase 2 不做 escalate / 续写——follow Python 版）。
interface KosongAdapter {
  chat(params: ChatParams): Promise<ChatResponse>;
}

// ─── Context overflow 错误（Phase 1 / 决策 #96） ───
// Kosong 抛出，TurnManager 统一捕获 → executeCompaction(reason: "overflow")。
// Soul 的 catch 不需要识别这类——它会按"其它真实错误"原样 throw 给 TurnManager，
// 由 TurnManager 在 startTurn 的 catch 内 isContextOverflowError(err) 检测。
class ContextOverflowError extends Error {
  readonly code = "context_overflow" as const;
  constructor(
    message: string,
    public readonly providerErrorMessage?: string,  // 原始 provider 错误文本（telemetry 用）
    public readonly tokenGap?: number,              // 如果 provider 报告了具体超限 token 数
    public readonly silent?: boolean,               // true = 静默 overflow（usage > window）；false = 显式错误
  ) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

// 对外简单 type guard（TurnManager 用，避免 instanceof 跨包识别问题）
function isContextOverflowError(err: unknown): err is ContextOverflowError {
  return err instanceof Error && (err as ContextOverflowError).code === "context_overflow";
}

interface ChatParams {
  messages: Message[];
  tools: LLMToolDefinition[];
  model: string;
  effort?: string;
  signal: AbortSignal;
  onDelta?: (delta: string) => void;

  // 决策 #97 / Streaming Tool Execution 预留（Phase 1 KosongAdapter 实现可不响应；Soul 不 set）。
  // 每当 LLM stream 中解析出一个完整的 tool_use block（即 partial_json 累积到完整 input），
  // KosongAdapter 同步回调一次。Phase 2 由 SoulPlus 注入的 StreamingKosongWrapper 负责
  // set 这个回调，把 toolCall 推给 ToolCallOrchestrator.executeStreaming（受控并发执行）。
  // 不支持 partial 通知——参数累积过程的 UI 渲染走 EventSink 的 tool.call.delta 事件，
  // 不通过本回调。Python 版 kosong `on_tool_call` 已生产验证此设计。
  onToolCallReady?: (toolCall: ToolCall) => void;
}

interface ChatResponse {
  message: AssistantMessage;
  toolCalls: ToolCall[];
  stopReason?: StopReason;
  usage: TokenUsage;

  // 决策 #97 / Streaming Tool Execution 预留（Phase 1 永远 undefined；Phase 2 启用）。
  // 内部约定字段（下划线前缀）——KosongAdapter 第三方实现不应主动 set；只有 SoulPlus 内部
  // 的 StreamingKosongWrapper 在 stream 期间通过 onToolCallReady 把 toolCall 推给
  // ToolCallOrchestrator 执行后，stream 收尾时把已完成的 tool_result 缓冲塞进这里。
  // Soul 的 for-loop 在拿到 toolCall 时优先查 prefetchedToolResults，命中即跳过 tool.execute
  // （详见 §5.1.7 伪代码的 3 行 prefetch 检查）。
  _prefetchedToolResults?: ReadonlyMap<string, ToolResult>;
}

// ─── 以下接口已从 Runtime 移除，归 TurnManagerDeps（见 §6.4）。
//     保留类型定义用于 SoulPlus 内部类型检查与文档可追溯性。 ───

// ─── 摘要能力（消费者：TurnManager.executeCompaction，详见 §6.4） ───
interface CompactionProvider {
  /**
   * 执行 context compaction，返回新的 summary[] 替换当前 history。
   *
   * **关键契约 — tail user_message 必须保留**（决策 #101 / 配合 #93 / #96 引入）：
   * 实现方**必须保证**——如果入参 `messages` 末尾包含一条**未配对的 user_message**
   * （即没有后续 assistant response 的待处理用户消息），它**必须**作为独立 message
   * 出现在返回的 `output.summary` 数组的末尾，**不得**被合并 / 改写 / 仅以摘要文本形式提及。
   *
   * 否则会出现 P0 bug：用户在大上下文末尾发短 prompt → 第 0 step 触发 compaction →
   * user_message 被混进摘要文本块 → LLM 看不到独立的"待回应用户消息" →
   * turn 0 步结束 → 用户 prompt 无响应。
   *
   * 参考实现：
   *   - CC 的 `buildPostCompactMessages` 显式串接 `messagesToKeep` 到 summary 末尾；
   *   - pi-mono 的 `keepRecentTokens=20K` 始终保 tail；
   *   - Python `SimpleCompaction.max_preserved_messages=2` hardcode 保留最后 2 条。
   * v2 把这个隐式合约显式化为接口契约；TurnManager.executeCompaction 末尾还有一道
   * 兜底断言（违反契约时 emit warning 并自动补回 tail user_message），见 §6.4。
   *
   * signal 是必选——compaction 本身可能耗时数秒到数十秒，必须支持 turn cancel。
   * 必选参数排在可选 options 之前，符合 TypeScript 参数顺序规则。
   */
  run(
    messages: Message[],
    signal: AbortSignal,
    options?: CompactionOptions,
  ): Promise<CompactionOutput>;
}

interface CompactionOptions {
  targetTokens?: number;       // 用户主动 compaction 可指定目标 token 数
  userInstructions?: string;   // 用户给 compaction 的自定义指令

  // ─── 决策 #96 新增：增量 summary + 触发原因 + 跨 compaction 状态 ───
  reason?: "threshold" | "overflow" | "manual";  // 触发原因（telemetry / debug；overflow 走 reactive 路径）
  previousSummary?: string;    // 上次 compaction 的 summary 文本，启用增量更新（pi-mono UPDATE_SUMMARIZATION_PROMPT）
  fileOperations?: {           // 跨 compaction 累积的 file ops（pi-mono CompactionDetails）
    readFiles: string[];
    modifiedFiles: string[];
  };
}

// CompactionOutput：compactionProvider.run 的返回值。
// 携带 estimatedTokenCount 让 TurnManager 立刻更新 ContextState 的 token 计数，
// 避免下一 step 显示 0%（参考 kimi-cli Python 版的实践）。
interface CompactionOutput {
  summary: Message[];                 // 替换 ContextState 的新 history（数组，不是单条）
  estimatedTokenCount: number;        // 用于 contextState.updateTokenCount，避免下一 step 显示 0%
  usage?: TokenUsage;                 // 审计字段
}

// ─── SoulLifecycleGate（消费者：SoulPlus 内部 + TurnManager.executeCompaction，见 §6.1 / §6.4） ───
// SoulPlus 内部 SessionLifecycleStateMachine 管 5 态（idle / active / completing /
// compacting / destroying），SoulLifecycleGate 是其暴露给 SoulPlus 内部组件的 3 态窄面
// （active / compacting / completing）。Phase 6H 决策 #92 重命名后，"SoulLifecycleGate"
// 强调它是"对 Soul 边界相关流程暴露的 gate"，但实际消费者仍然只在 SoulPlus 内部
// （TurnManager.executeCompaction）——决策 #93 后 Soul 类型上完全看不到 lifecycle 概念。
interface SoulLifecycleGate {
  transitionTo(
    state: "active" | "compacting" | "completing",
  ): Promise<void>;
}

// ─── 物理文件轮转（消费者：TurnManager.executeCompaction，见 §6.4） ───
interface JournalCapability {
  // compaction 专用：物理文件轮转
  // 实现方的职责：
  //   1. fsync 当前 wire.jsonl
  //   2. rename 为 wire.<N>.jsonl（原子 rename）
  //   3. 创建新 wire.jsonl
  //   4. 写入 boundary record 作为第一条
  //   5. fsync 新文件
  rotate(boundaryRecord: CompactionBoundaryRecord): Promise<void>;
}
```

**关键说明**：

- **`tools` 不在 Runtime 里**——由 `SoulConfig.tools` 按 turn 传入。决策原因：subagent 可能需要受限的 tool 子集，每个 turn 可以动态决定对 LLM 暴露哪些 tool；把 tools 挂在 Runtime 上会让"per-turn 过滤"变成一次性全局设定，失去灵活性。见决策 #83。
- **`SubagentHost` 不在 Runtime 里**——subagent 创建/回收是 AgentTool 的 host-side 依赖，按 D1 通过 tool constructor 注入，而不是挂到 Runtime 上给 Soul 直接调用。
- **`compactionProvider` / `lifecycle` / `journal` 不在 Runtime 里（决策 #93）**——它们是 SoulPlus 内部能力，由 TurnManager 在 `executeCompaction` 里组合调用。Soul 只通过 `TurnResult.reason: "needs_compaction"` 请求 compaction，自己不持有这三个能力的引用。
- **SoulLifecycleGate 并发语义**：`transitionTo("compacting")` 会等所有 in-flight ContextState 写入完成再切换，保证切换时刻的"清洁边界"——不会出现"一半记录在旧 wire.jsonl、一半记录在新 wire.jsonl"的中间态。这个等待语义是 compaction 正确性的关键，由 TurnManager 持有调用权。
- **JournalCapability 只做物理轮转**：非 compaction 路径的写入走 `ContextState` → `JournalWriter`，根本不碰 `journal.rotate`。`journal.rotate` 只在 TurnManager.executeCompaction 内调，且调用前必须已经 `await lifecycleStateMachine.transitionTo("compacting")`——两个接口组合使用，互为前提。
- Runtime 没有 `permissionChecker` / `approvalRuntime` 字段——这是铁律 2 的体现。权限相关的一切由 SoulPlus 在调 `runSoulTurn` 时通过 `beforeToolCall` 闭包注入，Soul 在类型层面对权限系统无感知。

#### 6.12.3 Runtime 的构造

Runtime 的实例由 SoulPlus 构造并持有，每次调 `runSoulTurn` 时作为参数传入。**SoulPlus 的 sub-component 共享同一个 Runtime 实例**——Phase 1 仅 `kosong` 一个字段，在整个 session 生命周期内共享。

> **精简示意**：下面只给 Runtime 字段的赋值片段，不是完整的 SoulPlus 构造。完整的 `SoulPlus.constructor` / `static create` 入口、6 个子组件的装配顺序、`TransactionalHandlerRegistry` 的初始化等细节，参见 §6.1 的主体伪代码，这里不再重复。

```typescript
// ─── SoulPlus 构造里 Runtime 字段赋值片段（决策 #93 收窄后） ───
// 注意：这里不再重写 class SoulPlus 外壳，canonical class 定义只在 §6.1 出现一次。
// 本片段只展示 runtime 这一个字段的装配方式。
this.runtime = {
  kosong: runtimeDeps.kosong,             // 唯一字段：LLM 调用适配器
};

// compactionProvider / lifecycle.gate / journal.capability 不再放进 Runtime——
// 它们仍然在 SoulPlus 内部，但通过 TurnManagerDeps 流向 TurnManager（见 §6.4）：
//   const turnManager = new TurnManager({
//     ...,
//     compactionProvider: new DefaultCompactionProvider(runtimeDeps.kosong),
//     lifecycleStateMachine: this.lifecycle.stateMachine,
//     journalCapability: this.journal.capability,
//     ...
//   });
//
// 其余 sub-component（NotificationManager / SkillManager / SoulRegistry / TeamDaemon /
// RequestRouter）的装配顺序见 §6.1 主体伪代码。
```

需要注意的是，Runtime 里每个字段的"实例"身份属于 SoulPlus——Runtime 本身只是一个引用聚合器，构造它几乎零成本。SoulPlus 可以按需在 runtime 字段上做装饰（例如给 kosong 加重试 / 限流），而不影响 Soul 的类型签名。与此同时，像 AgentTool 这种需要 host-side orchestration 的能力，应该在 ToolRegistry / tool constructor 组装期单独注入 `SubagentHost`，而不是偷渡进 Runtime。

#### 6.12.4 嵌入场景的 Runtime

嵌入方（不跑 Core daemon、直接 import Soul 的第三方应用）构造一个最简 Runtime 极其简单——决策 #93 后 Runtime 只剩 1 个字段。

```typescript
// ─── 嵌入方的最简 Runtime ───
const runtime: Runtime = {
  kosong: myKosongAdapter,
};
```

`compactionProvider` / `lifecycle` / `journal` 全部消失——嵌入方根本不需要知道这些概念存在。如果嵌入方想做 compaction，自己在 host 层写循环：监听 `runSoulTurn` 返回 `reason: "needs_compaction"` → 自行做 summarize 并 reset context → 再次调 `runSoulTurn` 接续。

结合 §4.5.5 的 `InMemoryContextState`，嵌入方可以用 **50-80 行核心代码 + 辅助类型** 跑起一个完整的 Soul——不需要 wire.jsonl、不需要 Core daemon、不需要权限系统、不需要 NotificationManager、不需要 lifecycle gate。Soul 的无状态函数属性在这里兑现为"**可测试 + 可替换 host**"（决策 #112）——host 不需要 `new Soul(...)`，只需要 1 个 `kosong` 实现 + 一次 `import { runSoulTurn }` + 实现 `SoulContextState`（11+ 方法）。详见 §5.1.9 的 Minimum Embeddable Host 参考。

#### 6.12.5 Cost Tracking（决策 #111）

v2 的 cost tracking 架构：

1. **CostCalculator 接口**：

```typescript
interface CostCalculator {
  calculate(model: string, usage: TokenUsage): CostBreakdown;
}

interface CostBreakdown {
  input_cost_usd: number;
  output_cost_usd: number;
  cache_read_cost_usd: number;
  cache_write_cost_usd: number;
  total_cost_usd: number;
}
```

2. **DefaultCostCalculator**：内置主流模型 pricing 表。
   - pricing 表格式：`{ model_pattern: string; input_per_1k: number; output_per_1k: number; cache_read_per_1k?: number }`
   - 正则匹配 model name（如 `"claude-*"` / `"gpt-4*"` / `"moonshot-*"`）
   - **未匹配模型 `cost_usd = null`（不猜，明确标 unknown）**——比 CC 的硬编码 pricing 更安全，避免默默算出错误费用

3. **调用位置**：`TurnManager` 的 turn 结束阶段调 `costCalculator.calculate(model, usage)`，结果写入 turn_end WireRecord 的 `usage.cost_usd`。CostCalculator 通过 SlimTurnManagerDeps 注入（可选 dep，Phase 1 默认 DefaultCostCalculator）。

4. **Session 级累计**：`ContextState` 维护 `cumulativeCost: number`（通过 `FullContextState` 接口暴露），每次 turn_end 时累加。通过 `session.getUsage` Wire method 返回（包含 `total_cost_usd: number | null`）。

5. **Phase 1 不做**：per-user 配额（QuotaPolicy）、billing integration、多币种支持。

> **类型定义**：`CostCalculator` / `CostBreakdown` 的完整 TypeScript 定义见附录 D.10。

### 6.13 Core 层路由与并发

#### 6.13.1 五通道分发（v1 基础上的微调）

```typescript
type ChannelType = "conversation" | "management" | "config" | "tools" | "process";

class Router {
  private handlers = new Map<string, { channel: ChannelType; handler: Handler }>();

  async dispatch(msg: WireMessage, conn: Connection): Promise<WireMessage | void> {
    // 1. response 类：路由给 pending request 的 resolver
    if (msg.type === "response") {
      this.resolvePendingRequest(msg);
      return;
    }

    // 2. 进程级方法
    if (msg.session_id === "__process__") {
      return this.processHandlers.get(msg.method!)?.(msg, conn);
    }

    // 3. session 级方法
    const session = this.sessionManager.get(msg.session_id);
    if (!session) throw new WireError("SessionNotFound");

    const handler = this.handlers.get(msg.method!);
    if (!handler) throw new WireError("MethodNotFound");

    // 所有 handler 都是同步调用（对 conversation channel 的 prompt，handler 内部 fire-and-forget）
    return handler.handler(session, msg, conn);
  }
}
```

#### 6.13.2 为什么 management 请求永远不被 prompt 阻塞

核心机制：**`runSoulTurn` 是在 TurnManager.startTurn 里 fire-and-forget 启动的**（canonical 伪代码见 §6.4）。

`SoulPlus.dispatch()` 本身永远不会 `await` 任何 Soul 运行——它只做一次 `RequestRouter.dispatch` 的同步转发。进入 TurnManager 之后：

- **`session.prompt` 路径**：`TurnManager.handlePrompt` 同步检查 lifecycle，调 `startTurn(trigger)` 启动一个 turn。`startTurn` 内部通过 `TurnLifecycleTracker.createTurn()` 分配 turnId + AbortController，通过 `PermissionClosureBuilder.build()` 构造 SoulConfig，然后 **不 await 地** 执行 `runSoulTurn(...)` 并把返回的 Promise 通过 `lifecycle.registerPromise(turnId, promise)` 注册。handlePrompt 立即 `return { turn_id, status: "started" }`。
- **`session.cancel` 路径**：`TurnManager.handleCancel` 先调 `cancelBySource` / `discardStreaming`（§7.2 abort 标准顺序前两步），再委托 `TurnLifecycleTracker.cancelTurn(turnId)` 完成 controller.abort + await promise。整个路径不会新起 Soul。
- **`session.steer` 路径**：`TurnManager.handleSteer` 直接 `await this.deps.contextState.addUserMessages([input])`，把 steer 输入塞进 ContextState 的 steer buffer；Soul 在下一个 step 开头的 drain 阶段通过 `drainSteerMessages()` 消费，不会 fork 新 Soul。
- **事务性路径**（setModel / getUsage / rename / getHistory / getStatus）：在 `SoulPlus` 的 `TransactionalHandlerRegistry` 里注册，`RequestRouter.dispatch` 查表拿到 handler 直接同步调用，完全绕开 TurnManager 和 Soul。

在 `runSoulTurn` 跑的时候：

1. Node event loop 自由处理其它 Wire 消息。每条 `session.*` 请求都是一个微秒级的查表 + 同步调用。
2. `getUsage` / `getStatus` / `getHistory` 直接读 `SoulPlus.contextState` 和内部字段，完全不碰正在跑的 Soul。
3. `setModel` / `setSystemPrompt` / `setPlanMode` 等 config 变更走 `ContextState.applyConfigChange(event)` + `sessionJournal.appendConfigPatch(...)` + `emitEvent` 三步，同步完成。新模型**下一次 step 开头**生效——因为 Soul 在 step 循环内部每次都重新从 `context.model` 读取。
4. `cancel` 触发的 `AbortSignal` 会让 Soul 在下一个 `await` 点抛出 `signal.aborted` 异常；Soul 的 catch 块把它映射到 `stopReason = "aborted"`，TurnManager 的 finally 块负责写 `turn_end` wire。

**设计铁律**：整个 §6.13 不再有"runSoulInBackground" 这个独立函数——它只是 `TurnManager.startTurn` 内部 fire-and-forget 的那个 IIFE。任何"management 请求被 prompt 阻塞"的场景都说明实现跑偏了 `TurnManager` 的约定，不是设计问题。

**和 §6.4 的关系**：本节只讲"为什么 management 请求不会阻塞"这一个现象；`handlePrompt` / `startTurn` / `onTurnEnd` 的完整代码路径是 §6.4 的 TurnManager class，**不要**在 §6.13.2 重复展开伪代码。

#### 6.13.3 `setModel` 的生效时机

讨论里明确了这个问题。`setModel` 的效果：
1. **立即生效**：append 到 wire、更新 ContextState、emit 事件——瞬时
2. **但对正在跑的 turn**：因为 Soul 每个 step 都从 ContextState 读 model（或 runtime），**下一个 step 生效**
3. 如果用户想让"当前 step 立刻切模型"，需要先 `cancel` 再 `prompt`（显式打断）

这是一个**优雅的降级**——不需要在 Soul 内部插入 "if model changed, ..." 的检查代码。

#### 6.13.4 多 session 并发

每个 `SoulPlus` 是独立的；多个 `SoulPlus` 之间通过 `SessionManager` 索引。

```typescript
class SessionManager {
  private sessions = new Map<string, SoulPlus>();

  create(params: CreateParams): SoulPlus { ... }
  get(id: string): SoulPlus | undefined { ... }
  destroy(id: string): Promise<void> { ... }
  list(): SessionInfo[] { ... }
}
```

多个 session 同时跑 prompt 时，它们都在 Node 事件循环上交替执行。Node 单线程让这件事非常简单——不需要锁，因为同步代码块永远原子。

#### 6.13.5 并发限制（可选）

真的需要限流（比如 LLM API QPS）时，在 Kosong 层加 rate limiter，**而不是在 Soul 或 SoulPlus 层**。这保持 Soul 的纯净。

#### 6.13.6 事件缓冲与断线重放

SoulPlus 内部的 EventBus 维护一个**有界滚动日志**（`eventLog: BusEvent[]`，默认 `maxSize = 10000`），用于支持断线重连场景下的事件重放。

每个 `BusEvent` 携带单调递增的 `seq` 序列号（对应 §3.1 消息信封中的 `seq` 字段）。当 client 断线后重连，可以通过 `session.getTurnEvents({ after_seq })` 获取断线期间遗漏的事件：

```typescript
// EventBus 内部实现
class SessionEventBus {
  private eventLog: BusEvent[] = [];
  private seqCounter = 0;
  private readonly maxLogSize: number;

  constructor(maxLogSize = 10_000) {
    this.maxLogSize = maxLogSize;
  }

  emit(event: SoulEvent): void {
    const busEvent: BusEvent = { ...event, seq: ++this.seqCounter };
    this.eventLog.push(busEvent);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog.shift();  // 滚动淘汰最旧的
    }
    // fan-out 给所有订阅者
    for (const handler of this.subscribers.values()) {
      try { handler(busEvent); } catch { /* 容错：listener 失败不影响 Soul */ }
    }
  }

  getEventsAfter(seq: number): BusEvent[] {
    return this.eventLog.filter(e => e.seq > seq);
  }
}
```

**重连流程**：
1. Client 记住最后收到的事件 `seq`
2. 断线后重连，发 `session.getTurnEvents({ after_seq: lastSeq })`
3. Server 从 `eventLog` 过滤返回断线期间遗漏的事件
4. Client 按序重放，恢复 UI 状态

**注意**：如果断线时间过长（超出 `eventLog` 滚动窗口容量），client 无法增量重放。此时需要走完整的 `session.resume` 路径，从 `wire.jsonl` 重建完整状态。`eventLog` 只是短期断线的优化路径，不替代 `wire.jsonl` 的持久化能力。

**seq 语义规范（决策 #106）**：

`seq` 是 per-SessionEventBus 实例的全局单调递增序列号。以下规则必须遵守：

1. **全局唯一**：同一个 SessionEventBus 实例上所有 `emit` 共享一个 `seqCounter`。`seq` 不是 per-source 的——来自 main agent、subagent A、subagent B 的事件共享同一个递增序列。
2. **subagent 转发重新分配 seq**：subagent 通过 EventSink wrapper（§6.5）转发事件到父 EventBus 时，父 EventBus **重新分配 seq**（不沿用子 EventBus 的 seq）。子 EventBus 的 seq 只在子 `wire.jsonl` replay 时有意义，不跨 EventBus 传播。
3. **`after_seq` 语义**：client 用 `after_seq=N` 拉取断线重连事件时，seq 语义是"父 EventBus 上的全局序列号"。返回的事件包含 N 之后**所有 source** 的事件——不做 server 端 source 过滤。如果 client 只关心某个 source，自行 filter。
4. **因果一致但非实时一致**：同一个 Soul 内的事件 seq 递增（因果一致）。跨 Soul（main + 多个 subagent）的事件到达 EventBus 的顺序取决于事件循环调度——`seq` 只反映"到达 EventBus 的顺序"，不保证"事件在子 Soul 内实际发生的时间顺序"。
5. **Node.js 单线程保证**：`++this.seqCounter` 在 Node.js 单线程下是原子的（V8 不会在 read-modify-write 中间切片），无 race condition。

**多 Soul 并发场景说明**：同一个 SoulPlus 可能同时跑多个 Soul（main + N 个 subagent）。每个 Soul 的 EventSink 是 wrapper，最终汇入同一个 SessionEventBus。事件交错的 seq 序列是正确的——client 按 seq 顺序 replay 即可还原 UI 状态，source 字段（§D.6.1 EventSource）用于 UI 分组渲染。

#### 6.13.7 SessionMetaService（决策 #113）

SessionMetaService 是 services facade 的组件（§6.1 阶段 5 装配），作为 sessionMeta 字段的**统一内存视图 + 写入收口**。它解决 5 个具体缺口：(1) `session.rename` 缺乏对应的 wire record 导致重启即丢；(2) 缺少 `session_meta.changed` 事件让 UI 无法实时感知改名；(3) SoulPlus 内部组件（shell hook / telemetry / NotificationManager）无 SessionMeta 读取 API；(4) state.json 派生字段（`last_model` / `turn_count` / `last_updated`）无明确 owner 与多写者并发；(5) state.json 与 wire.jsonl 不一致时的恢复策略未定义。详见 §4.4 / ADR-X.113。

**接口骨架**：

```typescript
interface SessionMetaService {
  // ─── 读 API（供 SoulPlus 内部组件，例如 shell hook / telemetry） ───
  get(): SessionMeta;                                                  // 返回当前快照（深拷贝，外部不可改）
  subscribe(handler: (patch: Partial<SessionMeta>, source: MetaSource) => void): () => void;

  // ─── 写 API（供 RequestRouter 事务路径调用） ───
  setTitle(title: string, source: MetaSource): Promise<void>;
  setTags(tags: string[], source: MetaSource): Promise<void>;
  // 未来：setDescription / setArchived / setColor / ...

  // ─── 派生字段不暴露写 API，由内部订阅 EventBus 自动维护 ───

  // ─── 启动恢复（§9.7 的 SessionMeta 重建子阶段调用） ───
  recoverFromWire(records: WireRecord[]): Promise<void>;
}

// SessionMeta 内存结构（聚合视图，与 state.json 字段一一对应）
interface SessionMeta {
  // wire-truth（落 wire `session_meta_changed`）
  session_id: string;
  created_at: number;
  title?: string;
  tags?: string[];
  description?: string;       // Phase 2+
  archived?: boolean;         // Phase 2+
  color?: string;             // Phase 2+

  // derived（订阅事件聚合，不落 wire）
  last_model?: string;
  turn_count: number;
  last_updated: number;

  // runtime-only（仅 state.json，由 SessionLifecycle 写入；SessionMetaService 启动时读取一次缓存以避免 flush 时覆盖）
  last_exit_code?: "clean" | "dirty";
}

type MetaSource = "user" | "auto" | "system";
```

**写流程三步（与 ContextState.applyConfigChange 模式对齐）**：

```typescript
async setTitle(title: string, source: MetaSource): Promise<void> {
  if (this.meta.title === title) return;  // no-op idempotent

  // 1. 写 wire（真相源）—— sessionJournal 是 SessionJournal 窄门，不进 LLM messages
  await this.deps.sessionJournal.append({
    type: "session_meta_changed",
    patch: { title },
    source,
  });

  // 2. 更新内存视图
  this.meta.title = title;
  this.meta.last_updated = Date.now();

  // 3. emit 事件（同步推送给 UI 和内部本地订阅者）
  this.deps.eventBus.emit("session_meta.changed", { patch: { title }, source });
  for (const handler of this.subscribers) {
    try { handler({ title }, source); } catch { /* 容错：listener 失败不影响写流程 */ }
  }

  // 4. 调度 state.json 异步 flush（debounced 200ms 合并多次写入）
  this.scheduleStateFlush();
}
```

**派生字段订阅（构造时一次性绑定 EventBus）**：

```typescript
constructor(deps: SessionMetaServiceDeps) {
  // turn.end → turn_count++ + last_updated 刷新
  deps.eventBus.on("turn.end", () => {
    this.meta.turn_count++;
    this.meta.last_updated = Date.now();
    this.scheduleStateFlush();
  });

  // model.changed → last_model 刷新
  deps.eventBus.on("model.changed", (e) => {
    this.meta.last_model = e.new_model;
    this.meta.last_updated = Date.now();
    this.scheduleStateFlush();
  });

  // 注意：派生字段更新**不**触发 session_meta.changed 事件——
  // model.changed / turn.end 自身已经是 wire 事件，UI 已经收到；
  // 重复 emit session_meta.changed 是噪音。决策 #113 / D6 明确此边界。
}
```

**state.json debounced flush（200ms 合并）**：

```typescript
private scheduleStateFlush() {
  if (this.flushTimer) return;
  this.flushTimer = setTimeout(async () => {
    this.flushTimer = null;
    await atomicWrite(this.deps.paths.statePath(this.meta.session_id),
                      JSON.stringify({
                        ...this.meta,
                        // SessionLifecycle 在 shutdown 时直接覆写 last_exit_code
                        // （runtime-only 字段，不经 SessionMetaService），这里透传缓存
                        // 值避免 flush 把它覆盖回 undefined。
                        last_exit_code: this.lastExitCodeCache,
                      }, null, 2));
  }, 200);
}
```

**关键不变量**：
- 只有 SessionMetaService 写 state.json（除 `last_exit_code` 由 SessionLifecycle 直接覆写以外），无并发写者
- 200ms debounce 合并 turn.end / model.changed 等高频事件触发的 flush
- wire-truth 字段写流程是**同步**的：wire append → 内存更新 → emit 事件，三步原子完成；只有 state.json flush 是异步 debounced

**subagent 冒泡（决策 #113 / D9-1）**：

子 SoulPlus 也实例化自己的 SessionMetaService，把 `session_meta_changed` 落到 `subagents/<sub_id>/wire.jsonl`（独立存储，与 §17.2 子 wire 设计一致）。冒泡到主 EventBus 由 SoulRegistry wrapper 注入 `source: { id, kind: "subagent", name }`（与 §6.5 / §3.6.1 既有 subagent 事件冒泡机制一致），UI 收到带 `source.kind === "subagent"` 的 `session_meta.changed` 时按 §3.6 既有渲染策略处理。子 wire 落盘 + 父 wire **不**落盘（避免事件污染主 wire 的对话语义）。

**同步事务路径（决策 #113 / D9-2，与 setModel 同路径）**：

`session.rename` / `session.setTags` / `session.getMeta` 在 `TransactionalHandlerRegistry`（§6.13.2 第 4 条事务性路径）注册，由 RequestRouter 同步调用：

```typescript
handlers.register("session.rename", async (req) => {
  await this.services.sessionMeta.setTitle(req.title, "user");
  return {};
});
handlers.register("session.setTags", async (req) => {
  await this.services.sessionMeta.setTags(req.tags, "user");
  return {};
});
handlers.register("session.getMeta", async () => {
  return { meta: this.services.sessionMeta.get() };
});
```

turn 跑到一半时调用 `session.rename`：同步落 wire（JournalWriter 的 seq 单调，与 turn 内 record 串行）→ 同步更新内存 → 同步 emit 事件，**不**等 turn 结束、**不**排队、**不**影响 Soul 步骤。因为 title 不影响 LLM 行为，无需协调 ContextState / Soul step loop。

**与 §6.13.3 setModel 时机的对照**：
- `setModel`：立即写 wire + 更新 ContextState + emit 事件，但对正在跑的 turn **下一个 step 才生效**（Soul 每个 step 重新读 model）
- `session.rename`：立即写 wire + 更新内存 + emit 事件，**对正在跑的 turn 完全没有"生效时机"问题**（title 不进 ContextState、不影响 LLM）

两者共用 `TransactionalHandlerRegistry` 同步事务路径，差异仅在"是否有 turn 内生效语义"。

**铁律一致性**：SessionMetaService 是 services facade 内部组件，Soul 类型上完全看不到（守铁律 6——Runtime 是 Soul 唯一窄门）。未来若 shell hook 等需要在 Soul 侧读 title，再通过 Runtime 加 readonly view 暴露，目前不开口。

#### 6.13.8 Backpressure 与 listener 契约（决策 #110）

EventSink.emit 是 fire-and-forget（铁律 4），但 subscriber 端需要契约：

1. **listener 不应阻塞**：listener 内部不应 await 长操作（fsync / 网络），必须在 < 1ms 内返回。违反此契约的 listener 会导致 eventLog push 延迟，影响后续 emit 的 seq 分配。

2. **eventLog 分类缓冲**（区分过程事件和状态事件）：
   - **状态事件**（`turn.end` / `tool.call` / `tool.result` / `subagent.spawned` / `compaction.begin` / `compaction.end` 等）：独立 ring buffer（默认 2000 条），**不丢**——这些事件是断线重连后 UI 状态重建的关键。
   - **过程事件**（`content.delta` / `tool.progress` / `step.begin` / `step.end` 等）：共享 ring buffer（默认 8000 条），溢出时淘汰最旧。
   - 这保证断线重连时状态事件完整，过程事件尽力而为。`getEventsAfter(seq)` 从两个 buffer 合并返回，按 seq 排序。

3. **lag 检测**：subscriber 可选注册 `onLag(missedCount: number)` 回调。当 subscriber 消费速度跟不上（eventLog 已轮转掉它未消费的事件），触发 onLag。subscriber 可据此切换到 full replay 模式（走 `session.resume` 从 `wire.jsonl` 重建）。

4. **subscriber 上限**：单个 SessionEventBus 最多 **10 个** subscriber。超出时 `subscribe` 返回 error（不静默丢弃）。理由：每个 subscriber 都会在 emit 路径上执行（同步 fan-out），过多 subscriber 会把 emit 延迟从 <1ms 拉到不可接受的水平。10 个足以覆盖主 UI + transport + 遥测 + debug logger + 预留。

> **交叉引用**：§4.8 EventSink 铁律仍然成立——emit 返回 void、listener 失败不影响 Soul。本节的 backpressure 契约是对铁律的**补充**（不是修改）：铁律管 emit 端的行为保证，backpressure 契约管 subscribe 端的行为约束。

---

## 七、Abort Propagation Contract

本节定义 v2 的统一 abort 契约。目标不是"尽量 cancel"，而是保证三件事同时成立：第一，等待中的 approval / HTTP / subprocess / subagent 都能收到同一轮 turn 的取消信号；第二，wire 与内存不会留下新的半状态；第三，abort 后 session lifecycle 能回到可恢复的稳定态。

### 7.1 核心模型：每 turn 一个 root scope

- 每个前台 turn 由 TurnManager 创建一个 `rootController = new AbortController()`，它是该 turn 唯一的 root scope。
- `rootController.signal` 必须传给本轮所有可能阻塞的下游：Soul、`runtime.kosong.chat`、`beforeToolCall`、`tool.execute`、`afterToolCall`、`TurnManager.executeCompaction → compactionProvider.run`（决策 #93 后 compactionProvider 不再走 Runtime，由 TurnManager 直接调用）。
- Soul **绝不**自己 `new AbortController()`；它只消费外部传入的 `signal`。
- foreground subagent 从父 turn 派生 child controller：父 signal abort 时，child 必须级联 abort。
- background subagent 使用独立 controller，不链接父 turn signal；否则父 turn cancel 会误杀后台任务。

### 7.2 TurnManager.abortTurn() 的标准顺序

顺序固定，不能交换：

```typescript
// 决策 #109 拆分后：abort 标准顺序由 TurnManager 编排，controller.abort + await 委托 TurnLifecycleTracker
async abortTurn(turnId: string, reason: string) {
  const source: ApprovalSource = { kind: "turn", turn_id: turnId };

  // 1. 先取消 approval / waiter，让 beforeToolCall 立即 unblock
  //    cancelBySource 是同步的 void 方法（见 §12.2），不 await
  //    （cancelBySource 是同步 void —— 只承诺 in-memory waiter 已 reject + emit cancel event；
  //     wire 写入和跨进程撤销都异步追赶。详见 §12.2 注释 / 决策 #102。）
  this.deps.approvalRuntime.cancelBySource(source);

  // 2. 丢弃 streaming tool execution 的所有 in-flight 结果（决策 #97 / Phase 2 启用后才有效）。
  this.deps.orchestrator.discardStreaming?.("aborted");

  // 3. 委托 TurnLifecycleTracker 触发 controller.abort + await promise
  //    （决策 #109：原来直接操作 this.turnAborts Map，现在走 lifecycle.cancelTurn）
  await this.deps.lifecycle.cancelTurn(turnId);
}
```

- 先 `cancelBySource`，是为了确保卡在 approval 的 `beforeToolCall` 不会等不到 signal race。
- `discardStreaming("aborted")` 在 controller.abort 之前——streaming wrapper 内部依赖的 sub-controller 一旦先被 abort，缓冲里的"已完成 result"会被错误标记为 cancelled。
- 后 `lifecycle.cancelTurn(turnId)` 内部调 `controller.abort(reason)` + `await turnPromises.get(turnId)`——语义不变，只改调用路径（决策 #109）。
- `turn_end` 只能在 `runSoulTurn` 退出、所有前台 child cleanup 完成后写入；不能在 `abortTurn()` 里抢先补写。

### 7.3 每层责任表

| 层 | controller 归属 | 必须消费的 signal | abort 时必须完成的事 |
|---|---|---|---|
| TurnManager | 编排 abort 顺序；root controller 由 TurnLifecycleTracker 持有（决策 #109） | - | 先 `cancelBySource`，再 `discardStreaming`，最后委托 `lifecycle.cancelTurn`（内部 controller.abort + await promise） |
| Soul | 不创建 controller | `signal.throwIfAborted()` 覆盖每个可能阻塞的 await 点 | 若 tool 调用链中 abort，先补一条 `tool execution cancelled` 的 `tool_result`，再以 `"aborted"` 退出 |
| `runtime.kosong.chat` | 不创建 controller | 同一 root signal 传到底层 HTTP client | 立刻取消请求 / 读取流，不得继续产出 delta |
| `beforeToolCall` | 不创建 controller | 同一 root signal；内部和 approval waiter race | abort 后立即返回/抛错，不得把 turn 卡死在审批等待上 |
| `tool.execute` | 不创建 controller | 同一 root signal 贯穿到底层实现 | subprocess/IO/stream 必须开始清理；不再继续 yield progress |
| `afterToolCall` | 不创建 controller | 同一 root signal | 立即停止 hook 链，不得额外阻塞 turn 收尾 |
| `CompactionOrchestrator.executeCompaction → compactionProvider.run`（决策 #93 / #109） | 不创建 controller；signal 来自 TurnLifecycleTracker 的 turn handle | 同一 root signal | 被 abort 时立刻退出摘要生成；`executeCompaction` 的 `finally` 必须把 lifecycle 切回 active，不得把 session 留在 compacting |
| AgentTool（foreground） | 创建 child controller | child signal 级联父 signal | abort 后等待子 agent cleanup 完成，再让父 turn 继续收尾 |
| BackgroundTaskManager | 为每个后台任务创建独立 controller | 不监听父 turn signal | session shutdown 时按 `keep_alive_on_exit` 决定 cancel 还是保活 |

### 7.4 Soul 侧的最小不变量

- Soul 只接受外部传入的 `AbortSignal`，不拥有取消策略。
- 每个可能阻塞的 await 点之后都立即 `signal.throwIfAborted()`；这是把 "abort 尽快生效" 变成代码结构约束的最小办法。
- `content.delta` / `tool.progress` 这类 EventSink 事件在 abort 后立刻停止；它们不需要补写 durable 记录。
- `assistant_message` 只写最终合并结果；abort 时不会为了补偿去持久化 partial。
- compaction 检测只发生在 Soul 的 while 顶部 safe point；abort 不会打断一个"半步未落盘"的普通 step，再触发 compact。compaction 执行由 TurnManager.executeCompaction 完成（决策 #93），abort 时 `executeCompaction.finally` 会把 lifecycle 切回 active。

### 7.5 approval / tool 调用链的 abort 语义

- 如果 abort 发生在 `beforeToolCall` 的审批等待阶段，Soul 必须写入：
  - `tool_result = { isError: true, content: "tool execution cancelled" }`
- 如果 abort 发生在 `tool.execute` 中，语义同上：LLM 看到的仍然是明确的 cancelled tool_result，而不是泛化的 unknown error。
- 如果 abort 发生在 `afterToolCall` 中，且该 tool 还没有 durable `tool_result`，仍按 cancelled 语义收口。
- 这样做的目的不是“假装没有执行过副作用”，而是给 transcript 一个稳定、可恢复、不会 dangling 的收尾。

### 7.6 底层不支持真取消时的统一策略

- 某些 tool 底层无法真正中断（例如第三方 SDK 不支持 cancel）。
- 这时 adapter 层的契约是：
  1. 立刻停止向 Soul yield 新的进度或增量；
  2. 尽可能触发底层清理；
  3. 立即向上抛 `AbortError`；
  4. 由 Soul 按 cancelled tool_result 语义收口。
- 换句话说，“无法真取消”不能泄漏成“上层继续等到它自然跑完”。

### 7.7 Subprocess 统一 kill 契约

- 所有 subprocess tool（Bash / shell / 本地 worker）统一遵守两阶段 kill：
  1. 先发 `SIGTERM`
  2. 等待 **5 秒** grace period
  3. 仍未退出则发 `SIGKILL`
- Windows 实现等价语义：杀整个 process group，而不是只杀父 pid。
- kill 契约属于 tool adapter / shell executor 的责任，不属于 Soul。
- Soul 只要求：当 `tool.execute(..., signal, onUpdate)` 返回 AbortError 时，该 tool 已经进入清理流程，且不会继续向上游产出进度。

### 7.8 Foreground subagent 的父子级联

- foreground subagent 的 controller 是父 turn root scope 的 child scope。
- 父 turn abort 时，AgentTool 必须先把 abort 级联给 child，再等待 child 完成 cleanup。
- cleanup 的最低要求包括：
  - child 自己的 `beforeToolCall`/`tool.execute`/HTTP 流停止
  - child 持有的 subprocess 已进入 kill 流程
  - child 不再向父 turn 回送新的事件或结果
- 父 turn **必须等** 上述 cleanup 完成后，才能写自己的 `turn_end`；否则会出现父 turn 已结束、子 agent 仍在后台吐事件的错序。

### 7.9 Background subagent 与 session shutdown

- background subagent 不挂在某个前台 turn 的 root scope 下；它有独立 controller、独立恢复语义。
- session shutdown 时统一检查 `keep_alive_on_exit`：
  - `false`（默认）：主动 cancel 该 background task，并等待基础 cleanup 完成
  - `true`：不主动 cancel，让其继续执行；下次启动时按 background task 自己的恢复路径接管
- 这个开关只影响 session shutdown，不影响普通的 `session.cancel(turn_id)`。

### 7.10 Compaction 与 abort 的交互

- 决策 #93 后 compaction 执行整体在 `TurnManager.executeCompaction` 内完成（不再有 Soul 内部的 `runCompaction` 子函数）。
- compaction 期间如果 `compactionProvider.run`、`journalCapability.rotate` 或 `contextState.resetToSummary` 任一步抛出 abort/error，`executeCompaction` 的 `finally` 都必须执行 `lifecycleStateMachine.transitionTo("active")`。
- 原因很简单：`compacting` 是物理 gate，不是终态；一旦卡死在 compacting，后续所有写入都会被错误阻塞。
- 也因此，abort 不会让 lifecycle 留在 `"compacting"`；abort 只影响当前 turn 是否继续，不影响 session 之后能否恢复工作。
- `executeCompaction` 接收的 signal 是 turn 级 root signal（来自 `turnAborts.get(turnId).signal`）——cancel turn 应该 cancel 进行中的 compaction；TurnManager 的 startTurn 在 compaction 抛 AbortError 时让 throw 冒泡到外层 catch，写 `turn_end(reason: "cancelled")`。


> v2 的 abort 契约不是“谁想 cancel 就 cancel”，而是“TurnManager 统一建 scope、统一发信号、统一等收尾；Soul 统一把未闭合的 tool 调用收口成 cancelled；所有下游层都必须把同一个 signal 传播到底”。

---

## 八、多 Agent 架构

### 8.1 双模型概述

v2 的多 agent 支持分为两种完全不同的模型：

| | Task Subagent | Agent Team Member |
|--|--|--|
| **进程模型** | 同进程 Soul 实例（SoulPlus 内部管理） | 独立 Node.js 进程（各自运行 SoulPlus） |
| **通信方式** | EventBus（内存，毫秒级） | SQLite 消息总线（team_mails 表，100ms 轮询） |
| **生命周期** | 短（执行完一个 task 即终止） | 长（可持续对话，leader 显式关闭） |
| **与 parent 关系** | tool.result 返回结果 | TeamMail 双向对话 |
| **阻塞性** | foreground 阻塞 / background 非阻塞 | 始终非阻塞 |
| **agent_type** | `"sub"` | `"independent"` |
| **参考来源** | kimi-cli 的 asyncio coroutine 模式 | cc-remake 的 subprocess teammate 模式 |

### 8.2 Task Subagent（同进程 Soul）

**定义**：主 agent 通过 `task` 工具起的 agent。完成后把结果返回给主 agent。

**关键属性**：
- **同进程 Soul 实例**：SoulPlus 内部 `souls["sub:<id>"]`
- **独立 ContextState**：默认从空 context 开始，只带 system prompt 和 task 描述
- **或复用 history**：`reuse_history: true` 时克隆 main 的 ContextState
- **有自己的 wire 文件夹**：`sessions/<main>/subagents/<sub_id>/wire.jsonl`（**扁平存储**：所有子 agent（包括递归子 agent）都在 `subagents/` 下各占一层目录，父子关系通过 `subagent_spawned.parent_agent_id` 字段重建，不做目录嵌套）
- **独立存储 + source 标记转发**：子 agent 有自己完整、同构的 wire.jsonl；SoulRegistry 给子 Soul 的 EventSink 是 wrapper——(1) 写子 wire 持久化；(2) 加 `source: { id, kind: "subagent", name }` 转发到 session 共享 EventBus 供 UI 实时展示。父 wire 只记 `subagent_spawned` / `subagent_completed` / `subagent_failed` 三条生命周期引用，**不嵌套包装子事件**（旧 `subagent.event` 方案已废弃，详见决策 #88 / §3.6.1 / §4.8）
- **崩溃不影响 main**：subagent 炸了，main 收到 error 并由父 wire 写入 `subagent_failed`，然后决定继续或放弃
- **Approval 冒泡**：subagent 的 approval.request 通过 EventBus → Wire Server → client（不经过 SQLite）

**两种运行模式**（通过 `AgentTool` 间接使用 `SubagentHost`，不走 Runtime）：

```typescript
interface SubagentHost {
  spawn(request: SpawnRequest): Promise<SubagentHandle>;
}

class AgentTool implements Tool<AgentToolInput, ToolResult> {
  constructor(
    private readonly subagentHost: SubagentHost,
    private readonly parentAgentId: string,   // 构造期注入：派生当前 Soul 的 agentId
  ) {}

  async execute(id, args, signal) {
    // SpawnRequest 字段参见 §6.5（parentAgentId / agentName / prompt + 可选字段）
    // signal 不是 SpawnRequest 字段——它由 host 内部的 abort 级联机制处理（见 §7）
    const handle = await this.subagentHost.spawn({
      parentAgentId: this.parentAgentId,
      agentName: args.agentName ?? "general-purpose",
      prompt: args.prompt,
      runInBackground: args.runInBackground ?? false,
      description: args.description,
    });

    if (args.runInBackground) {
      return { content: `subagent ${handle.agentId} started` };
    }

    // SubagentHandle 对外只暴露 `{agentId, completion: Promise<...>}`，foreground 通过 await 拿结果
    return await handle.completion;
  }
}

const agentTool = new AgentTool(soulRegistry, parentAgentId); // SoulRegistry 实现 SubagentHost
```

- `SubagentHost` 是 `AgentTool` 的 constructor 注入依赖，属于 host-side orchestration 能力，**不进入 Runtime**。
- `SoulRegistry` 是默认实现：它持有同一个 session 内的 `souls["sub:<id>"]` 注册表，负责创建、注册、回收同进程 subagent Soul。
- 背景模式下 `spawn()` 立即返回 handle；完成结果通过 notification 路径回到 main agent，而不是让 Soul 直接持有 host 对象。

**Subagent 的 abort 级联**（见 **§7 Abort Propagation Contract**）：

- **Foreground subagent**：`AgentTool` 从父 turn 的 root scope 派生 child controller；父 turn abort 时先级联 abort 给 child，再等待 child 清理完成，最后父 turn 才能写 `turn_end`。
- **Foreground cleanup 最低要求**：child 的 `beforeToolCall` / `tool.execute` / HTTP 流停止；child 持有的 subprocess 进入 kill 流程；child 不再向父 turn 回送新的 event / result。
- **Background subagent**：使用独立 controller，不链接父 turn signal；因此普通 `session.cancel(turn_id)` 不会误杀后台任务。
- **Session shutdown**：统一检查 background subagent 的 `keep_alive_on_exit`；`false`（默认）则 cancel 并等待基础 cleanup，`true` 则允许继续运行并走自己的恢复路径。

**Subagent 的 state.json**：

```json
{
  "agent_id": "sub_abc",
  "parent_session_id": "ses_xxx",
  "parent_tool_call_id": "tc_yyy",
  "status": "created | running | awaiting_approval | completed | failed | killed | lost",
  "description": "研究 auth 模块的 bug",
  "created_at": 1712790000000,
  "pid": 12345
}
```

> **与 SessionMetaService 的边界**（决策 #113）：本节描述的 `subagents/<sub_id>/state.json` 字段集是**agent lifecycle 状态**（status / pid / parent_session_id 等），由 §8.2 subagent 生命周期管理写入；与 §6.13.7 SessionMetaService 维护的 sessionMeta 字段（title / tags / last_model / turn_count / last_updated / last_exit_code 等）属于不同关注点。Phase 1 实现可以选择合并到同一个 state.json（不同字段子集互不覆盖）或分文件存储——本节聚焦 agent lifecycle 视角，不展开存储布局决策。

**Subagent 状态机（7 态）**：

```
created → running → completed（正常完成）
                  → failed（执行错误）
                  → killed（用户主动 cancel）
                  → lost（崩溃，recover 时标记）
             ↕
         awaiting_approval（等待审批时临时切换，审批后回到 running）
```

- `created`：subagent 已创建但未开始执行（短暂状态）
- `running`：正在执行 agent loop
- `awaiting_approval`：tool 需要审批，阻塞等待中（UI 可展示等待状态）
- `completed`：正常完成，结果已返回
- `failed`：执行中出错
- `killed`：用户通过 `session.cancel` 主动终止
- `lost`：进程崩溃或 leader resume 时发现未完成的 subagent

`parent_session_id` 和 `pid` 只存 state.json，不在内存 `SoulRegistry` entry 里——因为同进程场景下，父就是持有 `souls` Map 的 SoulPlus（`Map<SoulKey, SoulHandle>`，见 §6.5），结构天然表达关系。`pid` 用于 leader 重启后检测 member 进程是否存活。

**Subagent 的 resume**（被动 journal repair，对齐 D5）：

SoulPlus 启动时扫描 `subagents/` 目录：
- `status == "running"` → 标记为 `"lost"`，emit NotificationEvent（category: "task", type: "task.lost"）供 UI out-of-band 展示
- `status == "completed"` / `"failed"` → 跳过
- **dangling tool calls**：检查 main 的 ContextState 中是否有未完成的 `tool_call` 指向该 subagent → **按 D5 做被动 journal repair：补 synthetic error `tool_result`**（content 写明"subagent lost due to crash"，`is_error: true`）；**不追加 recovery prompt**、**不重跑 subagent**、**不重发 LLM 决策**。

**和旧措辞的区别**：过去写的"补 stub tool_result + recovery prompt"里，"recovery prompt"这部分（追加 synthetic user_message 让 LLM 决定下一步）按 D5 / §9 被明确删除——它会污染 transcript，破坏 D7（user_message 只在真实 user prompt turn 写）。"stub tool_result"这部分保留但更名为 **synthetic error tool_result**，是 D2 的 ContextState 写入路径的 dangling 修复动作。

recovery 完成后 lifecycle 仍然是 `idle`，等下一次真实 user prompt 才会 `active`——不主动起 recovery turn。

参考 cc-remake 的 `filterUnresolvedToolUses()` 和 kimi-cli 的 `BackgroundTaskManager.recover()`，但**拒绝**它们里的 "recovery prompt 自动续跑" 经验（见 §9.5 crash recovery 的调研结论）。

### 8.3 Agent Team（多进程 SoulPlus + 可插拔 TeamCommsProvider，默认 SQLite）

**定义**：由 leader agent 创建和管理的多 agent 协作团队。每个成员是独立 Node.js 进程，运行自己的 SoulPlus。

#### 8.3.1 Agent Team 创建

Agent Team 建立后，所有通过 `TeamCommsProvider.mailbox`（Phase 1 默认是 SQLite 实现，详见 §8.3.2 / 决策 #90）进入团队的 Team Mail 都先按 D3 的三分类理解，再决定注入路径；分类定义在 **§8.3.4** 展开，这里先给出约束：

- `conversation`：peer agent 的对话消息，必须进入 `TurnManager.enqueueWake()` 路径。
- `control-steer`：强制改变执行路径的控制消息，busy 时直接注入当前 turn，idle 时立即 wake。
- `notification`：状态事件；再细分为 `info` 和 `actionable`，两者都先走 notification 分发，只有 `actionable` 在 idle 时额外发 wake token。

Leader 的 LLM 通过 `TeamCreate` 工具创建 team，然后通过 `SpawnTeammate` 工具创建成员：

```typescript
// Leader LLM 调用
TeamCreate({ team_name: "bug-fix-team", description: "修复 auth 模块" })

SpawnTeammate({
  agent_name: "researcher",
  description: "负责分析 bug 的根因",
  prompt: "请分析 auth 模块中 validateToken 函数的 bug...",
  mode: "auto",           // 权限模式
  model: "claude-sonnet-4-6",  // 可选模型覆盖
})
```

**AgentMemberConfig**：

```typescript
interface AgentMemberConfig {
  agent_name: string;        // LLM 指定，人类可读名
  description: string;       // 职责描述
  prompt: string;            // 初始任务指令
  mode?: PermissionMode;     // 权限模式，默认 "ask"
  model?: string;            // 模型覆盖（默认和 leader 一样）
  backend?: string;          // 后端引擎，默认 "kimi"（预留：未来可选 "claude-code" / "codex" / ...）
}
```

成员进程启动时通过参数传入初始配置（不走 SQLite）：
```bash
kimi-core --team-id "team_ses_xxx" --session-id "ses_yyy" \
  --agent-name "researcher" --parent-session-id "ses_xxx" \
  --prompt "分析 auth 模块..."
```

`--session-id` 由 leader 预生成并传入，member 启动后立刻可以用这个 ID 通过 `TeamCommsProvider.mailbox.poll(teamId, sessionId)` 读取消息。Phase 1 默认的 `SqliteTeamComms` 把路径从 `KIMI_HOME` 派生（`$KIMI_HOME/team_comms.db`），同一 KIMI_HOME 下的所有 Kimi CLI 实例共享同一个 provider 后端。

**SqliteTeamComms 初始化配置**（Phase 1 默认 provider，由 `createSqliteTeamComms(...).init()` 在 SoulPlus constructor 调用）：

```sql
PRAGMA journal_mode = WAL;      -- 允许并发读写（多进程安全）
PRAGMA busy_timeout = 5000;     -- 写冲突时等待 5 秒再报错
```

推荐使用 `better-sqlite3`（同步 API，WAL 支持好，Node.js 生态最成熟）。定期执行 `PRAGMA wal_checkpoint(TRUNCATE)` 回收 WAL 文件空间。

**其他 provider 实现**（均实现同一套 `TeamCommsProvider` 接口，互相可替换，详见 §8.3.2）：
- `MemoryTeamComms`（Phase 1 测试用）：零依赖，纯内存，单进程内有效
- `FileTeamComms`（Phase 2）：JSON 文件 + `proper-lockfile`，用于无 native binding 环境
- `RedisTeamComms`（Phase 3）：Redis list + pub-sub，用于跨机器 team

**Daemon 固定轮询**：leader 每 100ms，member 每 250ms（和 §6.8 / §8.3.3 `TeamDaemonConfig.pollIntervalMs` 保持一致）。不做自适应，参数简单、延迟可预测；CPU 成本由 SQLite WAL 读在实测场景下可忽略。Phase 2+ 如果 provider 支持 `subscribe()`（事件驱动 push），TeamDaemon 可降低轮询频率到兜底级别（几秒一次）——接口已预留，Phase 1 不启用。

#### 8.3.1.1 协作工具族中的 Team Mail 发送 tool

除了 `TeamCreate` / `SpawnTeammate`，架构上还必须存在一个显式的 Team Mail 发送 tool。它属于 **§10 Tool 系统**里的“协作工具族”，和 `AgentTool` 平级，不属于 Runtime builtin，也不进入 Runtime。

```typescript
interface TeamMailPublisher {
  publish(envelope: MailEnvelope): Promise<void>;
}

class TeamMailSendTool implements Tool<TeamMailSendInput, ToolResult> {
  constructor(private readonly publisher: TeamMailPublisher) {}
}
```

- 注入方式沿用 D1：host 在 tool constructor 阶段注入 `TeamMailPublisher` 或等价能力，Soul 只看到 tool，不看到 host。
- 架构层只约束“存在该工具 + 属于协作工具族 + constructor 注入”；具体命名、schema、record type 留到实现和 §10 决定。

#### 8.3.1.2 AgentBackendBridge（可插拔后端引擎）

所有 agent team 成员都通过 SQLite 统一总线通信——leader 不关心成员是 Kimi CLI、Claude Code 还是 Codex，它只 poll SQLite 里的消息。

`AgentBackendBridge` 是连接外部 CLI 引擎和 SQLite 总线的翻译层：

```typescript
interface AgentBackendBridge {
  // 生命周期
  spawn(config: AgentMemberConfig, virtualSessionId: string, teamId: string): Promise<void>;
  stop(): Promise<void>;
  isAlive(): boolean;

  // Bridge 内部自行管理（不暴露给 leader）：
  // 1. 外部子进程生命周期（启动/停止）
  // 2. 外部 stdout → 翻译 → 写入 SQLite team_mails 表
  // 3. SQLite 中自己的消息 → 翻译 → 写入外部 stdin
  // 4. Approval 桥接（外部审批请求 → SQLite → leader 处理 → SQLite → 外部响应）
  // 5. Streaming 缓冲：外部 agent 的 content.delta 不写 SQLite，只写合并后的完整消息
}
```

**KimiCliBridge**（当前唯一实现）：

```typescript
class KimiCliBridge implements AgentBackendBridge {
  // 最简单的 bridge——Kimi CLI 成员自己懂 SQLite + Wire 协议
  // bridge 的职责仅仅是：
  //   1. 预生成 session_id
  //   2. spawn kimi-core 子进程（传 --team-id, --session-id, --agent-name 参数）
  //   3. 监控进程是否存活
  //   4. stop 时 kill 进程
  // 不做任何消息翻译——member 自己读写 SQLite
}
```

**未来的 Bridge 实现**（当前不实现，架构预留）：

```typescript
// ClaudeCodeBridge: 翻译 NDJSON ↔ SQLite
//   外部 stdout (assistant message) → 翻译 → INSERT team_mails
//   SELECT team_mails (to member) → 翻译 → 外部 stdin (user message)
//   外部 control_request → 翻译 → INSERT team_mails (approval_request)

// CodexBridge: 翻译 JSON-RPC ↔ SQLite
//   外部 item/agentMessage → 翻译 → INSERT team_mails
//   SELECT team_mails (to member) → 翻译 → turn/start
//   外部 requestApproval → 翻译 → INSERT team_mails (approval_request)

// 注册表（策略模式）
const BACKEND_REGISTRY = new Map<string, () => AgentBackendBridge>([
  ["kimi",        () => new KimiCliBridge()],
  // ["claude-code", () => new ClaudeCodeBridge()],  // 未来
  // ["codex",       () => new CodexBridge()],        // 未来
]);
```

**设计原则**：
- **Leader 不知道 backend 类型**——它只 poll SQLite，统一处理所有消息
- **新增 backend = 实现新 Bridge + 注册到 BACKEND_REGISTRY**，不改 leader 任何代码
- **外部 agent 的 streaming 不入 SQLite**——bridge 缓冲 delta，只写合并后的完整 TeamMail
- **所有 backend 共享同一个 SQLite schema**——team_mails 表格式统一

#### 8.3.2 Team 通信层（可插拔接口 + SQLite 默认实现）

> 历史说明：v2 初稿把 Team 通信层硬编码成 SQLite + 单一 `TeamMailRepo` 接口（消息/注册/心跳三个职责混在同一个接口里）。Phase 6F 把它重构为**可插拔的 `TeamCommsProvider` 接口**——拆分成三个窄接口，SQLite 作为默认实现下沉到 provider 内部，详见决策 **#90**。本节给出新接口定义和默认实现。

**设计原则**：

Team 通信层是一个**可插拔的传输抽象**——和 **§14 Transport 层** 在同一哲学：接口稳定，实现可替换。业务层（`TeamDaemon` / `TeamCreate` / `SpawnTeammate`）只依赖接口，provider 决定消息怎么存、怎么路由、怎么通知。

**CC 的教训**：Claude Code 的 agent team 执行层（`TeammateExecutor`）有抽象，但**消息通道完全硬编码**——文件邮箱（`~/.claude/teams/{team}/inboxes/{agent}.json`）+ `proper-lockfile`，想换 Redis 或者 SQLite 要改全局几十处。我们不重蹈这个覆辙：**执行层有抽象，消息通道也必须有抽象**。

**四种 provider 实现**（定位清晰，避免"默认是 SQLite 其他是幻想"）：

| 实现 | Phase | 定位 | 典型场景 | 依赖 |
|------|-------|------|---------|------|
| `MemoryTeamComms` | Phase 1 | **测试** | 单进程 unit test、CI、嵌入式场景 | 零 |
| `SqliteTeamComms` | **Phase 1 默认** | **生产** | 所有实际部署场景（单机多进程 team） | `better-sqlite3` |
| `FileTeamComms` | Phase 2 | 降级 | 无 native binding 环境（纯 Node 发行包、受限容器） | 零 |
| `RedisTeamComms` | Phase 3 | 分布式 | 跨机器 team、大规模并发 | `redis` |

Phase 1 只实现 `MemoryTeamComms`（测试）+ `SqliteTeamComms`（默认），其余作为接口预留。

**接口定义**：

```typescript
// ===== 三个窄接口：单一职责 =====

// 消息通道：发布、轮询、ack、清理
interface TeamMailbox {
  // 发布一条 envelope 到邮箱（接收方在下次 poll 时会看到）
  publish(envelope: MailEnvelope): Promise<void>;

  // 轮询发给 selfSessionId 的 pending envelope 列表（不含已 ack 的）
  // 返回顺序由 provider 决定：SQLite 按 created_at ASC，Memory / File 按插入顺序
  poll(teamId: string, selfSessionId: string): Promise<MailEntry[]>;

  // 标记一条 entry 为已处理（= CC 语义的 "ack"，不是"投递"）。
  // 调用方必须先完成所有 side-effect（append wire / enqueueWake / ...）再调 ack。
  // 允许幂等重复调用（provider 内部按 row_id 去重）。
  ack(rowId: string): Promise<void>;

  // 定期清理 olderThanMs 毫秒之前的已 ack 消息，返回清理条数。
  // TeamDaemon 每小时调用一次 cleanup(teamId, 24 * 3600 * 1000)。
  // CC 的文件 inbox 只标记 read 不删除，时间一长 inbox 膨胀，我们主动 GC 避免这个坑。
  cleanup(teamId: string, olderThanMs: number): Promise<number>;

  // === 可选：事件驱动订阅（Phase 2+ 才由具体 provider 实现） ===
  // 如果 provider 支持 push（SQLite 的 `LISTEN/NOTIFY` / Redis pub-sub / File watcher），
  // TeamDaemon 可以把轮询频率降到兜底级别（几秒），大幅降低空闲 CPU 和消息延迟。
  // Phase 1 不强制 provider 实现此方法——所有 provider 都走 poll 路径。
  subscribe?(
    teamId: string,
    selfSessionId: string,
    onEnvelope: (entry: MailEntry) => void,
  ): () => void;  // 返回取消订阅函数
}

// 成员注册表：team 和 member 的地址簿
interface TeamRegistry {
  registerTeam(info: TeamInfo): Promise<void>;
  registerMember(info: MemberInfo): Promise<void>;
  listMembers(teamId: string): Promise<MemberInfo[]>;
  markMemberDead(teamId: string, sessionId: string): Promise<void>;
  deregisterTeam(teamId: string): Promise<void>;
}

// 心跳：activity / liveness 信号
interface TeamHeartbeat {
  // Member 定期调用（默认 30s 一次）
  updateHeartbeat(sessionId: string): Promise<void>;
  // Leader 扫描超过 thresholdMs 没更新心跳的 member
  listStaleMembers(teamId: string, thresholdMs: number): Promise<StaleMember[]>;
}

// ===== 组合：provider 就是三个窄接口的聚合体 =====

interface TeamCommsProvider {
  readonly mailbox: TeamMailbox;
  readonly registry: TeamRegistry;
  readonly heartbeat: TeamHeartbeat;

  init(): Promise<void>;   // 创建表 / 目录 / 索引
  close(): Promise<void>;  // 释放资源（关 DB 句柄 / 停 file watcher / ...）
}

// 工厂函数类型：不同 provider 有不同的 config 类型
type TeamCommsFactory<Config> = (config: Config) => TeamCommsProvider;
```

**核心数据类型**（完整 TypeScript 定义见 **附录 D.8**）：

- **`MailEnvelope`**：transport 层在 mailbox 之间传递的最小单元。字段：`envelope_id`（去重键）/ `type`（消息类型，snake_case）/ `from` / `to`（session_id）/ `timestamp` / `data`（业务载荷）
- **`MailEntry`**：从 `mailbox.poll` 读出的条目（`envelope` + `row_id` + `status` + `created_at`）
- **`TeamInfo`**：Team 元信息（`team_id` / `team_name` / `leader_session_id` / `created_at`）
- **`MemberInfo`**：Member 元信息（`team_id` / `session_id` / `agent_name` / `description?` / `is_active` / `joined_at` / `pid?`）
- **`StaleMember`**：Heartbeat 扫描结果（`session_id` / `last_heartbeat` / `stale_since_ms`）

**接口设计决策**：

1. **为什么三个窄接口而不是一个大接口** —— 单一职责原则：消息 / 注册 / 心跳是三件独立的事，混在同一接口里会让实现类耦合（换心跳就要动消息代码）。拆开后组合自由度高：未来可以"SQLite mailbox + Redis heartbeat"这种混搭。测试也更简单——unit test 只 mock 需要的那个接口。
2. **为什么 `envelope_id` 是强制字段** —— CC 的消息没有唯一 ID，去重靠 `from|timestamp|text前100字`，这是缺陷（两条一模一样的消息连发会被误判成重复）。我们把 `envelope_id` 提到强制层，transport 去重一律按它。
3. **为什么加 `cleanup` 方法** —— CC 只标记 read 不删除消息，inbox 文件越来越大。我们在接口层就要求 provider 支持清理，TeamDaemon 每小时触发一次 GC。
4. **为什么 `ack` 不是 `markDelivered`** —— 语义上 ack 是"消息处理完毕"而不是"投递成功"。TeamDaemon 先把 side-effect（wire append / enqueueWake / ...）做完，再调 `ack`；provider 不再像旧 `TeamMailRepo` 那样把"append journal + UPDATE status"两步藏在内部——这两步的顺序由 TeamDaemon 自己负责（让 provider 只管自己的存储，不越界管 journal）。
5. **为什么 `subscribe` 是可选的** —— 事件驱动需要具体 provider 的能力（SQLite 的 `LISTEN/NOTIFY` 不是所有版本都有、File provider 需要 `fs.watch`、Redis 原生支持 pub-sub），强制所有 provider 实现会把下限拉高到"没法实现"。把它标记 optional 让支持 push 的 provider 可以优化，不支持的退化到轮询。Phase 1 所有 provider 都走 poll 路径，Phase 2+ 再引入 push。

##### SQLite 默认实现

`SqliteTeamComms` 是 Phase 1 的默认 provider。它是**生产用**的实现，不是参考实现——SQLite 在并发（WAL 模式）、查询（索引）、清理（`DELETE WHERE`）、去重（`UNIQUE` 约束）、事务（BEGIN/COMMIT）各方面都优于文件 inbox，保留为默认是经过技术权衡的选择。

所有 SoulPlus 实例（无论是否参与 team）启动时检查全局 SQLite 数据库，不存在则由 `SqliteTeamComms.init()` 创建：

```
~/.kimi/team_comms.db   （路径由 PathConfig 决定，见 §17.2；同一 KIMI_HOME 的 team 共享这个文件）
```

**Schema**（由 provider 自己管理，**不暴露给 TeamDaemon**——TeamDaemon 只看接口）：

```sql
-- 消息表（核心）
-- 列分为三层：Transport 层（路由+投递）、Mail 层（消息关联）、Content 层（业务内容）
CREATE TABLE team_mails (
  -- ===== Transport 层 =====
  id           INTEGER PRIMARY KEY AUTOINCREMENT, -- DB 内部排序键（= MailEntry.row_id）
  team_id      TEXT    NOT NULL,       -- 命名空间隔离，格式: "team_<leader_session_id>"
  from_sid     TEXT    NOT NULL,       -- 发送方 session_id（≈ WireMessage.session_id）
  to_sid       TEXT    NOT NULL,       -- 接收方 session_id（≈ WireMessage.to）
  from_agent   TEXT    NOT NULL,       -- 发送方 agent name（≈ WireMessage.from）
  to_agent     TEXT    NOT NULL,       -- 接收方 agent name
  status       TEXT    DEFAULT 'pending', -- pending → delivered（= ack 后）
  created_at   INTEGER NOT NULL,       -- 发送时间（≈ WireMessage.time）
  delivered_at INTEGER,                -- ack 时间（用于 cleanup 的"老消息"判定）

  -- ===== Mail 层 =====
  mail_id      TEXT    NOT NULL UNIQUE,-- envelope 幂等 ID 的物理索引列（历史命名保留）
  reply_to     TEXT,                   -- 对话/审批等消息的关联回复 ID（可选）

  -- ===== Content 层 =====
  wire_envelope TEXT   NOT NULL        -- MailEnvelope JSON：{envelope_id, type, from, to, timestamp, data}
);

CREATE INDEX idx_recipient ON team_mails(team_id, to_sid, status);
CREATE INDEX idx_mail_id ON team_mails(mail_id);
CREATE INDEX idx_cleanup ON team_mails(team_id, status, delivered_at);  -- cleanup 用

-- Team 注册表（地址簿）
CREATE TABLE teams (
  team_id           TEXT PRIMARY KEY,
  team_name         TEXT NOT NULL,
  leader_session_id TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id      TEXT    NOT NULL,
  session_id   TEXT    NOT NULL,
  agent_name   TEXT    NOT NULL,
  description  TEXT,
  is_active    BOOLEAN DEFAULT TRUE,
  joined_at    INTEGER NOT NULL,
  heartbeat_at INTEGER,               -- member 每 30s 更新，leader 重启后检查新鲜度
  pid          INTEGER,               -- member 进程 PID（备用检测）
  PRIMARY KEY (team_id, session_id)
);
```

Schema 和之前一字不差；变化只在"它被谁用"——**由 `SqliteTeamComms` provider 自己管理**，TeamDaemon 和上层业务不再看到这些表的存在，只持有 `TeamMailbox` / `TeamRegistry` / `TeamHeartbeat` 接口。

**wire_envelope 列的内容**：`MailEnvelope` JSON。SQL 列承担路由和投递职责（≈ Transport 的连接管理），wire_envelope 承担业务内容（≈ Transport 传输的 frame）。

| 职责 | Stdio/Socket/WS Transport | SQLite "Transport"（SqliteTeamComms 内部） |
|------|--------------------------|-------------------|
| 路由 | 连接本身（每连接=一个 client） | SQL 列：from_sid, to_sid, team_id |
| Envelope 幂等 key | WireMessage.id | SQL 列：mail_id（镜像 `MailEnvelope.envelope_id`） |
| 时间戳 | WireMessage.time | SQL 列：created_at |
| 投递状态 | 无（实时） | SQL 列：status（pending/delivered） |
| 业务内容 | frame（JSON string） | wire_envelope（`MailEnvelope` JSON） |

**转换链**（MailEnvelope → WireRecord → wire.jsonl）：
```
MailEnvelope（SQLite wire_envelope）
  + SQL 列路由元数据（session_id, from_sid）
  → WriteRequest（JournalWriter 入参，= WireRecord 减去 seq/time）
  + seq + time（JournalWriter 分配）
  → WireRecord（wire.jsonl 一行）
```

Leader daemon 读到 envelope 后，补全路由字段 → 调用 `SessionJournal.append*()` → 记录到 leader 的 wire.jsonl（审计链完整，不允许直连 `journalWriter.append()`）。这个顺序保证（先 append journal，再 `mailbox.ack`）由 TeamDaemon 的业务逻辑负责，不再藏在 provider 内部。

**`team_mail` payload 内 `mail_id` 和 `reply_to` 的设计**（不变）：

```
Leader → Researcher "调研这个 bug"
  envelope_id: env_001, data.mail_id: env_001, data.reply_to: null

Researcher → Leader "找到了，在 auth 模块"
  envelope_id: env_002, data.mail_id: env_002, data.reply_to: env_001    ← 强关联回复

Leader → Researcher "修一下"
  envelope_id: env_003, data.mail_id: env_003, data.reply_to: env_002    ← 继续追问

Coder → Leader "重构做完了"
  envelope_id: env_004, data.mail_id: env_004, data.reply_to: null       ← 纯通知
```

- `envelope_id`：transport 层的统一幂等 key，**所有** envelope 必须有
- `data.mail_id`：`team_mail` 暴露给 agent 的消息 ID，默认与 `envelope_id` 相同
- `data.reply_to`：可选，指向被回复消息的 mail_id。不填表示新话题或纯通知

**SQLite provider 实现类**（伪代码）：

```typescript
// SqliteTeamComms 是三个窄实现类 + 工厂函数的组合
class SqliteTeamMailbox implements TeamMailbox {
  constructor(private readonly db: Database) {}

  async publish(envelope: MailEnvelope): Promise<void> {
    // INSERT INTO team_mails(...) VALUES (...)
    // mail_id UNIQUE 约束 + INSERT OR IGNORE 保证幂等（重复 publish 同一 envelope_id 是 no-op）
  }

  async poll(teamId: string, selfSessionId: string): Promise<MailEntry[]> {
    // SELECT ... FROM team_mails WHERE team_id=? AND to_sid=? AND status='pending'
    //   ORDER BY created_at ASC
    // 每行反序列化为 MailEntry（row_id = id 字符串，envelope = JSON.parse(wire_envelope)）
  }

  async ack(rowId: string): Promise<void> {
    // UPDATE team_mails SET status='delivered', delivered_at=? WHERE id=?
  }

  async cleanup(teamId: string, olderThanMs: number): Promise<number> {
    // DELETE FROM team_mails
    //   WHERE team_id=? AND status='delivered' AND delivered_at < ? - olderThanMs
    // RETURNING COUNT(*)
  }

  // Phase 1 不实现 subscribe
}

class SqliteTeamRegistry implements TeamRegistry {
  constructor(private readonly db: Database) {}
  async registerTeam(info: TeamInfo): Promise<void> { /* INSERT INTO teams */ }
  async registerMember(info: MemberInfo): Promise<void> { /* INSERT INTO team_members */ }
  async listMembers(teamId: string): Promise<MemberInfo[]> { /* SELECT FROM team_members */ }
  async markMemberDead(teamId: string, sessionId: string): Promise<void> {
    /* UPDATE team_members SET is_active=false WHERE ... */
  }
  async deregisterTeam(teamId: string): Promise<void> {
    /* DELETE FROM teams + team_members WHERE team_id=? */
  }
}

class SqliteTeamHeartbeat implements TeamHeartbeat {
  constructor(private readonly db: Database) {}
  async updateHeartbeat(sessionId: string): Promise<void> {
    // UPDATE team_members SET heartbeat_at=? WHERE session_id=?
  }
  async listStaleMembers(teamId: string, thresholdMs: number): Promise<StaleMember[]> {
    // SELECT session_id, heartbeat_at FROM team_members
    //   WHERE team_id=? AND is_active=true AND heartbeat_at < ? - thresholdMs
  }
}

// 工厂函数：封装 db 构造 + 表初始化
function createSqliteTeamComms(config: { dbPath: string }): TeamCommsProvider {
  const db = new Database(config.dbPath);
  const mailbox = new SqliteTeamMailbox(db);
  const registry = new SqliteTeamRegistry(db);
  const heartbeat = new SqliteTeamHeartbeat(db);
  return {
    mailbox,
    registry,
    heartbeat,
    async init() {
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      // 执行 CREATE TABLE IF NOT EXISTS ... 所有表和索引
    },
    async close() {
      db.close();
    },
  };
}
```

##### Memory 实现（Phase 1 测试）

`MemoryTeamComms` 是 Phase 1 必须实现的测试 provider。它让 unit test 和 CI 不再依赖 `better-sqlite3` native binding——对单进程测试场景足够了。

```typescript
class MemoryTeamMailbox implements TeamMailbox {
  // 每个 (teamId, selfSessionId) 对应一个 FIFO 队列
  private queues = new Map<string, MailEntry[]>();
  private nextRowId = 1;

  async publish(envelope: MailEnvelope): Promise<void> {
    const key = `${/* teamId 从 envelope 推导或调用方传入 */}:${envelope.to}`;
    const entry: MailEntry = {
      row_id: String(this.nextRowId++),
      envelope,
      status: "pending",
      created_at: Date.now(),
    };
    const q = this.queues.get(key) ?? [];
    q.push(entry);
    this.queues.set(key, q);
  }

  async poll(teamId: string, selfSessionId: string): Promise<MailEntry[]> {
    const q = this.queues.get(`${teamId}:${selfSessionId}`) ?? [];
    return q.filter((e) => e.status === "pending");
  }

  async ack(rowId: string): Promise<void> {
    // 遍历所有队列，找到 row_id 匹配的 entry 标记 delivered
  }

  async cleanup(teamId: string, olderThanMs: number): Promise<number> {
    // 遍历所有队列，删除 status=delivered && created_at < now - olderThanMs 的 entry
  }
}

class MemoryTeamRegistry implements TeamRegistry { /* Map<teamId, TeamInfo> + Map<sessionId, MemberInfo> */ }
class MemoryTeamHeartbeat implements TeamHeartbeat { /* Map<sessionId, lastHeartbeat> */ }

function createMemoryTeamComms(): TeamCommsProvider {
  const mailbox = new MemoryTeamMailbox();
  const registry = new MemoryTeamRegistry();
  const heartbeat = new MemoryTeamHeartbeat();
  return {
    mailbox, registry, heartbeat,
    async init() { /* no-op */ },
    async close() { /* 清空 Map */ },
  };
}
```

**Memory provider 的边界**：只在单进程内有效，**不跨进程**。真实 agent team（多进程 SoulPlus）必须用 SQLite（或未来的 File / Redis）provider。Memory 的目标纯粹是让 TeamDaemon 和上层代码的测试不依赖 native binding。

##### 消息优先级处理

CC 的教训：紧急消息（`shutdown_request`、`approval_request`）如果和普通 `team_mail` 混在一个 FIFO 队列里按到达顺序处理，会被前面一堆普通对话堵住——`shutdown` 本来应该立即拉起 turn，却要等前面 10 条消息先处理完才轮到。

**Phase 1 就加入优先级处理**：TeamDaemon 在 `mailbox.poll()` 拿到一批 entry 后，不直接按原顺序 dispatch，而是先按消息类型分组、按优先级排序、再依次处理：

```typescript
const PRIORITY_ORDER: readonly string[] = [
  "shutdown_request",   // 最高：member 必须立即停止 / leader 立即 cleanup
  "approval_request",   // 次高：阻塞 tool 调用栈，越快响应越好
  "approval_response",  // 次高：对端在 await，越快 resolve 越好
  "team_mail",          // 普通对话消息
];

function sortByPriority(entries: MailEntry[]): MailEntry[] {
  return entries.slice().sort((a, b) => {
    const ai = PRIORITY_ORDER.indexOf(a.envelope.type);
    const bi = PRIORITY_ORDER.indexOf(b.envelope.type);
    const av = ai < 0 ? PRIORITY_ORDER.length : ai;  // 未知类型排末尾
    const bv = bi < 0 ? PRIORITY_ORDER.length : bi;
    if (av !== bv) return av - bv;
    return a.created_at - b.created_at;              // 同类型按时间
  });
}
```

TeamDaemon 的 poll 循环（见 §8.3.3）直接调用 `sortByPriority()` 后再 `for ... of` 处理。这样一批 entry 里就算 10 条 `team_mail` 前面藏了一条 `shutdown_request`，它也会被提前到最前面处理。

##### 消息清理策略

SQLite 的 `team_mails` 表长期运行下会积累大量 `status='delivered'` 的老消息。CC 的文件 inbox 因为从不删除，跑几天下来单 team 的 JSON 文件能到几 MB，每次轮询要全量 parse——这是个明确的教训。

**Phase 1 强制要求 TeamDaemon 定期清理**：每小时调用一次 `mailbox.cleanup(teamId, 24 * 3600 * 1000)`，清理 24 小时前的已 ack 消息：

```typescript
// TeamDaemon 里的周期性清理（每小时一次）
private lastCleanupAt = 0;

private async maybeCleanup(now: number) {
  const CLEANUP_INTERVAL_MS = 3600_000;    // 1 小时
  const RETENTION_MS = 24 * 3600_000;      // 保留 24 小时
  if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  const removed = await this.deps.mailbox.cleanup(this.cfg.teamId, RETENTION_MS);
  this.lastCleanupAt = now;
  // 可选：log/metric
}
```

**为什么是 24 小时而不是"处理完立刻删"** —— 崩溃恢复路径（见 §9.4.1）需要在重启后扫描 `status='pending'` 的老消息；24 小时的保留窗让 operator 有足够时间排查"为什么某条消息被 ack 了"——生产调试需要最近历史。超出 24 小时的消息已经没有调查价值，物理删除。

#### 8.3.3 TeamDaemon（统一的 Mailbox 轮询 daemon）

**设计决策**：Leader 和 Member 使用**同一个 `TeamDaemon` 类**，通过 role 参数化。参考 cc-remake 的 `useInboxPoller`——它的 leader/tmux teammate 共享同一份 poll 循环，95% 代码可复用。

**辅助类型**（`MailEntry` / `MailEnvelope` 的正式定义见 §8.3.2 与附录 D；这里只列 TeamDaemon 分支用到的 payload 别名）：

```typescript
// envelope.data 在 classification === "team_mail" 分支里的 payload
interface TeamMailPayload {
  from_agent: string;
  to_agent: string;
  mail_id: string;
  reply_to?: string;
  classification: "conversation" | "control-steer" | "notification";
  text: string;
  // 其他字段见 §8.3.2
}

// envelope.data 在 type === "approval_request" 分支里的 payload
interface ApprovalRequestPayload {
  approval_id: string;
  from_agent: string;
  to_agent: string;
  tool_call: unknown;          // 具体形状见 §12
  display: unknown;            // UI 素材
}
```

> 历史说明：v2 初稿里有一个 `TeamMailRepo` 接口（混合 listPending / markDelivered / commitDelivered / updateHeartbeat 四个方法 + 封装"append journal + UPDATE status"的顺序保证）和一个 `TeamMailRow` 类型（= 现在的 `MailEntry`）。决策 #90 把它拆成 `TeamMailbox` + `TeamHeartbeat` 两个窄接口（外加 `TeamRegistry`，但 TeamDaemon 不持有它），并且把"append journal → ack"的顺序保证从 provider 拉回 TeamDaemon 本身——让 provider 只管自己的存储，不越界管 journal。


**废除的旧设计**：
- ❌ "member 不跑 daemon，只在 approval 等待点临时 poll"
- ❌ tool 调用栈中的临时 `while (poll)` 循环

**新设计**：Member 也运行持续 daemon（250ms 间隔，比 leader 的 100ms 宽松）。这带来一个隐藏优势——**member 等 approval 时 daemon 仍在跑，可以同时收到 leader 的 cancel/shutdown/其他 team_mail**，旧设计因为 tool 调用栈被临时 poll 阻塞做不到。

Leader SoulPlus 在 team 模式下启动一个后台轮询 daemon，100ms 间隔扫描 SQLite 中自己的未读消息：

```typescript
interface TeamDaemonConfig {
  role: "leader" | "member";
  teamId: string;
  selfSessionId: string;
  pollIntervalMs: number;        // leader=100, member=250
  heartbeatIntervalMs: number;   // 30000（和 §8.3.5 / team_members.heartbeat_at 描述一致）
  scanAllMembers: boolean;       // leader=true, member=false
}

// canonical notification 分发目标类型（三路分发）。
// 注意：TeamDaemon 本身不再直接引用这个类型——它只透传 (notif, wakePolicy?)
// 给 NotificationManager.emit，由 NotificationManager 内部的 resolveTargets
// 根据 notification.category 决定真正的 targets。该类型仍保留给 NotificationManager
// 内部以及 wire schema 对齐用（见 §6.6 / 附录 B）。
type NotificationTarget = "llm" | "wire" | "shell";

// 6 个窄依赖 —— TeamDaemon 不直接引用 TurnManager / NotificationManager /
// ApprovalRuntime / SoulPlus，避免循环依赖和 god-object 耦合；
// 存储层也不再以"单一大 repo"形态出现，而是拆成 TeamMailbox + TeamHeartbeat 两个窄接口
// （由 TeamCommsProvider 组合注入，见 §8.3.2 和决策 #90）
interface TeamDaemonDeps {
  // 1. Auto-wake 路径：teammate TeamMail / subagent 完成 → TurnManager.enqueueWake()
  //    决策 #109：enqueueWake 现在走 wakeScheduler.enqueue（通过 TurnManager 的窄 callback 透传，
  //    不直接引用 WakeQueueScheduler——TeamDaemon 不知道 TurnManager 内部拆分细节）
  enqueueWake: (trigger: TurnTrigger) => void;

  // 2. Steer 路径：当前 turn 内即时注入消息（session.steer 等效入口）
  injectSteer: (input: UserInput) => void;

  // 3. Notification 路径：通过 NotificationManager 的统一分发（llm/wire/shell）
  //    canonical 签名 (notif, wakePolicy?) —— NotificationManager 内部根据 notification
  //    类型决定 targets；wakePolicy 缺省为 "next-turn"，actionable 类型由产生方显式传
  //    "immediate"。对 "llm" target 会走 ContextState.appendNotification 做 durable 写入。
  enqueueNotification: (notif: NotificationData, wakePolicy?: "next-turn" | "immediate") => Promise<void>;

  // 4. Approval 路径：approval_request / approval_response 交由 ApprovalRuntime 处理
  //    leader 侧 request 入账 + 转 UI，member 侧 response.resolve 唤醒 pending Promise
  approvalRuntime: ApprovalRuntime;

  // 5. 邮箱通道：消息的 publish / poll / ack / cleanup
  //    来源于 TeamCommsProvider.mailbox，TeamDaemon 只看这个窄接口，不知道背后是
  //    SQLite / File / Redis / Memory。
  mailbox: TeamMailbox;

  // 6. 心跳通道：member 定期 updateHeartbeat / leader 扫 listStaleMembers
  //    来源于 TeamCommsProvider.heartbeat。registry（成员注册表）不注入 TeamDaemon——
  //    registerTeam / registerMember 的触发点在 TeamCreate / SpawnTeammate tool，
  //    daemon 只负责消息和心跳两个持续性职责。
  heartbeat: TeamHeartbeat;
}

// BoundedSet：固定容量的 LRU-ish Set，超出容量时从插入最早的 entry 开始丢弃
// Phase 1 占位实现可以简单用 `Set<string>` + insertion order iteration + splice；
// 正式实现见 §9.4.1 ReplayDedupe 同款工具。
class BoundedSet<T> {
  private readonly items = new Set<T>();
  constructor(private readonly capacity: number) {}
  has(v: T): boolean { return this.items.has(v); }
  add(v: T): void {
    if (this.items.has(v)) return;
    if (this.items.size >= this.capacity) {
      const first = this.items.values().next().value;
      if (first !== undefined) this.items.delete(first as T);
    }
    this.items.add(v);
  }
}

class TeamDaemon {
  private seenEnvelopeIds = new BoundedSet<string>(2048);
  private lastHeartbeatAt = 0;        // 由 poll 循环更新（见下方 poll 实现）
  private lastCleanupAt = 0;          // 由 poll 循环更新（见 §8.3.2 "消息清理策略"）

  constructor(
    private readonly cfg: TeamDaemonConfig,
    private readonly deps: TeamDaemonDeps,
  ) {}

  start(): void { /* setInterval(this.poll, pollIntervalMs) */ }
  stop(): void  { /* clearInterval + cleanup */ }

  private async poll() {
    const now = Date.now();

    // 心跳合并到 poll 循环
    if (now - this.lastHeartbeatAt >= this.cfg.heartbeatIntervalMs) {
      await this.deps.heartbeat.updateHeartbeat(this.cfg.selfSessionId);
      this.lastHeartbeatAt = now;
    }

    // 扫自己的 pending 消息（leader 和 member 都只扫发给自己的）
    const entries = await this.deps.mailbox.poll(this.cfg.teamId, this.cfg.selfSessionId);

    // ===== 按优先级排序后再 dispatch（见 §8.3.2 "消息优先级处理"） =====
    // shutdown_request > approval_request > approval_response > team_mail
    // CC 的教训：紧急消息不能被前面一堆普通 team_mail 堵住
    const sorted = sortByPriority(entries);
    for (const entry of sorted) await this.handle(entry);

    // 活性检测
    if (this.cfg.scanAllMembers) {
      await this.checkMemberLiveness();  // 仅 leader：扫所有 member 的 heartbeat
    } else {
      await this.checkLeaderLiveness();  // 仅 member：检查 leader 还活着
    }

    // 周期性清理（每小时一次，清理 24h 前的已 ack 消息）
    // 见 §8.3.2 "消息清理策略" 的 maybeCleanup 伪代码
    await this.maybeCleanup(now);
  }

  private async handle(entry: MailEntry) {
    const envelope = entry.envelope;

    // ===== live dedup：进程内重复投递先挡一次 =====
    if (this.seenEnvelopeIds.has(envelope.envelope_id)) {
      await this.deps.mailbox.ack(entry.row_id);
      return;
    }
    this.rememberEnvelope(envelope.envelope_id); // bounded live dedup

    // ===== 先写 wire.jsonl（审计链），再 ack mailbox =====
    // 崩溃窗口：两步之间崩 → resume 时 pending 消息会被重新处理 → wire 有重复
    // 重复在 ContextState replay 时由 Set<envelope_id> 去重（见 §9.4.1）
    //
    // 顺序保证由 TeamDaemon 自己负责（不再藏在 repo 里）：
    //   1. SessionJournal.append*() / ContextState.append*()  —— 先写 wire
    //   2. mailbox.ack(entry.row_id)                          —— 再 ack
    // 这里伪代码里只体现第 2 步，第 1 步在下面 switch 的各 case 里实际发生
    // （team_mail conversation 分支走 NotificationManager.appendNotification；
    //  approval_request/response 分支走 ApprovalRuntime 的 journal 写入；
    //  shutdown_request 走 NotificationManager）。
    // 所有 case 的共同尾巴是 mailbox.ack(entry.row_id)。

    // 业务分发 —— 全部走窄 callback，不直接引用任何组件实例
    // 每个 case 在所有 side-effect（wire append / enqueueWake / ...）完成后自己调 mailbox.ack
    switch (envelope.type) {
      case "team_mail": {
        const mail = envelope.data as TeamMailPayload;
        switch (mail.classification) {
          case "conversation":
            // Auto-wake：构造 §6.4 canonical TurnTrigger，TurnManager 决定立即 startTurn 还是入 wakeQueue
            // input 必填（即便 text 为空串）——TurnManager.mergeWakeTriggers 通过 input.text 做合并，
            // TeamDaemon 把原文写进 text，结构化 payload 供下游进一步读取
            this.deps.enqueueWake({
              kind: "system_trigger",
              input: { text: this.formatTeammateMail(mail) },
              source: `teammate:${mail.from_agent}`,
              payload: mail,
            });
            // 落 notification（category: "team"）——wakePolicy 缺省 "next-turn"，
            // targets 由 NotificationManager 根据 notification.category 自动选择；
            // "llm" target 会走 ContextState.appendNotification 做 durable 写入（async，必须 await）
            await this.deps.enqueueNotification(this.toNotification(envelope));
            break;

          case "control-steer":
            // busy 时直接 injectSteer；idle 时 TurnManager 内部退化为 enqueueWake
            this.deps.injectSteer(this.toSteerInput(mail));
            break;

          case "notification":
            // info 缺省 "next-turn"；actionable 由产生方显式传 "immediate"
            await this.deps.enqueueNotification(this.toNotification(envelope));
            break;
        }
        break;
      }

      case "approval_request":
        if (this.cfg.role === "leader") {
          // leader 转发给 client UI —— 通过 ApprovalRuntime 统一入账（落 journal + emit UI 事件）
          this.deps.approvalRuntime.ingestRemoteRequest(envelope.data);
        } else {
          // member 收到 approval_request（罕见场景：sub-team）→ 走 auto-wake 进入对话
          this.deps.enqueueWake({
            kind: "system_trigger",
            input: { text: this.formatApprovalForward(envelope.data) },
            source: "approval_forwarded",
            payload: envelope.data,
          });
        }
        break;

      case "approval_response":
        // 两边都可能收到：resolve 自己的 pending approval Promise
        this.deps.approvalRuntime.resolveRemote(envelope.data);
        break;

      case "shutdown_request":
        // Shutdown 作为 actionable notification 入账 —— 显式 "immediate" 立即拉起 turn
        await this.deps.enqueueNotification(
          this.toShutdownNotification(envelope),
          "immediate",
        );
        break;
    }

    // ===== 所有 side-effect 完成后再 ack mailbox =====
    // 这个顺序是崩溃一致性保证的关键（见 §9.4.1）：
    //   1. 先 wire append / enqueueWake / ApprovalRuntime 入账（side-effect）
    //   2. 再 mailbox.ack（transport 层确认消息已处理）
    // 崩溃窗：1 写完 2 没写 → 重启后重新 poll 到这条 entry → 走 live dedup / replay dedup 去重
    //
    // 决策 #103 关键约束：上面 switch 各 case 中的 enqueueNotification 调用
    // 都是 async callback（返回 Promise<void>），TeamDaemon **必须 await** 才能保证
    // "先 side-effect 后 ack" 的 at-least-once 保证。如果不 await 就直接 ack，
    // 崩溃窗口内会出现"SQL 已 ack 但 ContextState durable 写入未完成"的通知丢失。
    // enqueueNotification 的签名已显式声明为 (...) => Promise<void>（见 §6.6 / §8.3.3
    // TeamDaemonDeps），TS 编译器会强制 caller await，从类型层面堵死这条路径。
    await this.deps.mailbox.ack(entry.row_id);
  }

  // 周期性清理（每小时一次）—— 避免 mailbox 无限增长
  // 实现见 §8.3.2 "消息清理策略" 小节的 maybeCleanup 伪代码
  private async maybeCleanup(now: number): Promise<void> {
    const CLEANUP_INTERVAL_MS = 3600_000;  // 1 小时
    const RETENTION_MS = 24 * 3600_000;    // 保留 24 小时
    if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    await this.deps.mailbox.cleanup(this.cfg.teamId, RETENTION_MS);
    this.lastCleanupAt = now;
  }

  // ─── 内部辅助方法（Phase 1 最小 signature，具体实现见 §8.3.4 / 附录 D）───

  // live dedup：记录刚处理过的 envelope_id，避免同一 poll 批次里重复处理
  private rememberEnvelope(envelopeId: string): void {
    this.seenEnvelopeIds.add(envelopeId);
  }

  // 把 TeamMailPayload 格式化成注入给 Soul 的 user-visible 文本
  private formatTeammateMail(mail: TeamMailPayload): string {
    return `[from:${mail.from_agent}] ${mail.text}`;
  }

  // control-steer 消息转成 TurnManager.injectSteer 需要的 UserInput
  private toSteerInput(mail: TeamMailPayload): UserInput {
    return { text: mail.text };
  }

  // 通用 envelope → NotificationData 转换（category 为 "team"）
  private toNotification(envelope: MailEnvelope): NotificationData {
    return {
      category: "team",
      type: envelope.type,
      data: envelope.data,
    } as NotificationData;
  }

  // shutdown_request 走 actionable notification 路径
  private toShutdownNotification(envelope: MailEnvelope): NotificationData {
    return {
      category: "team",
      type: "shutdown_request",
      data: envelope.data,
    } as NotificationData;
  }

  // 把 approval_request 转成人类可读的转发文本（sub-team 场景）
  private formatApprovalForward(data: unknown): string {
    return `[approval forwarded] ${JSON.stringify(data)}`;
  }

  // 活性检测 —— leader / member 分支，具体 SQL 见 §8.3.6 / §8.3.5
  private async checkMemberLiveness(): Promise<void> { /* 见 §8.3.5 */ }
  private async checkLeaderLiveness(): Promise<void> { /* 见 §8.3.5 */ }
}
```

**依赖形态要点**（和 §6.8 / 决策 #90 "TeamCommsProvider 可插拔接口" 一致）：
- **6 个窄依赖**：`enqueueWake` / `injectSteer` / `enqueueNotification` / `approvalRuntime` / `mailbox` / `heartbeat`
- **mailbox / heartbeat 来自 `TeamCommsProvider`**（§8.3.2），TeamDaemon 不知道背后是 SQLite / File / Redis / Memory——接口稳定，实现可替换
- **registry 不注入 TeamDaemon**——`registerTeam` / `registerMember` 的触发点在 `TeamCreate` / `SpawnTeammate` tool，由它们直接调 `provider.registry`。daemon 只负责"消息 + 心跳"两个持续性职责
- **不直接引用 NotificationManager / TurnManager / SoulPlus**——所有跨组件通信走 callback，杜绝循环依赖
- **`enqueueNotification(notif, wakePolicy?)` 签名**和 §6.6 `NotificationManager.emit` 严格对齐（Phase 6E 后 TurnManager 已不再暴露 enqueueNotification）；`targets` 由 NotificationManager 内部根据 notification.category 决定，调用方无需关心；"llm" target 由 NotificationManager 通过 `ContextState.appendNotification` 做 durable 写入
- **Approval 路径收口到 ApprovalRuntime**，leader 和 member 分别用 `ingestRemoteRequest` / `resolveRemote`，不再手动 `eventBus.emit`

**关键变更**：
- **Member 也运行持续 daemon**（不再依赖"等待点临时 poll"）
- **操作顺序**：先 `SessionJournal.append*()` / `ContextState.append*()` / `ApprovalRuntime.ingestRemoteRequest(...)`，再 `mailbox.ack(entry.row_id)`——崩溃时宁可重复也不丢。这个顺序由 TeamDaemon 的 `handle` 方法自己负责（旧 `TeamMailRepo.commitDelivered` 把这两步封装进 repo 的做法已删除，因为那会让 provider 越界管 journal）
- **心跳合并**到 poll 循环（不另开 timer），经 `heartbeat.updateHeartbeat` 窄接口写入
- **Poll 起始时间错开**：构造时 `delay = hash(sid) % pollIntervalMs`，避免惊群
- **live dedup**：`TeamDaemon` 只维护一个 bounded `seenEnvelopeIds` 做进程内去重；启动恢复的 SQL 同步和 replay 去重留给 **§9** 处理
- **统一 envelope 幂等层**：所有通过 mailbox 投递的 envelope 都先按 `envelope_id` 去重，再进入各自 payload handler；transport 幂等不再下沉到业务层
- **消息优先级**：poll 结果经 `sortByPriority()` 排序后再 dispatch，`shutdown_request > approval_* > team_mail`（见 §8.3.2）——CC 的教训，紧急消息不能被普通对话堵住
- **周期性清理**：每小时调用一次 `mailbox.cleanup(teamId, 24h)` 清理老消息——避免 mailbox 存储无限增长
- **注入路径改写**：`conversation` 直接 `TurnManager.enqueueWake()`；`control-steer` 忙时 `injectSteer()`、闲时 wake；`notification.info` 只 `NotificationManager.emit()`，`notification.actionable` 在 idle 时额外发 wake token

**Member 等 approval 的新机制**：不再有 tool 调用栈中的临时 poll 循环。Member 在 tool 调用处注册一个 in-memory `Map<envelope_id, resolve>` waiter；daemon 的 poll 扫到 `approval_response` 时调用对应的 resolve，Promise 被唤醒。这样 member 等 approval 的同时依然能响应 leader 的 cancel/shutdown/其他 team_mail。

#### 8.3.4 Team Mail 的 3 分类与 auto-wake

`§8.3` 不再使用旧的 `auto-wake / passive / immediate` 三段法来定义 Team Mail；TeamDaemon 固定遵守 D3 的 **`conversation / control-steer / notification`** 三分类。

**1. `conversation`**

- 语义：peer agent 的正常对话，必须让 agent 在可运行时看到并响应。
- 路径：统一调用 `TurnManager.enqueueWake()`；idle 时立即起 turn，busy 时进入 `wakeQueue`，等当前 turn 结束后合并投递。
- 典型场景：teammate 发来的请求、汇报、追问。

**2. `control-steer`**

- 语义：必须改变当前执行路径，不能等 turn 自然结束。
- 路径：busy 时直接 `injectSteer()` 进当前 turn；idle 时退化为一个立即执行的 wake token。
- 典型场景：leader 强制改计划、撤销上一条指令、要求立即停止某条分支工作。

**3. `notification`**

- 语义：状态事件，先经过通知投影，再决定是否额外 wake。
- `info`：只走 `NotificationManager.emit()`，内部通过 `FullContextState.appendNotification` 做 durable 写入（`targets: ["llm"]` 时），下次自然 turn 由 projector 从 snapshot 组装进 LLM 输入；**不 wake**。
- `actionable`：同样先 `emit()`，但如果当前 idle，再额外 `TurnManager.enqueueWake(notificationWakeToken)`——`notificationWakeToken` 是 `TurnTrigger` 的一个 `system_trigger` 形态（`{ kind: "system_trigger", input: { text: "" }, reason: "notification" }`），由产生方构造。
- 典型场景：`idle_notification` / `config_changed` 属于 `info`；`task_completed` / `member_dead` 属于 `actionable`。

**和 D3 对齐的 4 个代表场景**：

| 场景 | 分类 | 路径 |
|------|------|------|
| Peer agent 主动发消息 | `conversation` | `enqueueWake()` → idle 立即执行 / busy 入 `wakeQueue` |
| Leader 发强制 steer | `control-steer` | busy `injectSteer()` / idle `enqueueWake()` |
| Peer 变 idle | `notification.info` | `NotificationManager.emit()` → `ContextState.appendNotification` durable 写入 |
| Background task / teammate dead | `notification.actionable` | `NotificationManager.emit()` + idle 时额外 `enqueueWake()` |

Auto-wake 的实际状态机和队列收口在 **§6.4 TurnManager**（`wakeQueue` / `onTurnEnd` / `enqueueWake`），TeamDaemon 只负责构造 `TurnTrigger` 并经窄 callback 投递：

```typescript
// TeamDaemon 里的业务分发（节选自 §8.3.3）
case "team_mail": {
  // 构造 §6.4 定义的 TurnTrigger —— 不再引入本地 TurnInput 类型
  const mail = envelope.data as TeamMailPayload;
  const trigger: TurnTrigger = {
    kind: "system_trigger",
    input: { text: this.formatTeammateMail(mail) },
    source: `teammate:${mail.from_agent}`,
    payload: mail,
  };
  // 经 6 个窄依赖之一的 enqueueWake 投递 —— TurnManager 根据 lifecycle
  // 决定直接 startTurn 还是 push wakeQueue，TeamDaemon 不感知状态机
  this.deps.enqueueWake(trigger);
  break;
}
```

Turn 结束后的合并、lifecycle 迁移（`active` → `completing` → `idle`/`active`）全部由 TurnManager 负责，TeamDaemon 不持有 `wakeQueue`、也不调用 `startTurn`。

**合并策略**：如果 turn 执行期间积攒了多条 teammate 消息，TurnManager 的 `mergeWakeInputs` 把它们合并为一个输入（详见 §6.4）：

```
[系统触发: 以下消息在你处理上一轮时到达]

1. teammate "researcher" (mail_id: env_005, 回复 env_001):
   bug 已经修复了，PR 在 #123

2. teammate "coder" (mail_id: env_006):
   重构完成，所有测试通过
```

**TurnTrigger 类型定义**：见 **§6.4 TurnManager**（canonical）。§8 不重复定义——历史草稿里的 `TurnInput` 概念已并入 `TurnTrigger`（`kind: "user_prompt" | "system_trigger"`，带 `source` 和 `payload`），`system_trigger` 分支覆盖本节所有 auto-wake 场景（teammate / subagent completion / shutdown notification）。

#### 8.3.5 Approval 在 Agent Team 中的处理

**同进程 subagent 的 approval**（已有机制）：
```
subagent Soul → approval.request → EventBus → Wire Server → client UI
client → approval.response → Wire Server → approval_runtime.resolve() → tool 继续
```

**多进程 team member 的 approval**：
```
member Soul 需要 approval
→ 写 SQLite envelope: { envelope_id: env_010, type: "approval_request", to: leader_sid }
→ 在 member 本地的 ApprovalRuntime 注册 pending Promise（Map<envelope_id, resolve>）
→ tool 调用栈 await 该 Promise（不阻塞 daemon poll loop）

Leader TeamDaemon 100ms 轮询读到 "approval_request"
→ approvalRuntime.ingestRemoteRequest(envelope.data)
→ Leader 的 ApprovalRuntime 落 journal + emit "approval.request" → Wire Server → client UI
→ 用户批准
→ Leader 写 SQLite envelope: { envelope_id: env_011, reply_to: env_010, type: "approval_response", to: member_sid }

Member TeamDaemon 250ms 轮询读到 "approval_response"
→ approvalRuntime.resolveRemote(envelope.data)
→ 唤醒对应 envelope_id 的 Promise → tool 继续
```

注意 member 侧**不是临时 poll**——member 的 TeamDaemon 始终在运行（见 §8.3.3），approval 等待仅仅是 tool 调用栈上的一个 Promise，daemon 依然可以并行收到 leader 的 cancel/shutdown/其他 team_mail。

所有 agent 的 approval 最终都汇聚到同一个 client UI（leader 的 Wire Server），用户只需面对一个界面。

#### 8.3.6 Agent Team 的 Resume

**Leader 崩溃重启**：
1. 通过 `TeamCommsProvider.registry.listMembers(teamId)` 读回自己 team 的所有成员状态
2. 通过 `TeamCommsProvider.mailbox.poll(teamId, selfSessionId)` 读取所有 pending envelope，走 §9.4.1 的启动恢复流程处理积压
3. 通过 `TeamCommsProvider.heartbeat.listStaleMembers(teamId, 90_000)` 扫描心跳过期的 member，调 `registry.markMemberDead(...)` 标记
4. 读自己的 wire.jsonl 重建 ContextState（含 dangling tool call 修复）
5. **不自动重启 member**——member 如果是独立进程，可能还在跑

注：上述所有调用都走 `TeamCommsProvider` 的三个窄接口，不直接触达具体 provider 的存储细节（SQLite `team_mails` 表 / File inbox / Redis list / ...）。

**Member 崩溃检测（双重机制）**：

**主路径——exit 事件监听**：Leader 的 KimiCliBridge 通过 `child_process.spawn()` 启动 member，保持 `ChildProcess` 引用，监听 `'exit'` 事件：

```typescript
class KimiCliBridge implements AgentBackendBridge {
  private childProcess: ChildProcess;

  async spawn(config, virtualSessionId, teamId) {
    this.childProcess = spawn('kimi-core', [...args]);
    this.childProcess.on('exit', (code, signal) => {
      // member 退出（正常或崩溃），操作系统级保证
      // 走 TeamCommsProvider.registry 的窄接口标记死亡
      await teamComms.registry.markMemberDead(teamId, virtualSessionId);
      this.writeExitNotification(virtualSessionId, code, signal);
    });
  }
}
```

即时检测，0 延迟。覆盖"leader 在线 + member 退出"的场景。

**备用路径——Heartbeat 超时**：Member 每 30 秒通过 `TeamCommsProvider.heartbeat.updateHeartbeat(sessionId)` 更新心跳；Leader 重启后 + 定期通过 `heartbeat.listStaleMembers(teamId, 90_000)` 扫描超时的 member：

```typescript
// Member 端：每 30 秒更新（由 TeamDaemon.poll 循环内合并调用，不另开 timer）
// this.deps.heartbeat.updateHeartbeat(this.cfg.selfSessionId)

// Leader 端：重启后 + 定期检查
const stale = await teamComms.heartbeat.listStaleMembers(teamId, 90_000);  // 3 倍间隔 = 90s
for (const m of stale) {
  await teamComms.registry.markMemberDead(teamId, m.session_id);
}
```

**provider 实现如何存心跳**：
- **SQLite provider**：存 `team_members.heartbeat_at` 列（`UPDATE ... WHERE session_id=?`）
- **File provider（Phase 2）**：每个 member 一个 `heartbeat_<sid>.json`，用 mtime 或文件内容里的 timestamp
- **Memory provider**：存 `Map<sessionId, lastHeartbeat>`
- **Redis provider（Phase 3）**：`SET heartbeat:<sid> <ts> EX 300`

业务层不知道也不关心具体存哪里，只看 `TeamHeartbeat` 接口。

覆盖"leader 崩溃重启后不知道 member 状态"的场景（exit 事件只在 leader 在线时有效，leader 重启后 ChildProcess 引用丢失）。

**完整场景覆盖**：

| 场景 | 检测方式 | 延迟 |
|------|---------|------|
| Leader 在线 + member 正常退出 | exit 事件 | 即时 |
| Leader 在线 + member 崩溃 | exit 事件 | 即时 |
| Leader 重启 + member 还活着 | heartbeat 新鲜 → 继续监控 | 0 |
| Leader 重启 + member 已死 | heartbeat 过期 → 标记 dead | 最多 90s |

参考 kimi-cli 的 `BackgroundTaskManager.recover()`（`worker_stale_after_ms` 配置驱动）和 cc-remake 的 `isActive` 状态检测。不自动重启崩溃的 member（和 cc 一致），只标记 dead 并通知 leader agent。

#### 8.3.7 参考验证（调研结论）

**cc-remake Agent Team 架构**（cc-spawn-analyst + cc-mailbox-analyst + cc-task-flow-analyst 数据）：
- cc 有两种 agent 模式：in-process teammate（同进程 AsyncLocalStorage 隔离）和 tmux/subprocess teammate（独立进程 + 文件邮箱）
- 文件邮箱：JSON 数组 `TeammateMessage[]`，500ms 轮询，proper-lockfile 并发控制，消息标记 read=true 不删除
- SendMessage 完全非阻塞，leader 发完立即继续
- 普通消息无 correlation ID，靠 LLM 上下文理解；结构化消息（shutdown、plan_approval）有 request_id
- Teammate 消息 wrapped 成 `<teammate-message>` XML 注入 LLM context 作为 user message
- 不自动重启崩溃的 teammate；resume 通过 `filterUnresolvedToolUses()` 过滤未完成的 tool call

**kimi-cli Subagent 架构**（kimi-subagent-analyst 数据）：
- 全部同进程 asyncio coroutine（foreground await / background create_task）
- RootWireHub 作为 session 级广播总线管理 approval request
- Foreground subagent 直接 pipe 父 wire；background subagent 走 RootWireHub
- Background agent 的 approval 通过 ApprovalSource 标记来源（kind + agent_id + subagent_type）
- Recover：标记为 "lost"，不自动重启

**pi-mono**（pi-team-analyst 数据）：
- 不支持 agent team / 多 agent 并发
- 单 agent 使用 steer/followUp 消息队列处理复杂度
- MOM EventsWatcher 是外部触发机制，不是 agent-to-agent 通信

**v2 的改进**：
- 比 cc 更结构化：mail_id + reply_to 显式关联（cc 无关联 ID，靠 LLM 推断）
- 比 cc 更实时：SQLite 100ms 轮询（cc 文件邮箱 500-1000ms 轮询）
- 比 kimi-cli 更灵活：支持多进程 agent team（kimi-cli 纯同进程）
- Wire 协议统一：SQLite payload = WireMessageEnvelope，一套序列化格式

---

## 九、Crash Recovery

### 9.1 恢复原则：被动 journal repair，启动后一律回 idle

崩溃恢复的目标不是"续跑原 turn"，而是把 durable journal 修到**自洽可 replay**，然后把 session 带回一个可再次接收请求的稳定点。

**统一规则**：
- 重启后 lifecycle 一律初始化为 `idle`；不恢复到 `active`，也不自动起 recovery turn。
- 启动阶段只做 journal repair：补 synthetic records、截断最后一行残缺 JSON、校验 compaction 边界。
- 不追加 synthetic `user_message` 作为 recovery prompt。
- 不自动重跑 tool、不自动重发 approval、不尝试恢复原 turn 的闭包 / waiter / subprocess / abort tree。
- 恢复提示只走 `notification` 或 UI out-of-band；**不走 transcript**。

**启动顺序**：
1. 载入 metadata / archive 链并把 lifecycle 置为 `idle`
2. 如果最后一行是截断写入导致的残缺 JSON，仅允许截断**最后一行**
3. 按 record ownership 做 repair：
   - `ApprovalRuntime.recoverPendingOnStartup()`：为 dangling `approval_request` 补 synthetic `approval_response(response: "cancelled", synthetic: true)`
   - `ContextState`：为 dangling tool execution 补 synthetic error `tool_result`
   - `SessionJournal`：为缺失的 `turn_end` 补 synthetic `turn_end(reason: "interrupted", synthetic: true)`
4. replay 修复后的 journal，重建 `ContextState` / 通知缓冲 / TeamDaemon 读侧索引
5. 向 UI 发恢复通知；用户下次 `prompt` 或下一次自然 wake 时，LLM 基于修复后的 durable 历史继续决策

### 9.2 write-ahead 持久化边界

恢复策略依赖 write-ahead 边界，而不是依赖"崩溃后把内存态接回去"。

> **新丢失边界（决策 #95）**：JournalWriter 异步 batch drain 后，`drainIntervalMs`（默认 50ms）内入队但未 drain 的 record 全部丢失（最坏 64 条 / 1MB）。**force-flush kinds**（`approval_response` / `turn_end` / `subagent_completed` / `subagent_failed`）零丢失。其余丢失等价于"该 record 从未写入"，按 §9.3 dangling 修复路径处理；§9.4.1 envelope-level 幂等机制额外兜住"消息延迟 / 重传"路径。

```
turn_begin
  ↓
真实用户 turn：append user_message
  ↓
LLM 响应完成（text + tool_calls）
  ↓
append assistant_message
  ↓
tool_call_dispatched / approval_request / approval_response
  ↓
append tool_result
  ↓
turn_end
```

- `assistant_message` 在 tool 执行前 durable，保证"模型已经决定调用什么工具"不会丢。
- `tool_result`、`approval_response`、`turn_end` 若缺失，都按各自 owner 补 synthetic record，而不是恢复内存中的 promise / subprocess。
- write-ahead 只保证 durable 边界清晰，不保证 HTTP stream、tool 进程、approval waiter 这类纯内存状态可恢复。

### 9.3 dangling 记录修复（按 owner 分流）

恢复阶段只修**缺失的 durable record**，并且由各自 owner 负责补写：

| dangling 形态 | owner | 启动修复 |
|---|---|---|
| `approval_request` 已写、`approval_response` 缺失 | `ApprovalRuntime` | `recoverPendingOnStartup()` 补 synthetic `approval_response`，`response: "cancelled"`、`synthetic: true` |
| `assistant_message` / `tool_call_dispatched` 已写，但 `tool_result` 缺失 | `ContextState` | 补 synthetic error `tool_result`，wire 语义为 `is_error: true`，内容为 `"tool execution cancelled"` |
| `turn_begin` 已写，但 `turn_end` 缺失 | `SessionJournal` | 补 synthetic `turn_end`，`reason: "interrupted"`、`synthetic: true` |

这里的关键约束是：
- repair 只补 durable 缺口，不引入新的 turn。
- repair 不向 transcript 注入解释性 `user_message`。
- repair 后的下一步由 LLM 在**下一次自然 turn**里自行判断，是继续、重试、换方案，还是向用户确认。

### 9.4 不可恢复损坏：`broken` 是健康标记，不是 lifecycle

`broken` 不是第 6 个 lifecycle 状态，而是与 lifecycle 正交的**独立健康标记**。lifecycle 仍只有 `idle / active / completing / compacting / destroying`（canonical 顺序见 §6.4 / §6.12.2）。

**可恢复 vs 不可恢复**：
- **可恢复**：仅最后一行残缺、compaction 中间态可按规则回滚、dangling durable record 可由 owner 补 synthetic 记录。
- **不可恢复**：中间行 `JSON.parse` 失败（不是最后一行截断）、metadata header 无效、replay 发现不可恢复的结构错误。

一旦命中不可恢复条件，session 进入 `broken`：
- 允许的最小操作只有 `session.list`（返回时标记 `broken`）和 `session.destroy`（强制删除）。
- `session.prompt`、`session.compact`、`session.cancel` 以及其他会改变会话状态的操作一律返回 `session_broken`。
- UI 可以提示用户手动修复文件或销毁该 session，但 Core 不再尝试"边读边猜"继续服务。

**错误码登记**：`session_broken` 是 v2 的独立 Wire 错误码，配合 §3.5 的错误处理约定使用——任何对 `broken` 标记的 session 发起的写入类 / 控制类方法调用都以 `error: { code: "session_broken", ... }` 响应返回，client 侧据此提示用户进入"手动修复或 destroy"分支。此错误码不走 lifecycle 状态机（`broken` 是正交健康标记不是 lifecycle 状态），也不触发 Abort Propagation Contract 的级联（见 D17 / §7）。

### 9.4.1 Agent Team 消息的崩溃一致性（at-least-once + envelope-level 幂等）

Team 通信层（`TeamMailbox`）仍然采用 **先 side-effect，后 ack** 的 at-least-once 模式：

```
Step 1: SessionJournal.append*() / ContextState.append*()   // 先写 wire
Step 2: mailbox.ack(entry.row_id)                           // 再 ack transport
```

变化点在于：去重不再只对 `team_mail.data.mail_id` 生效，而是对**所有 mailbox envelope**统一按 transport 层的 `envelope_id` 处理。

**三层防线**：
1. **TeamDaemon live dedup**：进程内 `seenEnvelopeIds` 先挡住热路径重复投递。
2. **启动恢复阶段 mailbox / wire 同步**：扫描 `status='pending'` 的 entry；如果该 envelope 已经 durable 到 wire，只做 ack；否则重新 append。
3. **replay 读侧 dedup**：重建内存投影时按 envelope key 去重，保证"先写 wire 后 ack"的崩溃窗不会造成重复注入。

**各 handler 自身仍要保持幂等**，但那只是次级保险；主策略已经上升到 mailbox transport 层。

```typescript
type EnvelopeKey = string; // = MailEnvelope.envelope_id

// 启动恢复扫描：mailbox.poll 读出所有 pending entry（其中可能包含崩溃前"已写 wire 但未 ack"的条目）
async function recoverPendingMailboxEntries(
  entries: MailEntry[],
  wireIndex: Set<EnvelopeKey>,
  mailbox: TeamMailbox,
) {
  for (const entry of entries) {
    const key = entry.envelope.envelope_id;

    if (wireIndex.has(key)) {
      await mailbox.ack(entry.row_id);  // crash 前已写 wire、未 ack
      continue;
    }

    await appendEnvelopeToJournal(entry.envelope, entry); // 走 SessionJournal.append* / ContextState.append*
    await mailbox.ack(entry.row_id);
    wireIndex.add(key);
  }
}

function replayWithEnvelopeDedup(records: WireRecord[]): WiredContextState {
  const state = new WiredContextState();
  const seenEnvelopeKeys = new Set<EnvelopeKey>();

  for (const record of records) {
    const key = mailboxEnvelopeKey(record); // mailbox-sourced record 才返回 key
    if (key && seenEnvelopeKeys.has(key)) continue;
    if (key) seenEnvelopeKeys.add(key);
    state.apply(record);
  }

  return state;
}
```

这个设计的结果是：消息可能延迟、可能重复到达 wire，但不会丢；最终由 envelope-level 幂等把重复压平。

### 9.x Await-Point 崩溃恢复矩阵

> **Phase 6J 调整说明**（决策 #95，JournalWriter 异步批量）：JournalWriter 的写入语义从"每条 record 同步 fsync 才 resolve"改为"内存可见 + WAL 入队即 resolve、磁盘异步 batch drain"（默认 `drainIntervalMs=50ms`）。这引入一个新的丢失窗口——崩溃前 50ms 内入队、未 drain 完成的 record 全部丢失（最坏 64 条 / 1MB）。**force-flush kinds**（`approval_response` / `turn_end` / `subagent_completed` / `subagent_failed`，见 §4.5.4）保留同步 fsync 语义，**永不丢**。下面的矩阵在每行的"启动修复"列已经隐含这一新的丢失边界——丢失等价于"该 record 从未写入"，按"按 owner 补 synthetic record"路径处理；force-flush 命中的行（如 `turn_end` / `approval_response`）显式标注"零丢失"。

**表 1：Turn / LLM + Tool 崩溃矩阵**

| 崩溃点 | 已 durable 内容 | 丢失的内存态 | 启动修复 | 用户可见结果 |
|---|---|---|---|---|
| `turn_begin` 写了，Soul 未启动 | `turn_begin` | closure、abort tree | `SessionJournal` 补 synthetic `turn_end(reason: "interrupted")` | 用户下次 `prompt` 时 LLM 自然接续 |
| `kosong.chat` 流式输出中 | `turn_begin` + `user_message`[^kchat] | HTTP stream、内存里的 delta 聚合 | 按"无 `assistant_message`"处理：`ContextState` 不补 assistant，`SessionJournal` 补 synthetic `turn_end(reason: "interrupted")` | 用户下次 `prompt` 时 LLM 从 `user_message` 开始，相当于这个 step 从未发生；UI 里的 partial delta 丢失但对话状态干净 |
| `context.appendAssistantMessage` 进行中 | `turn_begin` + `user_message` | `assistant_message` 可能半写 | 按 D13 分类：最后一行 JSON.parse 失败 → skip（允许 tail truncation）；中间行坏 → session 进入 `broken` 健康标记 | 半写行被 tail-skip 时等价于"assistant 未写"，补 synthetic `turn_end`；`broken` 时只剩 `session.list` / `session.destroy` |
| `tool.execute` 进行中 | `... + assistant_message(with tool_calls)` | subprocess、tool state | `ContextState` 补 synthetic error `tool_result`，`SessionJournal` 补 synthetic `turn_end` | 同上 |
| `context.appendToolResult` 进行中 | `... + tool_call dispatched` | `tool_result` 可能半写 | 截断最后一行，`ContextState` 补 error `tool_result`，`SessionJournal` 补 synthetic `turn_end` | 同上 |
| Soul 正常返回，`turn_end` 未写 | 完整的 assistant + tool_results | `TurnResult`、usage | `SessionJournal` 补 synthetic `turn_end(reason: "interrupted")`。注意：`turn_end` 是 force-flush kind，**已写完则零丢失**——dangling 的来源只可能是"Soul 返回到 SessionJournal.appendTurnEnd 调用之间崩溃" | 同上 |

[^kchat]: `kosong.chat` 流式输出阶段，**完整** `assistant_message` 尚未写入 wire.jsonl——partial assistant 只在 `ChatParams.onDelta` 产生的 progress 事件里由 EventSink emit，**不进 ContextState**。因此该崩溃点 durable 内容与 "`kosong.chat` 之前" 等价，修复策略统一按"无 `assistant_message`"走。

**表 2：Approval 崩溃矩阵**

| 崩溃点 | 已 durable | 丢失 | 启动修复 | 用户可见 |
|---|---|---|---|---|
| `approval_request` 写入前 | `tool_call_dispatched`（如果有） | approval waiter | 无 request 视为 tool 未执行，`ContextState` 补 error `tool_result` | 用户下次 `prompt` 时 LLM 重新决策 |
| `approval_request` 写了，response 未到 | `approval_request` | waiter | `ApprovalRuntime.recoverPendingOnStartup()` 补 synthetic cancelled response | 同上 |
| `approval_response` 写了，tool 执行前 | request + response | tool 未启动 | 不重发 approval；后续按 dangling tool execution 由 `ContextState` 补 error `tool_result`。注意：`approval_response` 是 force-flush kind，**已写完则零丢失**——用户的决策永久落盘，恢复后不会重弹 approval | 同上 |

**表 3：TeamDaemon / Mailbox 崩溃矩阵**（适用于任意 `TeamCommsProvider` 的默认实现——SQLite / File / Memory；下面的"SQL row"字面是 SQLite provider 的具象化描述，File provider 替换为"JSON inbox entry"、Memory provider 不会遇到跨进程崩溃）

| 崩溃点 | 已 durable | 丢失 | 启动修复 | 用户可见 |
|---|---|---|---|---|
| SQL `INSERT` 完成，wire append 前 | SQL row (`pending`) | wire record | 启动恢复扫描 pending rows → 重新 append（at-least-once，envelope dedup 防重复） | 消息延迟但不丢 |
| wire append 完成，SQL ack 前 | SQL row + wire record | ack flag | 启动恢复扫描 pending → 发现 wire 已有 → 直接 ack | 无影响 |
| `NotificationManager.emit` 调用前（SQL 已 ack 但 ContextState 写入未发起） | SQL row 标记 delivered | 通知还没进 ContextState | 启动恢复扫描 SQL pending / already-delivered-but-not-notified → 重新 `NotificationManager.emit`（envelope dedup 防重复） | 无影响（通知不丢，只是写入时机推迟到恢复流程） |
| `ContextState.appendNotification` 进行中（fsync 前崩溃） | 最多半写的 `notification` 行 | 完整 NotificationRecord | 按 D13 分类：最后一行 JSON.parse 失败 → skip（允许 tail truncation），通知视同从未写入；中间行坏 → session 进入 `broken` 健康标记 | tail-skip 时通知丢失，需要上游 SQL 幂等层重放（见第一行）；`broken` 时走 `session.destroy` 流程 |
| `ContextState.appendNotification` 已完成，`enqueueWake` 前崩溃 | 完整 `notification` wire record | 内存 wakeQueue 里的 actionable wake token | 重启后 lifecycle 回 `idle`，通知**已经**是 durable 对话事件（`replay` 会重建进 transcript）；下次 LLM 调用自然读到；`actionable` 通知会等下一次自然 idle wake 或真实 user prompt | 无影响（通知不丢，只是 wake 时机推迟到下个 turn） |

**表 4：Compaction 崩溃矩阵**

> 决策 #93 后 compaction 执行整体在 `TurnManager.executeCompaction` 内（不再有 Soul 内的 `runCompaction`）。崩溃点描述按"TurnManager 跑到 executeCompaction 哪一步"读。具体修复策略不变（rotate 半路崩溃的回滚仍然适用），只是归属从 Soul 改为 TurnManager。
>
> **本表覆盖 cold path（进程重启后的 journal repair）。运行时 hot path 的 overflow recovery（决策 #96）见 §3.5 的 `context_overflow` 描述与 §6.4 `executeCompaction` 伪代码——hot path 的"compact + retry"是 turn 内动作（`recoveryAttempted` / `MAX_COMPACTIONS_PER_TURN` 熔断），不写 synthetic record，与本表的 cold path 维度正交**。两者唯一交集是：hot path 中途崩溃后，cold path 按本表回滚 / 修复。

| 崩溃点 | 已 durable | 丢失 | 启动修复 | 用户可见 |
|---|---|---|---|---|
| TurnManager 跑到 `transitionTo(compacting)` 后，`compactionProvider.run` 前 | lifecycle 在内存（已丢） | summary | lifecycle 回 `idle`，下次 turn Soul 仍会检测到 token 超阈值并 return `needs_compaction`，TurnManager 重新 `executeCompaction` | 无影响 |
| TurnManager 跑到 `compactionProvider.run` 完成，`rotate` 前 | 同上 | summary 在内存 | 同上（summary 丢了，但 `wire.jsonl` 还是旧的，完整可用） | 无影响 |
| TurnManager 跑到 `rotate` 完成（rename），boundary record 写入前 | `wire.N.jsonl` 存在，新 `wire.jsonl` 可能只有 metadata | boundary record | 检测"新 `wire.jsonl` 无 boundary record" → 回滚（删新文件，rename `wire.N` 回 `wire.jsonl`） | 下次 compact 重试 |
| TurnManager 跑到 boundary record 写入后，`resetToSummary` 前 | 新 `wire.jsonl` 含 boundary + summary | 内存 `ContextState` 未 reset | replay 新 `wire.jsonl` → 从 summary 重建 | 无影响 |

### 9.5 参考验证（调研结论）

- **unresolved tool use 检测**：cc-remake 的 `filterUnresolvedToolUses()` 和 kimi-cli 的 task recover 只提供"识别 dangling 状态"的经验；v2 不继承 recovery prompt、自动续跑或自动重跑 tool。
- **write-ahead 覆盖性**：write-ahead 保证 assistant 决策和审计边界可恢复，但 tool subprocess、approval waiter、HTTP stream 这类内存态一旦丢失，只能收口为 synthetic record，而不是恢复原执行。
- **文件级 edge cases**：最后一行截断可修；中间行损坏、metadata header 非法、replay 结构错误直接进入 `broken`；compaction 中间态按 boundary 规则回滚。
- **批量 drain 的损坏行容忍**：JournalWriter 异步批量写入后，崩溃可能产生"半行 JSON" 或最后一行截断（频率低于旧逐条 fsync 模式，因为 batch 写入是单次 `appendFile` 调用，OS 层面相对原子）；JournalReplayer 必须实现"最后一行半 JSON skip + warn、不阻断 session 恢复"——这是 Python 版 1.30 的教训（损坏 context.jsonl 导致 `--resume` 无法恢复 → 改成宽松解析 + skip）；中间行损坏仍然进 `broken`。

### 9.6 跨平台写入策略（决策 #104）

v2 的文件 I/O 隐含 POSIX 假设（`rename` 原子覆盖、`O_EXCL` 排他创建）。Phase 1 用户主要 macOS / Linux，但 Windows 兼容通过以下策略保障：

**atomic write 工具函数**（参考 Python kimi-cli 的 `atomic_json_write` + CC 的 `file.ts` tmp-rename 模式）：

```typescript
// utils/atomicWrite.ts
async function atomicWrite(targetPath: string, data: string | Buffer): Promise<void> {
  const tmpPath = targetPath + ".tmp";
  const fd = await fs.open(tmpPath, "w");
  try {
    await fd.writeFile(data);
    await fd.datasync();          // fsync 确保数据落盘
  } finally {
    await fd.close();
  }
  // fs.rename 在 Node.js 中对应 POSIX rename / Windows MoveFileEx(MOVEFILE_REPLACE_EXISTING)
  // POSIX: atomic 覆盖
  // Windows: MoveFileEx 语义——目标存在时替换，非严格 atomic 但对单写者场景足够
  await fs.rename(tmpPath, targetPath);
}
```

**各文件类型的写入策略**：

| 文件 | 写入模式 | 跨平台策略 |
|---|---|---|
| `wire.jsonl` 正常写入 | append-only（`fs.appendFile`） | 跨平台一致，无问题 |
| `wire.jsonl` compaction rotate | `rename(wire.jsonl, wire.N.jsonl)` → `create(wire.jsonl)` | Windows 上 rename 目标不存在时 OK；rollback 场景需先 `unlink` 新文件再 `rename` 回来 |
| `state.json` 更新 | `atomicWrite`（tmp + fsync + rename） | 使用上述 `atomicWrite`，Windows `MoveFileEx` 语义覆盖 |
| `tool-results/<hash>.txt` | `flag: 'wx'`（排他创建） | Node.js `O_EXCL` 跨平台一致 |
| `team_comms.db`（SQLite） | SQLite WAL 模式 | SQLite 自带跨平台文件锁（POSIX `fcntl` / Windows `LockFileEx`） |

**文件锁策略**：
- SQLite WAL 自带跨平台锁，无需额外处理。
- `wire.jsonl` 不需要锁——单写者 `JournalWriter`（§4.5.4），不存在多进程并发写同一 wire 的场景。
- 如需跨进程互斥（如多 kimi 实例操作同一 session 目录），使用 `proper-lockfile`（npm 包，已抹平 POSIX / Windows 差异）。

### 9.7 统一启动恢复顺序（决策 #105）

§9.1 的 5 步启动顺序是概要描述，散落在 §9 / §9.4.1 / §12.4 / §15.10 / §17A.1 / §6.4 的 6 处恢复策略各自定义"什么是 dangling"，但它们之间的**顺序依赖**未显式写明。本节统一定义 `SoulPlus.create` 的恢复阶段，**必须严格按此顺序执行**：

```
SoulPlus.create 的恢复阶段：

1. compaction 中间态 rollback（§6.4）
   - 检测"新 wire.jsonl 无 boundary record" → 回滚（删新文件，rename wire.N 回 wire.jsonl）
   - 必须最先执行：决定哪个 wire.jsonl 是当前文件

2. replay wire.jsonl → 重建 ContextState + SessionJournal 状态
   - 含 dangling tool_call repair：无对应 tool_result → 补 synthetic error tool_result
   - 含 dangling turn_end repair：缺失 turn_end → 补 synthetic turn_end(reason: "interrupted")
   - 含最后一行 JSON.parse 失败 → truncate（允许 tail truncation）
   - 中间行损坏 → session 进入 broken 健康标记

3. ApprovalRuntime.recoverPendingOnStartup()（§12.4）
   - 依赖 step 2 的 turn_id / approval_request 信息
   - dangling approval_request 无对应 response → 补 synthetic cancelled
   - 必须在 ContextState 恢复之后（需要知道哪些 tool_call 已补 synthetic error）

4. SkillManager 无状态启动（§15.10）
   - 无恢复需要：加载 skill 定义文件，无运行时状态
   - 与前 3 步无顺序依赖

5. MCP 连接重建（§17A.1）
   - transient state，不依赖 wire
   - Phase 1 是 NoopMcpRegistry，无实际操作
   - Phase 3 实现时在此步重新建立所有 MCP server 连接

6. TeamDaemon 恢复 mailbox polling（§8.3.3，如有 team 模式）
   - 依赖 step 2 完成（replay 建立 wireIndex 供 envelope dedup）
   - 依赖 step 3 完成（ApprovalRuntime 就绪后才能处理 approval_request/response）
   - pending envelope → 重新 poll 处理（at-least-once，envelope dedup 防重复）

7. SessionMetaService.recoverFromWire(records)（§6.13.7，决策 #113）
   - 三阶段折中策略（与决策 #75 last_exit_code 标记协同）：
     * 阶段 A：读 state.json
       - 文件不存在 → 用空 SessionMeta 初始化（首次启动 / 文件丢失）
       - 文件存在 → 解析为 SessionMeta 候选值；同时缓存 last_exit_code 供后续 flush 透传
     * 阶段 B：检查 last_exit_code
       - "clean" → 信任 state.json 的 wire-truth + derived 字段，跳过阶段 C（快路径）
       - "dirty" / 缺失 → 进入阶段 C
     * 阶段 C：replay wire.jsonl 修正 sessionMeta（dirty 路径）
       - 扫描所有 session_meta_changed → 按 seq 顺序合并 patch（覆盖 wire-truth 字段）
       - 数 turn_begin 得 turn_count
       - 取最后一条 model_changed 得 last_model
       - 取 wire 最后一条 record 的 time 得 last_updated
   - 依赖 step 2 完成（需要 wire.jsonl 已被读取且 ContextState 重建，复用同一次 wire scan，无额外 I/O）
   - 与 step 3/4/5 无顺序依赖，可并行
```

**每步的 dangling 定义汇总**：

| 恢复步骤 | dangling 形态 | 修复动作 |
|---|---|---|
| step 1 | compaction rotate 半路崩溃 | rollback rename |
| step 2 (ContextState) | tool_call 无对应 tool_result | 补 synthetic error tool_result |
| step 2 (SessionJournal) | turn_begin 无对应 turn_end | 补 synthetic turn_end(reason: "interrupted") |
| step 3 | approval_request 无对应 response | 补 synthetic cancelled response |
| step 6 | pending envelope 未处理 | 重新 poll + dispatch（走 §9.4.1 三层防线去重） |
| step 7 | dirty exit / state.json 损坏 | replay wire 重建 wire-truth + derived 字段（§6.13.7） |

**顺序依赖图**（DAG，不是完全线性——step 4/5/7 可与 step 3 并行）：

```
step 1 → step 2 → step 3 → step 6
                 ↘ step 4（无依赖，可并行）
                 ↘ step 5（无依赖，可并行）
                 ↘ step 7（依赖 step 2 的 wire scan，可与 step 3 并行）
```

**实现位置**：`SoulPlus.create()` 内部按上述顺序串行调用各 owner 的恢复方法。不引入独立的 `RecoveryCoordinator` 抽象——启动恢复只发生在 `SoulPlus.create()` 内部一个位置，抽象层的收益不覆盖成本。

### 9.8 磁盘管理与清理策略（决策 #107）

v2 需要管理 3 种可增长的文件/目录。如果不主动清理，活跃用户 1 年内可累积 5-10GB 磁盘占用（参考 CC 在没有 `cleanup.ts` 之前踩过的坑）。

**1. wire.jsonl + wire.N.jsonl 归档**

- compaction 后老文件 rename 为 `wire.N.jsonl`（§6.4）。
- 清理策略：保留最近 **30 天** 的归档文件，超过自动删除。
- 归档总大小上限：可配置（`cleanupPeriodDays`，默认 30；设为 0 = 完全禁用持久化清理）。
- 整个 session 目录的清理：`state.json` 的 `last_updated` 超过 `cleanupPeriodDays` 且没有活跃连接 → 可安全删除。

**2. tool-results/ 持久化文件**（§10.6 Tool Result Budget）

- 超限 tool result 写入 `tool-results/<tool_use_id>.txt`。
- 清理策略：compaction 时检查归档的 `wire.N.jsonl` 引用的 `tool-results/` 文件。无引用的文件删除（GC 语义——当前 `wire.jsonl` 引用的文件不会被 GC）。
- 回退兜底：如果 GC 未跑（compaction 未发生），依赖 session 级目录的整体清理（上面第 1 点）。

**3. subagents/\<id\>/wire.jsonl**

- subagent 完成 / 失败后保留一段时间（默认 **7 天**）供 replay / debug。
- 超期自动删除整个 `subagents/<id>/` 目录。

**实现位置**：
- **启动时清理**：`SoulPlus.create` 启动恢复完成后（§9.7 step 6 之后），延迟 10 分钟执行一次清理（避免启动阶段 I/O 竞争）。
- **周期性后台任务**：每小时检查一次（长 session 场景），使用 `setInterval`。
- **跨进程互斥**：使用 `proper-lockfile` 防止多 kimi 实例并发清理同一 `KIMI_HOME`；marker file 节流到每天最多一次全局清理（参考 CC `backgroundHousekeeping.ts` 的 lockfile + marker 策略）。

**参考**：CC 的 `cleanup.ts`（604 行）实现了完整的清理体系——`cleanupPeriodDays=30` 默认值经生产验证用户接受度高。v2 采用相同策略但范围更精确（v2 的目录结构更 regular：所有 session 数据在 `sessions/<sid>/` 下，比 CC 的散落目录好 GC）。

---

## 十、Tool 系统（接口 + 注册 + 命名空间）

### 10.1 Tool 的本质定位

Tool 是"LLM 可调用的原子能力单元"。Phase 2 之后的 Tool 接口**非常窄**，只管四件事：`name` / `description` / `inputSchema` / `execute`。所有权限、hook、approval、审计都不在 Tool 层——它们在 SoulPlus 的 `beforeToolCall` / `afterToolCall` 闭包里处理（见 §5.1.7 和 §11）。

这个定位和 Phase 1 之前的设计显著不同。早期 Tool 接口里塞了 `checkPermissions` / `selfCheck` / `validateInput` 三个方法，每个 tool 都要自己实现一部分权限逻辑——结果是权限检查散落在几十个 tool 里，新加一个权限维度就要改所有 tool。新设计参考 pi-mono 的做法：**Tool 只做业务逻辑，权限系统在外层横切**。Tool 作者写一个 Bash tool 时不需要知道 approval 是什么，也不需要知道 PermissionMode；这些概念只在 SoulPlus 的 `beforeToolCall` 里出现一次。

### 10.2 Tool 接口定义

```typescript
interface Tool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: ZodSchema<Input>;

  // 单条 tool result content 的字符上限（决策 #96 / Tool Result Budget；详见 §10.6）。
  // - 不声明 → 用 DEFAULT_MAX_RESULT_SIZE_CHARS（builtin = 50_000；MCP wrapper = 100_000）
  // - 数字 → 自定义上限
  // - Infinity → 永远不持久化（适合内部已自我裁剪的 tool，如 Read 自带 maxLines / maxBytes）
  readonly maxResultSizeChars?: number;

  /**
   * 声明本 tool 是否可与其他并发 safe 的 tool 同时执行。
   * - false（默认）：必须串行执行
   * - true：允许 ToolCallOrchestrator 调度并发
   * Phase 1 必做接口预留；Phase 2 ToolCallOrchestrator 启用受控并发时查询此字段。
   * 参考 cc-remake `isConcurrencySafe`，对齐 "v2 偏离 Python 全并发，走受控并发" 的设计（§11.7.1 FAQ）。
   */
  isConcurrencySafe?: (input: Input) => boolean;

  execute(
    toolCallId: string,
    args: Input,
    signal: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<Output>>;

  // ===== UI 渲染 hints（决策 #98 / Tool UI 渲染契约，全部 optional） =====
  // 6 个纯函数 hook，让 client 不需要硬编码 tool 的 args / output 字段名也能渲染富 UI。
  // 每个 hook 都是纯函数（不能 await / 不能有副作用），返回结构化 hint（不返回 framework Component）。
  // 详细职责、调用时机、默认 fallback 见 §10.7 "Tool UI 渲染契约"。
  display?: ToolDisplayHooks<Input, Output>;
}

// 决策 #98：6 个纯函数 hook，按 client 渲染需要分组
interface ToolDisplayHooks<Input, Output> {
  // tool 在 UI badge 上的人类可读名（如 "Bash" / "SandboxedBash" / "Edit"）。
  // 默认 fallback：tool.name
  // per-call 动态——streaming 早期 input 还没 parse 完，Input 是 Partial（D8）。
  getUserFacingName?(input: Partial<Input> | undefined): string;

  // spinner 旁边的简短活动描述（→ tool.call.description）。
  // 默认 fallback：`${tool.name}(${truncate(JSON.stringify(input), 80)})`
  getActivityDescription?(input: Partial<Input> | undefined): string;

  // 入参的结构化渲染 hint（→ tool.call.input_display）。
  // 同时充当 ApprovalRequest.display（§12.2 ApprovalDisplay = ToolInputDisplay 收编）。
  // 默认 fallback：{ kind: "generic", summary: tool.name, detail: input }
  getInputDisplay?(input: Input): ToolInputDisplay;

  // 结果的结构化渲染 hint（→ tool.result.result_display）。
  // 默认 fallback：result.isError → { kind: "error", message } 否则 { kind: "text", text, truncated? }
  getResultDisplay?(input: Input, result: ToolResult<Output>): ToolResultDisplay;

  // streaming progress 的人类可读描述（→ tool.progress.progress_description）。
  // tool 自决频率：return undefined 跳过本次 emit（避免每个 stdout chunk 都算）。
  // 例：BashTool 对 stdout 返回 undefined（client 自己拼 stdout 流），
  //     对 status update 返回 "Compiling..." 等。
  getProgressDescription?(input: Input, update: ToolUpdate): string | undefined;

  // 折叠态一行摘要（→ tool.result.collapsed_summary）。
  // 例：Bash → "git status (exit 0)"，Read → "config.json (124 lines)"。
  // 默认 fallback：getActivityDescription(input)
  getCollapsedSummary?(input: Input, result: ToolResult<Output>): string;
}
```

`ToolResult`、`ToolUpdate`、`ToolResultContent`、`ToolInputDisplay`、`ToolResultDisplay`、`ToolDisplayHooks` 的完整 TypeScript 定义见 **附录 D.2 Tool 相关**。字段概览：

- **`ToolResult<Output>`**：`isError?`（语义错误标记）/ `content`（给 LLM 看的内容）/ `output?`（结构化输出，给 hook / UI 读）
- **`ToolUpdate`**：`kind`（`"stdout" | "stderr" | "progress" | "status" | "custom"`）/ `text?` / `percent?` / `custom_kind?` / `custom_data?`（决策 #98 / D10：`"custom"` 是 escape hatch，让 tool 上报非标 update 类型，对应 `getProgressDescription` 看到 custom kind 时基于 custom_kind / custom_data 算描述）
- **`ToolResultContent`**：`{ type: "text"; text } | { type: "image"; source }`
- **`ToolInputDisplay` / `ToolResultDisplay`**：discriminated union（决策 #98），10+ 个具名 kind + `generic` fallback，详见 §10.7 "Tool UI 渲染契约"

**关键说明**：

- **没有** `checkPermissions` / `selfCheck` / `validateInput` 方法——所有权限都在 SoulPlus 的 `beforeToolCall` 闭包里处理。
- **没有** `canUseTool` 参数——Soul 对 approval 无感知，见铁律 2。
- **没有** `description()` / `prompt()` 函数形态——直接用静态字段 `name` / `description`，避免"prompt 随时间变化"这种副作用。
- `inputSchema` 用 [zod](https://zod.dev)，参数校验由 Soul 在调 tool 前统一做一次（见 §5.1.7 的 `runSoulTurn` 伪代码），Tool 自己不用写 `if (args.command === undefined)` 这种样板代码。
- `onUpdate` 回调用于流式进度更新——stdout chunk、percent、status 等。这些 update 会被 Soul 包装成 `tool.progress` 事件走 EventSink 发出，**不进 wire.jsonl**。详见 §4.8 的铁律。
- `execute` 的参数只有四个：`toolCallId`（用于 correlate 回调和事件）、`args`（已校验的输入）、`signal`（中断信号）、`onUpdate`（可选进度回调）。**不接受 `ctx` 参数**——tool 需要的外部依赖通过 constructor 注入。
- `maxResultSizeChars` 是**Phase 1 必做**字段（决策 #96）——超过阈值的 result content 会被 ToolCallOrchestrator 在写入 ContextState 之前持久化到磁盘并替换为 `<persisted-output>` preview。具体策略见 §10.6。

### 10.3 依赖通过 Constructor 注入

这是 Phase 2 Tool 设计的第二条硬约束：**Tool 的所有外部依赖（shell 执行器、文件系统、HTTP client、数据库 handle 等）在 constructor 时传入，而不是通过 execute 的 ctx 参数**。

反面例子（旧设计）：`execute(input, ctx, signal)`，其中 `ctx` 是一个垃圾桶对象，里面塞 `ctx.cwd` / `ctx.kaos` / `ctx.httpClient` / `ctx.sessionId` / ...。结果是 ctx 的 shape 每加一个字段，所有 tool 的类型都受影响；每个 tool 都能自由访问 ctx 里的任何东西，耦合爆炸。

新设计：每个 tool 明确声明自己的依赖，在注册时由 ToolRegistry 的构造方组装好。

```typescript
class BashTool implements Tool<BashInput, BashOutput> {
  readonly name = "Bash";
  readonly description = "Execute shell commands in the workspace";
  readonly inputSchema = z.object({
    command: z.string(),
    timeout: z.number().optional(),
  });

  constructor(
    private readonly shellExecutor: ShellExecutor,
    private readonly cwd: string,
  ) {}

  async execute(
    toolCallId: string,
    args: BashInput,
    signal: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<BashOutput>> {
    const result = await this.shellExecutor.run({
      command: args.command,
      cwd: this.cwd,
      timeout: args.timeout,
      signal,
      onStdout: (text) => onUpdate?.({ kind: "stdout", text }),
      onStderr: (text) => onUpdate?.({ kind: "stderr", text }),
    });

    return {
      isError: result.exitCode !== 0,
      content: result.stdout,
      output: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  }
}

// ─── 构造时注入依赖 ───
const bashTool = new BashTool(shellExecutor, "/home/user/project");
```

**原则**：

- 依赖在 constructor 里声明为 `private readonly`，TypeScript 在类型层面就能看出一个 tool 需要什么。
- `execute` 签名固定为四参数，新增依赖靠改 constructor，不改方法签名。
- 需要 per-turn 变化的东西（例如 `signal`、`toolCallId`）才通过 execute 参数传；长期依赖（例如 `shellExecutor`、`cwd`）通过 constructor 传。

### 10.3.1 协作工具族（D11）

除了普通的"原子能力 tool"（Read / Write / Bash / ...）之外，还存在一个独立的**协作工具族**，和 `AgentTool` 平级。这一族工具的特征是：**不是业务能力，而是 agent 之间协同的入口**，它们全部通过 **D1 的 SubagentHost 模式**做 host-side constructor 注入，**不进入 Runtime**。

Phase 1 明确纳入协作工具族的成员：

| Tool | 归属 | host-side 注入的依赖 | 说明 |
|---|---|---|---|
| `AgentTool`（对应 cc 的 `Task`） | 协作工具族 | `SubagentHost`（由 `SoulRegistry` 实现） | 派生同进程或跨进程 subagent，并阻塞等待或后台运行；见 §8.2 |
| Team Mail 发送 tool（命名留实现） | 协作工具族 | host-side 发送能力（例如 `TeamMailPublisher`） | 往 team mailbox 发消息；对应 cc-remake 的 `SendMessage`；架构层不约束具体 tool 名 / input schema / record type |
| `SkillTool`（决策 #99） | 协作工具族 | `SkillManager` + `SkillInlineWriter`（inline）+ `SubagentHost`（fork） | 让 Soul 在 turn 中自主调用已注册的 skill；user-slash 路径不走本 tool（§15.4.2）；详见 §15.9 |
| 未来 coordination tools | 协作工具族 | 由 tool 自己声明 host 接口 | 架构层只约束"存在 + 平级 + host-side 注入路径"，不限定 Phase 1 集合 |

**核心约束**：
- **不进 Runtime**：协作工具族和所有其他 tool 一样，通过 `SoulConfig.tools` 按 turn 传入；host-side 依赖在 tool constructor 注入（和 §10.3 对齐），不偷渡进 `Runtime` 接口
- **嵌入方可裁剪**：嵌入方如果不需要 agent 协作能力，根本不 `new AgentTool(...)`、也不加入 `ToolRegistry`，LLM 连 tool 名字都看不到——这是 D1 的嵌入场景屏蔽策略
- **嵌入方可替换**：嵌入方需要走自己的 orchestration 时，实现自己的 `SubagentHost`（或 Team Mail publisher），在构造 `AgentTool` / 发送 tool 时注入自己的实现

**和 Runtime 铁律的关系**：Runtime 保持严格窄接口（Phase 1 终稿仅 `kosong`，决策 #93 收窄；旧 `compactionProvider` / `lifecycle` / `journal` 已下沉到 TurnManagerDeps），**不会因为加了协作工具族而膨胀**。这是 D1 明确拒绝的演化方向——`clock` / `logger` / `idGenerator` / `SubagentHost` / `TeamMailPublisher` 都是 host 内务，不是 Soul 算法需要的。

### 10.4 Tool 注册与命名空间

Tool 的注册来源分三类：

1. **内置 tool**：compile-time 的静态列表，进程启动时一次性注册
2. **MCP server tool**：运行时由 MCP 客户端动态加载（连接 server 后拿到 tool list）
3. **Plugin tool**：加载期由 plugin 扫描器发现

**命名空间规则**：

| 来源 | 格式 | 示例 |
|---|---|---|
| 内置 | 无前缀 | `Read` / `Write` / `Bash` |
| MCP | `mcp__<serverName>__<toolName>` | `mcp__github__add_comment` |
| Plugin | `plugin__<pluginName>__<toolName>` | `plugin__my_plugin__greet` |

分隔符用 `__`（双下划线）和 cc 一致——server / tool 名自身可能包含单下划线，双下划线能无歧义反向解析来源。

**MCP server name 和 tool name 的 normalization**（决策 #100）：MCP server 的 `serverId` 和 tool name 可能含非法字符（空格、点等），需要规范化为 `[A-Za-z0-9_-]`，但**保留 unicode**（与 CC `recursivelySanitizeUnicode` 对齐）。具体规则在 §17A.2.5 MCP 集成的 `normalizeNameForMCP` 函数定义。规范化后用于 `mcp__<serverId>__<normalizedToolName>`，原始 tool name 在 `McpToolAdapter.metadata.originalName` 字段保留以便 callTool 时还原。

Phase 2 只实现内置 tool 的注册和执行路径。MCP 和 Plugin 的加载机制延后到 Phase 3+（见 §20 Scope）；Phase 1 必做接口预留（决策 #100，详见 §17A）。

### 10.5 ToolRegistry 接口

```typescript
interface ToolRegistry {
  // 获取全部已注册 tool（SoulPlus 的 TurnManager 用这个构造 SoulConfig.tools）
  list(): Tool[];

  // 按名字查找单个 tool（Soul 内部的 findTool 也走这个）
  get(name: string): Tool | undefined;

  // 同步注册（builtin / plugin 启动期用）
  register(tool: Tool): void;

  // ─── 决策 #100 / MCP 集成预留（Phase 1 必做接口预留 + Phase 3 实现）───
  // 异步批量注册 + 命名空间替换（MCP 用）：
  // prefix 形如 "mcp__github__"；atomically 删 prefix 下所有现有 tool 再加新 tools，
  // 避免 100 个 tool 注册产生 100 次事件。Phase 1 实现可串行调 register；Phase 3 优化批量。
  registerBatch(prefix: string, tools: Tool[]): Promise<void>;

  // 单个动态卸载（MCP server 断开时用）
  unregister(name: string): void;
  unregisterByPrefix(prefix: string): void;     // 用于 server 断开时清理整组 tool

  // 监听 tools 变化（SoulPlus 用来发 mcp.tools_changed Wire 事件）
  onChanged: ((change: { added: string[]; removed: string[] }) => void) | null;
}
```

**关键说明**：

- `list()` 返回当前所有已注册的 tool，**不做任何过滤**。过滤是调用方的职责。
- `ToolRegistry` 由 SoulPlus 持有，不放在 `Runtime` 里——决策 #83 明确 `tools` 不通过 Runtime 传。
- SoulPlus 的 TurnManager 在调 `runSoulTurn` 前，根据当前 turn 的上下文决定 `SoulConfig.tools` 到底传哪些 tool 给 Soul：可能是全量，也可能是 subagent 需要的受限子集，也可能根据 TurnOverrides 动态裁剪。
- ToolRegistry 本身不知道 subagent / TurnOverrides / PermissionMode 是什么——这些概念在 TurnManager 层处理，ToolRegistry 只是个命名查询表。
- **`registerBatch` / `unregister*` / `onChanged` 决策 #100 必做**：保留同步 `register` 给 builtin / plugin 启动期使用（可读性最好）；只有 MCP / Plugin 动态加载需要异步路径。MCP server 100 个 tool 用 `registerBatch` 一次性原子替换，避免 100 次事件；server 断开时 `unregisterByPrefix("mcp__github__")` 清理整组。`onChanged` 让 SoulPlus 知道何时该发 `mcp.tools_changed` Wire 事件（决策 #100）。Phase 1 必做接口槽位 + 默认占位实现；Phase 3 接 MCP 时直接填实现，不破坏任何契约。

### 10.6 Tool Result Budget（决策 #96 / Phase 1 必做）

#### 10.6.1 设计目标

防止任何**单条 tool result content** 撑爆下一轮 LLM input。具体策略对齐 cc-remake 的"持久化到磁盘 + preview 替换"路线，弃用 Python 版"truncate 丢弃"路线（kimi-cli Python 1.x MCP Playwright 500KB DOM 输出曾导致 context 直接死）。

这是 §3.5 / 决策 #96 三层防御中的 **L1（Tool Result Budget）**，与 L2（Threshold-based AutoCompact）/ L3（Reactive Overflow Recovery）形成完整防线：

```
L1 (Tool Result Budget)        ← 本节，写入 ContextState 之前的 per-result 持久化
   ↓
L2 (Threshold AutoCompact)     ← Soul while-top safe point 检测（决策 #93），TurnManager.executeCompaction 执行
   ↓
L3 (Reactive Overflow Recovery)← Kosong 抛 ContextOverflowError → TurnManager catch → executeCompaction(reason: "overflow")
```

#### 10.6.2 阈值（Phase 1 默认值，对齐 kimi-cli Python 实战）

| 常量 | 值 | 适用 | 来源 |
|---|---|---|---|
| `DEFAULT_BUILTIN_MAX_RESULT_CHARS` | 50_000 字符 | 内置 tool（Read/Write/Edit/Bash/Grep/Glob/Task/...） | Python `ToolResultBuilder.DEFAULT_MAX_CHARS` |
| `DEFAULT_MCP_MAX_RESULT_CHARS` | 100_000 字符 | MCP wrapper 包裹的第三方 tool（含 base64 媒体的字节计数；text + media 共享预算，决策 #100 / D-MCP-11） | Python `MCP_MAX_OUTPUT_CHARS` |
| `PREVIEW_SIZE_BYTES` | 2_000 字节 | 持久化后保留的 preview 长度 | cc-remake `PREVIEW_SIZE_BYTES` |
| `SINGLE_LINE_MAX_CHARS` | 2_000 字符 | 单行最长截断（防止超长 minified 输出占满 50K 还无法读） | Python `DEFAULT_MAX_LINE_LENGTH` |
| `READ_FILE_MAX_LINES` | 1_000 行 | Read tool 单文件读取行数硬上限 | Python `tools/file/read.py` |
| `READ_FILE_MAX_BYTES` | 100 KB | Read tool 单文件读取字节硬上限 | 同上 |

每个 Tool 通过 `Tool.maxResultSizeChars` 字段**自己声明**单条 result 上限（覆盖默认）。**三种来源的预算梯度**（决策 #96 + #100 协调）：

| 来源 | 默认预算 | 实现路径 |
|---|---|---|
| **内置 tool**（builtin） | `DEFAULT_BUILTIN_MAX_RESULT_CHARS = 50K` | 不声明 → fallback 到 50K；Read 工具构造时传 `Infinity`（已自带 maxLines / maxBytes） |
| **MCP wrapper** | `DEFAULT_MCP_MAX_RESULT_CHARS = 100K`（独立预算） | `McpToolAdapter` 构造时统一传 `maxResultSizeChars: 100K`；用户可在 `McpServerConfig.toolMaxOutputChars` 里 per-server 覆盖（决策 #100 / D-MCP-11） |
| **第三方 plugin tool** | tool 自定义（推荐 50K） | plugin 作者根据 tool 性质显式声明；不声明走默认 50K |
| **特殊覆盖** | `Infinity` | 永远不持久化（适合内部已自我裁剪的 tool，如 Read） |

**MCP 100K 独立预算的理由**（吸取 Python 教训）：MCP server 经常返回多模态结果（text + image / audio），单一 50K 预算对图片场景不够（一张 base64 截图 ~50KB）；100K 让 text + media 共享更宽预算。Python 1.x kimi-cli MCP Playwright 500KB DOM 输出曾导致 context 直接死的教训：v2 走 cc-remake "持久化 + preview" 路线（不 truncate 丢弃，存到磁盘 LLM 可 Read 重读），不是 Python 的 truncate 路线。

> **Phase 2 可选层**：跨 message 累加预算（cc 的 `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS=200K`）—— Phase 1 单条 50K 已经隐式控制 5 个并行 tool 累加上限 ≤ 250K，多数场景够用，跨 message 优化推迟到生产数据指明需要时再做。

#### 10.6.3 持久化路径与 preview 格式

```
$KIMI_HOME/sessions/<session_id>/tool-results/<tool_use_id>.{txt,json}
```

写入策略：
- 文件名按 `tool_use_id` 命名（确定性、跨 turn 复用、prompt cache 友好——同一 tool_use_id 的 content 永远一致才能命中 cache）
- 写入用 `flag: 'wx'`：已存在就跳过（防止 microcompact 重放时重复写）
- 替换内容形如：

```
<persisted-output>
Output too large (1.2 MB). Full output saved to: /home/user/.kimi/sessions/sess_abc/tool-results/tool_xyz.txt

Preview (first 2 KB):
{...前 2000 字节原文...}
</persisted-output>
```

LLM 看到 preview 后可以"按需"用 Read 工具重新读取磁盘上的完整文件，但默认对话只看 preview——既保留可达性又不撑爆 context。

#### 10.6.4 执行位置：ToolCallOrchestrator（不在 Soul、不在 Tool）

```typescript
// ToolCallOrchestrator 内部（伪代码）
async runAfterToolCall(toolCall, args, result, context) {
  // 1. afterToolCall hook（已有的 PostToolUse / 用户 hook 链）
  if (config.afterToolCall) {
    const after = await config.afterToolCall({...});
    if (after?.resultOverride !== undefined) result = after.resultOverride;
  }

  // 2. 决策 #96 新增：Tool Result Budget enforcement
  const tool = findTool(config.tools, toolCall.name);
  const sizeLimit = tool.maxResultSizeChars ?? DEFAULT_BUILTIN_MAX_RESULT_CHARS;
  result = await maybePersistAndReplace(result, toolCall.id, sizeLimit, this.sessionDir);

  // 3. 写入 ContextState（这一步之前 result 已经在预算内）
  await context.appendToolResult(toolCall.id, result);
}
```

**为什么放 ToolCallOrchestrator 而不是 Soul**：
- Soul 是无状态函数 + import whitelist（铁律 1 / 3），不能碰 `fs.writeFile` / 持久化文件名
- ToolCallOrchestrator 已经在 SoulPlus 内部，能拿到 sessionDir / PathConfig
- `afterToolCall` 阶段是"写入 ContextState 之前"的最后一道关卡，正好做"过大就截"的拦截

**为什么不在 Tool 自己里**：
- Tool 接口要保持 narrow（§10.2 / 决策 #80）
- 单 tool 自我裁剪只能看自己的 result，无法做"per-message 累加"判断（Phase 2 扩展点）
- Phase 2 加 per-session budget（cc 的 `state.seenIds`）时逻辑必须在编排层

#### 10.6.5 Phase 1 简化范围（vs cc-remake 完整版）

| 能力 | Phase 1 | cc-remake |
|---|---|---|
| 单 result 持久化 | ✅ | ✅ |
| `<persisted-output>` preview 替换 | ✅ | ✅ |
| Tool 自声明阈值 | ✅（`maxResultSizeChars`） | ✅（更复杂的 per-tool 配置） |
| 跨 turn replacement state | ⏭️（用 `tool_use_id` 文件名 + `wx` flag 替代） | ✅（`state.seenIds` / `state.replacements`） |
| Per-message 累加预算 | ⏭️（Phase 2） | ✅ |
| Resume 时重建 state | ⏭️（filename 是确定性的，不需要） | ✅ |

#### 10.6.6 与 §10.2 Tool 接口的关系

新增字段 `Tool.maxResultSizeChars?: number` 已写入 §10.2。MCP wrapper（§17A.2.5 `McpToolAdapter`，`mcp__*` 命名空间）在注册第三方 MCP tool 时统一构造时传 `maxResultSizeChars: DEFAULT_MCP_MAX_RESULT_CHARS`（100K），区分 builtin（50K 默认）。Read 工具构造时传 `maxResultSizeChars: Infinity`（自带 maxLines / maxBytes）。

### 10.7 Tool UI 渲染契约（决策 #98 / Phase 1 必做）

#### 10.7.1 设计目标

每个 client（TUI / Web / Python SDK / IDE 集成 / 第三方 plugin）都需要为 tool 调用渲染富 UI。如果 Core 不提供这层契约，每个 client 都得 hardcode 知道每个 tool 的 args / output 字段名——换 tool 名（Bash → Shell）或者改 args 字段（command → cmd）就要改所有 client。

v2 当前设计有三个具体缺口：

- v2 §3.6.1 `tool.call.description` 注释里说"由 Tool 实现层的 `getActivityDescription()` 生成"——但 Tool 接口里**没有这个方法**，是悬空字段
- §10.2 Tool 接口收敛到极简四件套后，所有 UI 渲染钩子被一起踢掉了
- Plugin / MCP tool 没有 display 协议，replay 时 plugin 进程已经消失，UI 还原不出来

→ Phase 1 必须在接口层把"显示什么 / 怎么显示"的契约一次定到位，否则 Phase 2 加是 breaking change。

#### 10.7.2 设计原则

1. **不绑定 UI 框架**——Tool 接口只产出**结构化数据**（discriminated union），不返回 React / pi-tui / Lit 组件
2. **开放可扩展 + fallback 不丢信息**——未识别 kind 走 `generic`（detail 字段塞任意 JSON），借鉴 kimi-cli Python `UnknownDisplayBlock` 模式
3. **支持渐进增强**——所有 display 字段全 optional；简单 tool 用默认 fallback，复杂 tool 提供专属 hint
4. **跨 client 一致性**——同一份 hint 让 TUI / Web / ACP / IDE / Python SDK 都能合理渲染
5. **Replay 友好**——display 数据进 wire.jsonl，plugin / MCP 进程崩溃后 client 重连仍能还原 UI（这是"Wire First"的天然延伸）
6. **复用 Python 经验**——TS 版的 `ToolInputDisplay` / `ToolResultDisplay` 命名 / 字段尽量对齐 Python `DisplayBlock` 子类（DiffDisplayBlock / TodoDisplayBlock / ShellDisplayBlock / BackgroundTaskDisplayBlock 等），方便 Python SDK 跨语言一致
7. **复用已有 ApprovalDisplay**——`ApprovalDisplay` 收编为 `ToolInputDisplay` 的子集（同源同构），见 §12.2

#### 10.7.3 ToolInputDisplay / ToolResultDisplay union 完整定义

`ToolInputDisplay` 是"调用前展示给用户审批 + 调用时展示在 transcript"的共享 hint（决策 #98 / D2 → 核心 kind 具名 + 长尾 generic）：

```typescript
export type ToolInputDisplay =
  | { kind: "command";       command: string; cwd?: string; description?: string }
  | { kind: "file_io";       operation: "read" | "write" | "edit"; path: string;
                             range?: { start: number; end: number } }
  | { kind: "diff";          path: string; before: string; after: string }   // EditTool / WriteTool 由 SoulPlus 算（D4）
  | { kind: "search";        query: string; scope?: string; flags?: string[] }
  | { kind: "url_fetch";     url: string; method?: string }
  | { kind: "agent_call";    agent_name: string; prompt: string; tags?: string[] }
  | { kind: "skill_call";    skill_name: string; arguments?: string }
  | { kind: "todo_list";     items: Array<{ title: string; status: "pending" | "in_progress" | "done" }> }  // 对齐 Python TodoDisplayBlock
  | { kind: "background_task"; task_id: string; kind: string; status: string; description: string }         // 对齐 Python BackgroundTaskDisplayBlock
  | { kind: "task_stop";     task_id: string; task_description: string }
  | { kind: "generic";       summary: string; detail?: unknown };
```

`ToolResultDisplay` 是"执行结果在 transcript 上展示的 hint"（决策 #98）：

```typescript
export type ToolResultDisplay =
  | { kind: "command_output";  stdout: string; stderr?: string; exit_code: number;
                               truncated?: boolean }
  | { kind: "file_content";    path: string; content: string;
                               range?: { start: number; end: number };
                               truncated?: boolean }
  | { kind: "diff";            path: string; before: string; after: string;
                               hunks?: Array<{ old_start: number; new_start: number;
                                               old_lines: number; new_lines: number }> }
  | { kind: "search_results";  query: string;
                               matches: Array<{ file: string; line: number; text: string;
                                                context_before?: string[]; context_after?: string[] }>;
                               truncated?: boolean }
  | { kind: "url_content";     url: string; status: number; content_type?: string;
                               preview: string; truncated?: boolean }
  | { kind: "agent_summary";   agent_name: string; steps: number;
                               token_usage?: { input: number; output: number };
                               final_message?: string }
  | { kind: "background_task"; task_id: string; status: string; description: string }
  | { kind: "todo_list";       items: Array<{ title: string; status: "pending" | "in_progress" | "done" }> }
  | { kind: "structured";      data: unknown; schema_hint?: string }
  | { kind: "text";            text: string; truncated?: boolean }
  | { kind: "error";           message: string; recoverable?: boolean }
  | { kind: "generic";         summary: string; detail?: unknown };
```

**关于 kind 数量的取舍**（决策 #98 / D1）：~10 个常用 kind + `generic` 兜底。**严格控制 kind 增长**——加新 kind 必须有 ≥3 个 tool 共享该 kind 才考虑。

**关于 `todo_list` / `background_task` 的保留**：复用 kimi-cli Python 已生产验证的 DisplayBlock 子类（`TodoDisplayBlock` / `BackgroundTaskDisplayBlock`），Python SDK 可直接对应渲染。

#### 10.7.4 默认 fallback 实现

ToolCallOrchestrator / SoulPlus 内部提供一组 fallback，导出为公开 API（决策 #98 / D9——plugin 作者可 `import { defaultGetInputDisplay } from "@kimi-core/tool-display-defaults"` 做轻量定制）：

```typescript
// 默认实现永远不抛错、永远返回合理 fallback。Tool 提供 display.* 时优先用 tool 的；没有时走 fallback。

function defaultGetUserFacingName(tool: Tool, _input: unknown): string {
  return tool.name;
}

function defaultGetActivityDescription(tool: Tool, input: unknown): string {
  return `${tool.name}(${truncate(JSON.stringify(input), 80)})`;
}

function defaultGetInputDisplay(tool: Tool, input: unknown): ToolInputDisplay {
  return { kind: "generic", summary: tool.name, detail: input };
}

function defaultGetResultDisplay(_tool: Tool, result: ToolResult): ToolResultDisplay {
  if (result.isError) {
    const errMsg = typeof result.content === "string"
      ? result.content
      : result.content.map(c => c.type === "text" ? c.text : "").join("");
    return { kind: "error", message: errMsg.slice(0, 500) };
  }
  const text = typeof result.content === "string"
    ? result.content
    : result.content.map(c => c.type === "text" ? c.text : "").join("");
  return { kind: "text", text: text.slice(0, 500), truncated: text.length > 500 };
}

function defaultGetCollapsedSummary(tool: Tool, input: unknown, result: ToolResult): string {
  return defaultGetActivityDescription(tool, input);
}
```

#### 10.7.5 谁负责调用 display.* / 落盘策略

display.* 的调用全部发生在 **`ToolCallOrchestrator`** 内（不在 Soul、不在 Tool execute）：

| display 字段 | 调用时机 | Wire 事件 / 落盘 |
|---|---|---|
| `getUserFacingName(input)` | approval/display 阶段（emit tool.call 之前） | `tool.call.user_facing_name` 进 wire.jsonl（`tool_call_dispatched`） |
| `getActivityDescription(input)` | 同上 | `tool.call.description` 进 wire.jsonl |
| `getInputDisplay(input)` | 同上；同时作为 `ApprovalRequest.display` 走 approval 路径（§12.2） | `tool.call.input_display` 进 wire.jsonl |
| `getProgressDescription(input, update)` | tool.execute 的 `onUpdate` 回调路径 | `tool.progress.progress_description` **不落盘**（铁律 5） |
| `getResultDisplay(input, result)` | execute 返回后、emit tool.result 之前 | `tool.result.result_display` 进 wire.jsonl |
| `getCollapsedSummary(input, result)` | 同上 | `tool.result.collapsed_summary` 进 wire.jsonl |

**关键设计**：display 字段落盘是**保留 UI 信息的关键**——崩溃后 plugin 进程消失，但 wire.jsonl 里仍然有完整的 `input_display` / `result_display`，client 重连时能 replay 渲染。

伪代码（在 `ToolCallOrchestrator` 内）：

```typescript
// approval/display 阶段
const userFacingName = tool.display?.getUserFacingName?.(args)
                       ?? defaultGetUserFacingName(tool, args);
const activityDesc = tool.display?.getActivityDescription?.(args)
                     ?? defaultGetActivityDescription(tool, args);
const inputDisplay = tool.display?.getInputDisplay?.(args)
                     ?? defaultGetInputDisplay(tool, args);

// EditTool / WriteTool 的 diff 升级（D4）：tool 自己声明 file_io 占位，
// orchestrator 在 emit tool.call 之前升级为 diff 并填 before/after，复用一份给 approval 和 result
const enrichedDisplay = await this.enrichDisplayHintWithDiff(tool, args, inputDisplay);

sink.emit({
  type: "tool.call",
  id: toolCall.id,
  name: tool.name,
  args,
  description: activityDesc,
  user_facing_name: userFacingName,
  input_display: enrichedDisplay,
});
sessionJournal.appendToolCallDispatched({
  ...,
  activity_description: activityDesc,
  user_facing_name: userFacingName,
  input_display: enrichedDisplay,
});

// 如果 permission === "ask"，把 enrichedDisplay 作为 ApprovalRequest.display 发起 approval
// （§12.2 ApprovalDisplay 已收编为 ToolInputDisplay 的别名）

// execute 阶段 — Soul 内调 tool.execute，onUpdate 回调内 orchestrator 计算 progress_description
const result = await tool.execute(toolCall.id, args, signal, (update) => {
  const progDesc = tool.display?.getProgressDescription?.(args, update);
  sink.emit({
    type: "tool.progress",
    tool_call_id: toolCall.id,
    update,
    progress_description: progDesc,
  });
});

// emit tool.result 之前
const resultDisplay = tool.display?.getResultDisplay?.(args, result)
                      ?? defaultGetResultDisplay(tool, result);
const collapsedSummary = tool.display?.getCollapsedSummary?.(args, result)
                         ?? defaultGetCollapsedSummary(tool, args, result);

sink.emit({
  type: "tool.result",
  tool_call_id: toolCall.id,
  output: result.output,
  is_error: result.isError,
  result_display: resultDisplay,
  collapsed_summary: collapsedSummary,
});
```

**注意**：tool 自身的 `execute` 方法**不直接 emit Wire 事件**——这是 §10.2 的窄接口铁律。display 字段计算和事件 emit 都由 SoulPlus 完成，tool 只产出"原始材料"（input、result）让 SoulPlus 调 display.* 提取 hint。

#### 10.7.6 EditTool / WriteTool 的 diff 由 SoulPlus 算（D4）

EditTool / WriteTool 的 diff 内容由 **`ToolCallOrchestrator` 在 approval/display 阶段统一计算并填充**——理由是 §11.8 已经明确"pre-check 允许做重活"，diff 是 approval 必需，复用一份给 transcript 渲染。

具体流程：

1. EditTool 的 `getInputDisplay(args)` 返回 `{ kind: "file_io", operation: "edit", path }` **占位**
2. ToolCallOrchestrator 检测到 `kind === "file_io"` 且 `operation === "edit" | "write"`，读文件算 diff
3. 升级为 `{ kind: "diff", path, before, after }`，作为 `tool.call.input_display` emit
4. 同一份 diff 复用给 `ApprovalRequest.display`（如果触发了 approval）
5. tool.execute 完成后，orchestrator 在 emit tool.result 时把 diff 也填进 `result_display`（不让 tool 自己重新算）

这样 tool 自身保持简洁，diff 计算只发生一次。

**diff 算法库选型**：Phase 1 默认采用 [`diff` npm package](https://www.npmjs.com/package/diff)（unified diff 格式，社区成熟、API 简洁、零依赖）；如需更精细的 patch 输出（字符级 diff、Levenshtein 距离），Phase 2 可切换 `diff-match-patch`（Google 系，体量更大但语义更精）。Phase 1 不预先抽 diff 接口，等 Phase 2 真有需求再抽。

#### 10.7.7 ApprovalDisplay 收编为 ToolInputDisplay（§12.2 整合）

v2 现有 `ApprovalDisplay`（§12.2）和新 `ToolInputDisplay` 本质是同一种东西：**"展示给用户的 tool 调用前快照"**。决策 #98 把 `ApprovalDisplay` **重命名 / 收编为 `ToolInputDisplay`**，保留 `ApprovalDisplay` 作为类型别名兼容旧引用：

```typescript
// 附录 D
export type ToolInputDisplay = ... ;             // 见 §10.7.3
export type ApprovalDisplay = ToolInputDisplay;  // alias，§12.2 既有引用不破坏
```

这样：
- 一份 hint 两处用，**减少 tool 实现负担**（getInputDisplay 同时喂给 approval 和 transcript）
- ApprovalDisplaySchema 在附录 B 已经存在，扩展为更完整 union 即可
- 新增 kind（`search` / `url_fetch` / `agent_call` 等）也可以走 approval（如果未来需要 approval 这些操作）

#### 10.7.8 第三方 Plugin Tool / MCP Tool 的支持

**Plugin Tool**（同进程或子进程）：
- 同进程 plugin：直接实现 `Tool.display`，和内置 tool 完全一致
- 子进程 plugin：plugin 进程内部维护 display 实现；通过 plugin protocol 把 hint 数据传给 SoulPlus；SoulPlus emit 到 Wire / 落 wire.jsonl
- 关键：display 数据**通过 Wire 事件传递并落盘**，**不依赖 plugin 进程**——崩溃 / 断连重连不影响 replay

**MCP Tool**（Phase 3 才完整接入，详见 §17A MCP 集成）：
- MCP 协议自身不携带 display hint
- v2 的 McpToolAdapter 给 `display` 字段填一组**保守 fallback**（kind: "generic"）
- 未来如果 MCP 协议扩展（例如 `_meta` 字段），适配层升级映射

#### 10.7.9 不支持 Component 返回（D6）

Tool 接口**绝不返回 framework-specific 类型**（React.ReactNode / pi-tui Component / lit TemplateResult）。理由：
- 跨 client 不可移植（TUI 用 Box，Web 用 lit，Python SDK 完全无法解析）
- 强行支持就要把 React / pi-tui 拉进 Core 依赖，污染 import boundary
- 真正复杂的渲染（如 todo 列表实时勾选 UI）让对应 client 内部实现专属 renderer——Tool 只声明 `kind: "todo_list"`，client 自己决定怎么渲染

如果某个 tool 真的需要专属 UI，正确路径是：
1. tool 声明 `getInputDisplay` 返回 `{ kind: "todo_list", items: [...] }`
2. client 端实现 `kind === "todo_list"` 的专属渲染器
3. 未识别的 client 自动 fallback 到 generic（不丢信息）

#### 10.7.10 Phase 1 vs Phase 2

| 项 | Phase 1 | Phase 2+ |
|---|---|---|
| Tool 接口 `display?: ToolDisplayHooks` 字段 | ✅ 必做 | — |
| `ToolInputDisplay` / `ToolResultDisplay` union 定义 | ✅ 必做 | 按需扩 kind（≥3 tool 共享） |
| Wire 事件字段扩展 | ✅ 必做 | — |
| 附录 B WireRecord schema 扩展（落盘） | ✅ 必做 | — |
| ToolCallOrchestrator 调用 display 方法的逻辑 | ✅ 必做 | — |
| 默认 fallback 实现 | ✅ 必做（导出公开 API） | — |
| `ApprovalDisplay` 收编为 `ToolInputDisplay` alias | ✅ 必做 | — |
| 所有内置 tool 实现完整 display | ⏭️ 部分 tool 演示通路（Bash / Read / Edit），其余 tool 走 fallback | 全部补齐 |
| MCP tool 适配层 display | ⏭️ generic fallback | Phase 3 完整接入时升级 |
| Plugin tool display 协议 | ⏭️ Phase 1 不实现 plugin | Phase 3 |
| i18n 支持 | ⏭️ 接口预留 | Phase 3+ |
| `renderGroupedToolUse` 等价物 | ⏭️ Client 自实现（按 kind 聚合） | — |

### 10.8 Tool Search 延后决定

Phase 2 **不实现** ToolSearch（按需懒加载 tool 定义的机制）。触发条件设定为：

- MCP + plugin tool 的总数 > 30，**或**
- tool 定义占 LLM context 预算 > 10%

满足上述任一条件时引入 ToolSearch 机制（类似本对话里看到的 ToolSearch + deferred tool 模式）。Phase 2 的内置 tool 总数远低于阈值，全量暴露即可。决策记录在 §21 保留位置。

### 10.9 和旧设计的差异（diff）

相对 Phase 1 之前（§4.5 / §10 旧版）的 Tool 接口的变化：

| 项 | 旧设计 | 新设计 | 原因 |
|---|---|---|---|
| `checkPermissions` 方法 | 有 | 删除 | 权限由 `beforeToolCall` 处理 |
| `selfCheck` 方法 | 有 | 删除 | 同上 |
| `validateInput` 方法 | 有 | 删除 | 由 `inputSchema` 统一校验 |
| `canUseTool` 参数 | 有 | 删除 | Soul 对 approval 无感知 |
| `onUpdate` 回调 | 无 | 新增 | 支持流式进度更新 |
| 依赖传递 | `execute(input, ctx, signal)` | constructor 注入 | 避免 ctx 垃圾桶 |
| 输入校验 | JSONSchema + 手写 | zod | 类型安全 + 少样板 |
| `description` | 可能是函数 | 静态字段 | 避免 prompt 副作用 |

---

## 十一、Permission 系统（规则存储 + 消费）

### 11.1 定位与职责重新界定

Permission 系统**不在** Soul 里。Soul 零 permission 词汇，既不导入权限类型，也不直接调用任何权限函数。Soul 对 permission 的唯一接触点是 `SoulConfig.beforeToolCall` —— 一个由调用方传入的 callback 参数，Soul 不知道这个 callback 内部是什么，只负责在合适的时机 await 它并按返回值行事（见 §5.1/§6.1/§10）。

Permission 系统的代码全部住在 **SoulPlus 内部**。它的职责收窄为三件事：

1. **规则存储**：定义 PermissionRule 的 schema，以及规则文件（`settings.json` 等）在磁盘上的布局
2. **规则加载与合并**：在 SoulPlus 启动时从多个来源加载规则、按优先级合并，turn 级 overrides 在调用 `runSoulTurn` 之前动态叠加
3. **规则消费**：把当前生效的规则集 **baked** 进一个 `beforeToolCall` 闭包里，再把这个闭包作为 `SoulConfig.beforeToolCall` 透传给 Soul

**服务层归属**（D10 + D18）：第 3 步的 "baked 进闭包" 发生在 **`ToolCallOrchestrator`**（SoulPlus 服务层节点）里，不是 TurnManager。TurnManager 只是把 `fullOverrides` / `sessionRules` / `approvalSource` 三个参数喂给 `orchestrator.buildBeforeToolCall(...)`，拿回 callback 后透传给 `runSoulTurn`。参数 schema 校验（`zod.safeParse`）不在 orchestrator 阶段，永久留在 Soul 内作为 tool 输入完整性的内生职责。详见 §11.7 / §13.8。

原 v2 文档里的"Soul 内 7 层权限检查链"设计在本轮彻底删除。那套设计把权限检查散布在 Soul 和 Tool 双方（`tool.checkPermissions()`、`Runtime.permissionChecker` 等），违反 Soul 无状态函数边界（铁律 1）和零 permission 词汇约束（铁律 2），也和方案 Z 的"单一 gate"纪律冲突。现在只有 `beforeToolCall` **唯一** 一个 approval gate。

相应地：
- **Tool 接口不含 `checkPermissions` / `selfCheck` / `validateInput` / `canUseTool`**（Phase 2 在 §10 已经删掉，本节明确 cross-reference）
- **Runtime 接口不含 `permissionChecker` 字段**（Phase 2 在 §6.12 已经明确，本节明确 cross-reference）
- 旧的 `SoulRegistry.createSoul` 里给每个 Soul 注入独立 PermissionChecker 的代码同步作废——现在 Soul 只接收一个 `beforeToolCall` 闭包，"per-Soul 隔离"退化为"每个 runSoulTurn 拿到自己的闭包"，因为闭包本身就是值，不存在共享状态

### 11.2 PermissionMode（3 种）

PermissionMode 是 SoulPlus 面向用户的顶层开关，控制 SoulPlus 在构造 `beforeToolCall` 闭包时的总体策略：

| Mode | 行为 | 等价 cc 模式 |
|------|------|-------------|
| `default` | 危险操作需用户确认，deny 规则生效 | cc 的 default |
| `auto` | ask 降级为 allow（不弹窗），deny 仍生效 | cc 的 dontAsk |
| `bypass` | 只有 deny 能拦截，其他全放开 | cc 的 bypassPermissions |

PermissionMode 由 SoulPlus 在构造闭包时读取，Soul 对此无感知。

### 11.3 规则存储格式

```typescript
// 权限规则
type PermissionRule = {
  id: string;               // 规则唯一 ID（调试用）
  behavior: "allow" | "deny" | "ask";
  matcher: RuleMatcher;     // 匹配哪些 tool call
  scope: RuleScope;         // 规则来源
  reason?: string;          // 给用户看的说明
};

// RuleMatcher：完整定义见 §11.3.1（含 fieldMatcher 字段级匹配）
// 字段概览：toolName（string | RegExp）+ fieldMatcher?（{ field, pattern }）

type RuleScope =
  | { kind: "builtin" }
  | { kind: "user" }
  | { kind: "project" }
  | { kind: "plugin"; pluginName: string }
  | { kind: "turn-override" };  // 来自 TurnOverrides 的动态规则
```

**字符串 DSL**（磁盘/配置文件层）：保留 cc 风格的 `ToolName(content_glob)` 语法，在加载阶段解析为 `PermissionRule`：

```
"Bash"                  → 匹配所有 Bash 调用
"Bash(git *)"           → 匹配 git 开头的 Bash 命令
"Edit(/src/*)"          → 匹配 /src/ 下的文件编辑
"mcp__github__*"        → 匹配 github MCP server 的所有工具
"*"                     → 匹配所有工具
```

这层 DSL 是磁盘格式/用户友好层，内部统一走 `PermissionRule` 结构。

#### 11.3.1 DSL 语法与匹配语义

本节补齐 §11.3 的 DSL 形式定义、`matchesRule` 纯函数的完整语义、以及 Phase 1 每个内置 tool 的匹配字段约定。

**Glob 语法**(对齐 minimatch,与 cc / cc-remake 的 bash permission DSL 语法一致):

| 符号 | 含义 | 示例 |
|------|------|------|
| `*` | 匹配**单段**内的任意字符(不跨 `/`) | `src/*.ts` 不匹配 `src/a/b.ts` |
| `**` | 匹配**跨段**的任意路径,含 0 段 | `src/**/*.ts` 匹配 `src/a/b/c.ts` |
| `?` | 匹配单个字符 | `file?.txt` 匹配 `file1.txt` |
| `[abc]` | 字符组 | `v[0-9].txt` |
| `!` | 否定前缀(仅用于 pattern 开头) | `!src/**` 表示"除 src 外" |
| `{a,b}` | brace 展开(可选,Phase 2) | `*.{ts,tsx}` |

否定模式(`!prefix`)只在规则本身的 pattern 前面出现一次,不支持嵌套否定。多个否定模式等价于多条独立规则。

**Tool-specific 匹配字段约定**:规则对 tool call 做匹配时,`fieldMatcher.field` 指定从 `args` 里取哪个字段来比对。Phase 1 的约定如下:

| Tool | 匹配字段 | 字段类型 | 示例 DSL |
|------|----------|----------|----------|
| `Bash` | `args.command` | string | `Bash(git *)` |
| `Read` | `args.path` | string | `Read(./src/**)` |
| `Write` | `args.path` | string | `Write(/tmp/**)` |
| `Edit` | `args.path` | string | `Edit(!./src/**)`(否定) |
| `Grep` | `args.pattern` | string(较少用) | `Grep(*)` |
| `Glob` | `args.pattern` | string | `Glob(**/*.env)` |
| `Task` | `args.subagent_type` | string | `Task(review-*)` |
| `Skill`（决策 #99） | `args.skill` | string | `Skill(commit)` / `Skill(review-*)` |
| MCP tool(`mcp__*__*`) | `toolCall.name` | string | `mcp__github__*` |
| Plugin tool(`plugin__*__*`) | `toolCall.name` | string | `plugin__foo__*` |

对于没有字段级匹配的情况(例如 "Bash" 只写 tool 名字),`fieldMatcher` 为空,退化为"tool name 匹配即命中"。

**字段级 matcher 数据结构**:

```typescript
interface RuleMatcher {
  toolName: string | RegExp;                     // "Bash" / /^mcp__github__.*/ / "*"
  fieldMatcher?: {
    field: string;                                // "args.command" / "args.path" / "toolCall.name"
    pattern: string | RegExp;                     // glob 或显式正则
  };
}
```

`toolName === "*"` 表示匹配所有 tool;`fieldMatcher` 缺省表示"只看 toolName"。字符串 pattern 经 `globToRegex()` 编译;`RegExp` 实例直接使用。

**每个 Phase 1 内置 tool 的匹配样例**:

| DSL | 匹配语义 | 展开后的 RuleMatcher |
|-----|----------|----------------------|
| `Bash(git *)` | 所有以 `git ` 开头的 Bash 命令 | `{toolName: "Bash", fieldMatcher: {field: "args.command", pattern: "git *"}}` |
| `Bash(!rm *)` | 禁止任何 `rm` 开头的命令 | `{toolName: "Bash", fieldMatcher: {field: "args.command", pattern: "!rm *"}}` + `behavior: "deny"` |
| `Read(./src/**)` | 只允许读 `./src/` 下的文件 | `{toolName: "Read", fieldMatcher: {field: "args.path", pattern: "./src/**"}}` |
| `Edit(!./src/**)` | 禁止编辑 src 以外的文件 | `{toolName: "Edit", fieldMatcher: {field: "args.path", pattern: "!./src/**"}}` + `behavior: "deny"` |
| `Grep` | 所有 Grep 调用 | `{toolName: "Grep"}` |
| `Glob(**/*.env)` | 禁止 glob 搜索 .env | `{toolName: "Glob", fieldMatcher: {field: "args.pattern", pattern: "**/*.env"}}` + `behavior: "deny"` |
| `Task(review-*)` | 只允许调用 review-* 类 subagent | `{toolName: "Task", fieldMatcher: {field: "args.subagent_type", pattern: "review-*"}}` |
| `Skill(commit)` | 允许 SkillTool 调 commit skill（决策 #99） | `{toolName: "Skill", fieldMatcher: {field: "args.skill", pattern: "commit"}}` |
| `Skill(review-*)` | 允许 review-* 前缀的 skill | `{toolName: "Skill", fieldMatcher: {field: "args.skill", pattern: "review-*"}}` |
| `Skill` | 允许所有 skill（用于 skill `safe: true` 的 turn-override allow rule） | `{toolName: "Skill"}` |
| `mcp__github__*` | 匹配 github MCP server 所有工具 | `{toolName: /^mcp__github__.*/}` |
| `*` | 所有 tool | `{toolName: "*"}` |

**`matchesRule` 纯函数语义**:`matchesRule` 是 §11.5 决策链里反复调用的核心函数,必须是**纯函数**(无副作用、可确定性、可单测)。它不调文件系统、不调用户、不抛异常,只返回布尔:

```typescript
// 对齐 §11.5 checkRules 调用方的签名
function matchesRule(
  matcher: RuleMatcher,
  toolCall: ToolCall,
  args: unknown,
): boolean {
  // 1. toolName 匹配
  if (matcher.toolName instanceof RegExp) {
    if (!matcher.toolName.test(toolCall.name)) return false;
  } else if (matcher.toolName !== "*") {
    if (toolCall.name !== matcher.toolName) return false;
  }

  // 2. 如果没有字段级匹配,到此命中
  if (!matcher.fieldMatcher) return true;

  // 3. 取出目标字段值
  const fieldValue = resolveField(matcher.fieldMatcher.field, { toolCall, args });
  if (typeof fieldValue !== "string") return false;  // 非字符串字段不命中

  // 4. 字段值 vs pattern
  const pattern = matcher.fieldMatcher.pattern;
  if (pattern instanceof RegExp) return pattern.test(fieldValue);

  // 5. 字符串 pattern —— 处理否定前缀 + glob 编译
  const negated = pattern.startsWith("!");
  const positivePattern = negated ? pattern.slice(1) : pattern;
  const regex = globToRegex(positivePattern);
  const hit = regex.test(fieldValue);
  return negated ? !hit : hit;
}

// 辅助:从 { toolCall, args } 里按点分路径取字段
function resolveField(path: string, ctx: { toolCall: ToolCall; args: unknown }): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// 辅助:glob 字符串 → RegExp(支持 * / ** / ? / [abc])
declare function globToRegex(pattern: string): RegExp;
```

**纯函数保证**:`matchesRule` 不依赖任何外部状态——所有输入都从参数来,没有对 `this`、全局变量、IO 的依赖。这让 `checkRules` 整体在 §11.5 的决策链中可以被安全地缓存或并行调用,且单元测试可以用几十行 table-driven test 覆盖全部边界。

### 11.4 规则加载与合并

规则来源（优先级从低到高）：

```
1. builtin       ← 代码里写死的默认规则
2. plugin        ← 插件声明的规则
3. user          ← $KIMI_HOME/settings.json（全局用户策略）
4. project       ← <project>/.kimi/settings.json（项目特定策略）
5. turn-override ← TurnOverrides 临时注入的规则（只在当前 turn 有效）
```

**合并策略**：后者覆盖前者。具体语义是"同优先级内按列表顺序，跨优先级按 scope 优先级"。最终得到一个线性 `PermissionRule[]`，按 §11.5 的决策链消费。

**Phase 1 范围**：只实现 `builtin + user + turn-override` 三层，`plugin` / `project` 层留接口、不开路径扫描。未来可在链首插入 `enterprise` 层（组织级策略）。

**加载时机**：
- `builtin / plugin / user / project` 在 SoulPlus 启动时一次性加载，形成 `sessionRules`
- `turn-override` 每个 turn 由 TurnManager 动态构造，和 `sessionRules` 合并后 baked 进 `beforeToolCall` 闭包

### 11.5 规则匹配的决策链

规则怎么对一个 tool call 做 allow/deny/ask 决策——**这个逻辑住在 SoulPlus 的 permission service 里，不是 Soul**：

```typescript
// 位于 SoulPlus 内部
function checkRules(
  toolCall: ToolCall,
  args: unknown,
  rules: PermissionRule[],
): "allow" | "deny" | "ask" {
  // 优先级：deny > ask > allow > default
  for (const rule of rules) {
    if (matchesRule(rule.matcher, toolCall, args)) {
      if (rule.behavior === "deny") return "deny";
    }
  }
  for (const rule of rules) {
    if (matchesRule(rule.matcher, toolCall, args)) {
      if (rule.behavior === "ask") return "ask";
    }
  }
  for (const rule of rules) {
    if (matchesRule(rule.matcher, toolCall, args)) {
      if (rule.behavior === "allow") return "allow";
    }
  }
  return "ask";  // 默认需要确认
}
```

**deny > ask > allow > default**：deny 永远不可绕过，ask 优先于 allow，默认是 ask（`auto` 模式降级为 allow，`bypass` 模式直接放行非 deny）。

### 11.6 TurnOverrides 一分为二

TurnOverrides 里既有"LLM 可见性"字段（Soul 需要看到），也有"权限字段"（只有 SoulPlus 该看到）。Phase 1 把它一分为二：

```typescript
// Full version：TurnManager / SkillManager 内部用
interface FullTurnOverrides {
  model?: string;
  effort?: string;
  activeTools?: string[];      // LLM visibility filter (for Soul)
                                // 同时也自动变成 allow rule (for permission)
  disallowedTools?: string[];  // deny rule (permission only)
  // 未来可能还有：policy overrides、timeout overrides 等
}

// Soul version：Soul 看到的窄版本
interface SoulTurnOverrides {
  model?: string;
  effort?: string;
  activeTools?: string[];  // 仅用于 LLM visibility filter
}
```

**TurnManager 的职责**（呼应 §6.1 的修改）：在调 `runSoulTurn` 之前，把 `FullTurnOverrides` 拆开：

1. `{model, effort, activeTools}` 以 `SoulTurnOverrides` 形式传给 Soul
2. `{activeTools, disallowedTools}` 转换为**临时 permission rules**（`scope: "turn-override"`），注入到当前 turn 的规则集
3. 用注入了 turn-override 规则的规则集构造 `beforeToolCall` 闭包
4. 把闭包作为 `SoulConfig.beforeToolCall` 传给 Soul

**双层防御**：Soul 看到的 `overrides.activeTools` 做第一层保护——"不告诉 LLM 有这些 tool 之外的工具"；闭包里的规则检查做第二层保护——即使 LLM 越狱调用了白名单外的工具，也会被 rule deny 拦下。安全边界不依赖 LLM 行为。

### 11.7 构造 beforeToolCall 闭包的完整流程（ToolCallOrchestrator.buildBeforeToolCall）

**归属**：`buildBeforeToolCall` 不是 TurnManager 的私有方法，而是 **`ToolCallOrchestrator`**（D10 服务层节点 + D18 显式编排器）的方法。`TurnManager` 在 `handlePrompt` 里通过 `this.deps.orchestrator.buildBeforeToolCall(...)` 调用，不自己拼装闭包——这是 D18 明确的职责划分。

**`ToolCallOrchestrator` 的定位**（D10 + D18）：
- **服务层**节点，和 `Runtime` / `ApprovalRuntime` / `ConversationProjector` / `MemoryRuntime` 平级
- **不**是第 7/8 个 sub-component，行为组件只通过 `Deps` 接口引用它
- **对 Soul 的公开 API 保持不变**：Soul 只看到 `SoulConfig.beforeToolCall` 这一个 callback，不知道 orchestrator 的存在（这是 D18 采纳方案 D 的核心理由——不把不稳定的内部组织过早固化成公共 API）

**Phase 2 streaming tool execution 预留方法**（决策 #97；Phase 1 不实现，body 留空 / undefined）：

```typescript
class ToolCallOrchestrator {
  // Phase 1 已有
  buildBeforeToolCall(...): BeforeToolCallCallback;
  buildAfterToolCall(): AfterToolCallCallback;

  // ─── Phase 2 streaming 预留（决策 #97） ───
  // 由 SoulPlus 内部的 StreamingKosongWrapper 在 KosongAdapter.chat() 期间收到
  // onToolCallReady 回调时调用，开始受控并发执行（不阻塞 LLM stream 继续接收）。
  // 必须复用与 buildBeforeToolCall 相同的 effectiveRules / approvalSource 闭包，
  // 否则 streaming 路径的 approval 规则会与正常路径不一致——违反 §11.7 安全契约。
  executeStreaming?(toolCall: ToolCall, signal: AbortSignal): void;

  // 取走 stream 期间已经完成的 tool_result（按 toolCallId 索引）。
  // StreamingKosongWrapper 在 chat() 收尾时调用，把结果塞进 ChatResponse._prefetchedToolResults。
  drainPrefetched?(): ReadonlyMap<string, ToolResult>;

  // streaming 被中断 / fallback 时丢弃所有已 dispatch 的 streaming tool 结果。
  // 必须由 §7.2 abort 标准顺序与 fallback 路径调用，避免出现 dangling tool_use 没有配对 tool_result。
  // reason='aborted' 来自 turn cancel；'fallback' 来自 streaming 路径主动降级到线性路径。
  discardStreaming?(reason: "fallback" | "aborted"): void;
}
```

**v2 偏离 Python 全并发的核心选择**：Python 版 kosong `KimiToolset.handle` 默认所有 tool 通过 `asyncio.create_task` 全并发（无 concurrency-safe gate），赌"model 自己保证不发互斥 tool"——对小模型不友好。CC 的 StreamingToolExecutor 走"受控并发"路线（`tool.isConcurrencySafe(parsedInput)` 决定能否与正在跑的 tool 并行；non-concurrent 必须独占）。v2 选 CC 路线：tool 集合包含 Bash / file-write 等强副作用 tool，全并发会引入 race（`Bash("rm")` + `Bash("ls")` 同时跑）；[`isConcurrencySafe`](#102-tool-接口定义)（§10.2 / 附录 D.2）显式声明从 tool 元数据读取，工程化更可控。详见决策 #97 FAQ。

**orchestrator 内部的固定阶段顺序**（Phase 1 就写死）：
```
validate（Soul 内，非 orchestrator 阶段）
    ↓
preHook          （PreToolUse hook，见 §13.8）
    ↓
permission       （checkRules 纯函数匹配规则）
    ↓
approval/display （permission = ask 时，通过 ApprovalRuntime 发起 request + 计算 display 素材）
    ↓
execute（Soul 内，非 orchestrator 阶段）
    ↓
PostToolUse      （PostToolUse hook，见 §13.8）
    ↓
OnToolFailure    （独立阶段，Phase 1 即拆出，不并入 PostToolUse；见 §13.8）
```

**哪些不属于 orchestrator**：
- **参数 schema 校验**：永久留在 Soul 内，由 `zod.safeParse(args)` 统一做一次（§10.2 / §5.1.7）——这是 Soul 对 tool 输入完整性的内生职责，**不**纳入 orchestrator 阶段
- **实际 tool.execute 调用**：由 Soul 的 `while` 循环驱动，orchestrator 只管"之前"和"之后"
- **approval UI display 构造**：挂在 orchestrator 内部的 `approval/display` 阶段（Phase 1 不独立抽 `ToolApprovalDisplayBuilder`，Phase 2 再说）

下面是 `buildBeforeToolCall` 的伪代码（归属 `ToolCallOrchestrator`）：

```typescript
// SoulPlus 服务层，ToolCallOrchestrator 内部
buildBeforeToolCall(
  fullOverrides: FullTurnOverrides,
  sessionRules: PermissionRule[],
  approvalSource: ApprovalSource,
): BeforeToolCallCallback {
  // 1. 把 overrides 转成 turn-scope 规则
  const turnRules: PermissionRule[] = [];
  if (fullOverrides.activeTools) {
    // activeTools 隐含 allow rule
    for (const toolName of fullOverrides.activeTools) {
      turnRules.push({
        id: `override-allow-${toolName}`,
        behavior: "allow",
        matcher: { toolName },
        scope: { kind: "turn-override" },
      });
    }
  }
  if (fullOverrides.disallowedTools) {
    for (const toolName of fullOverrides.disallowedTools) {
      turnRules.push({
        id: `override-deny-${toolName}`,
        behavior: "deny",
        matcher: { toolName },
        scope: { kind: "turn-override" },
      });
    }
  }

  // 2. 合并规则
  const effectiveRules = [...sessionRules, ...turnRules];

  // 3. 返回闭包，固定阶段顺序：preHook → permission → approval/display
  return async (ctx, signal) => {
    // 3.1 preHook（PreToolUse，可阻断，Phase 1 不允许改写 args，见 §13.8）
    const preResult = await this.hookEngine.executeHooks("PreToolUse", {
      toolCall: ctx.toolCall,
      args: ctx.args,
    }, signal);
    if (preResult.blockAction) {
      return { block: true, reason: preResult.reason ?? "blocked by PreToolUse hook" };
    }

    // 3.2 permission check（checkRules 纯函数）
    const decision = checkRules(ctx.toolCall, ctx.args, effectiveRules);
    if (decision === "allow") return undefined;
    if (decision === "deny") {
      return { block: true, reason: "denied by permission rule" };
    }

    // 3.3 approval/display —— decision === "ask" —— 需要用户审批
    //
    // 决策 #98 / Tool UI 渲染契约：display 素材通过 Tool.display 系列 hook 构造。
    // tool 提供 hint 时优先用 tool 的，否则走默认 fallback；EditTool / WriteTool 的 file_io
    // 占位由 enrichDisplayHintWithDiff 升级为 diff（读文件 + 算 patch，复用一份给 transcript）。
    // 这份 display 同时（1）作为 ApprovalRequest.display 走 approval 路径
    //                     （2）emit 到 tool.call 事件（input_display 字段）
    //                     （3）落 wire.jsonl 的 tool_call_dispatched.input_display
    const tool = findTool(ctx.toolCall.name);
    const inputDisplay = tool.display?.getInputDisplay?.(ctx.args)
                         ?? defaultGetInputDisplay(tool, ctx.args);
    const display = await this.enrichDisplayHintWithDiff(tool, ctx.args, inputDisplay);

    // 发起 approval 请求（通过 ApprovalRuntime，见 §12）
    // approvalSource 由 orchestrator 构造期传入，对应 Soul 自己还是 subagent，
    // 便于 cancelBySource 精确批量取消（D17）
    // 注意：ApprovalDisplay 已在决策 #98 收编为 ToolInputDisplay 的 alias，类型一致
    const result = await this.approvalRuntime.request({
      toolCallId: ctx.toolCall.id,
      toolName: ctx.toolCall.name,
      action: this.describeAction(ctx.toolCall, ctx.args),
      display,
      source: approvalSource,
    });

    if (result.approved) return undefined;
    return { block: true, reason: result.feedback ?? "rejected by user" };
  };
}
```

这个闭包里有完整能力（读文件、算 diff、调 ApprovalRuntime、写 wire record）——这些能力都是 SoulPlus 的，Soul 完全无感知。闭包返回的是 `BeforeToolCallResult`，Soul 看到 `undefined` 就继续调 tool，看到 `{block: true, reason}` 就走"tool_call 被拦截"的 synthetic error 路径（§6.1）。

**TurnManager 的调用姿势**（对照 §6.4）：
```typescript
// TurnManager 内部，不自己 new 规则、不自己写 permission 逻辑
const beforeToolCall = this.deps.orchestrator.buildBeforeToolCall(
  fullOverrides,
  this.sessionRules,
  { kind: "soul", agentId: this.currentAgentId },
);
const afterToolCall = this.deps.orchestrator.buildAfterToolCall();
// 后面把闭包透传给 runSoulTurn(...)
```

`TurnManager` 不再拥有 `buildBeforeToolCall` 方法；它只从 `Deps.orchestrator` 取这两个 callback 然后作为 `SoulConfig` 字段传给 `runSoulTurn`。这是 D10 + D18 对行为组件层和服务层分工的明确要求。

#### 11.7.1 FAQ: v2 为什么选受控并发而不是 Python 全并发（决策 #97）

**Q：Python kimi-cli 的 kosong `KimiToolset.handle` 默认全并发（所有 tool 通过 `asyncio.create_task` 起 task，互相不阻塞），v2 为什么选 CC 的"受控并发"路线（[`tool.isConcurrencySafe(parsedInput)`](#102-tool-接口定义) 决定能否与正在跑的 tool 并发）？**

A：三个理由：

1. **强副作用 tool 的 race 风险**：v2 的 tool 集合包含 Bash / Write / Edit 等强副作用 tool。如果 LLM 偶发同时发 `Bash("rm tmp/")` + `Bash("ls tmp/")` 或 `Write("a.txt", v1)` + `Edit("a.txt", v2)`，全并发会引入 race；Python 版回避这个问题的代价是"model 自己保证不发互斥 tool"，对小模型（开源 8B / 13B）不友好。

2. **[`isConcurrencySafe`](#102-tool-接口定义) 元数据可工程化**：CC 的设计让每个 Tool 在元数据里显式声明 `isConcurrencySafe()`（默认 false / true 都可，按 tool 类型决定）；v2 的 ToolCallOrchestrator 在 dispatch 期间查询这个元数据决定是否能并发——比"运行时 race detection"更可控、更可审计。Phase 1 在 §10.2 Tool interface 已预留该字段，Phase 2 启用受控并发时直接生效，不破坏 Tool 接口。

3. **生产验证**：CC 的 `StreamingToolExecutor` 已生产验证（tengu_streaming_tool_execution_used 埋点），实测 Read / Grep / Glob 等 concurrency-safe tool 并发收益显著；Bash 类 non-concurrent tool 独占执行（与 Python 全并发相比，独占引入的延迟由 LLM 自己同时发多 tool 的频率决定，整体平均收益仍可观）。

**与 Python 路线的具体差异**：v2 不复制 CC 的"sibling Bash error 自动 abort"策略（Phase 2 评估）——v2 的 Bash 是普通 tool，独立 tool 失败的 `tool_result.is_error: true` 已经足够 LLM 自我决策，不需要批量取消兄弟。

### 11.8 "pre-check 允许做重活"的纪律红线

`beforeToolCall` 被明确**允许**做耗时操作：

- 读文件（例如 FileReplace 预先读出原文件用于算 diff）
- 算 diff / patch
- 查 tool registry / MCP server
- 发 approval wire 消息并 await 用户响应（秒级）
- 调用外部 ACL 服务

这不是例外，是**主路径**。Phase 1 之前的"pre-check 只做参数校验"的设计被明确放弃。

**理由**：approval 的 UI display 素材往往依赖 tool 内部业务计算（例如 FileReplace 需要展示 diff），如果硬拆成"pre-check 只校验、execute 时再算 display"，会让 tool 代码在两个地方都要写一份同样的准备逻辑，丑陋且容易不一致。

**代价**：某些 tool 会计算两次（pre-check 算一次 diff，execute 时再算一次 new content）。这是可以接受的；如果某个 tool 真的很贵，可以在 `ctx` 上挂一个 turn 级 cache（key 为 `toolCallId`）让 execute 从 pre-check 里复用结果，但这是优化、不是 Phase 1 义务。

**不留二次 approval 口子**：tool 的 `execute` **不会**拿到 `ctx.requestApproval` 这类接口。如果 tool 在执行中发现新的危险信号，它只能 `throw` error——错误走正常的 tool_result 返回路径，LLM 看到 error 后再决定重试或换方案。

严格 deny 所有需要二次 approval 的场景：
- Shell 命令里的命令替换 `$(...)`、反引号
- `eval` / `exec` 这类动态求值
- 交互式命令（例如 `sudo` 弹密码）

这些由 pre-check 的**静态分析**在 ask/deny 阶段拦住，不允许进入 execute。

**这是一条纪律红线**：禁止把 approval 分散到多个位置。整个 kimi-core 里只有一个 approval gate，就是 `beforeToolCall`。

### 11.9 新增 Wire 事件

- `permission_mode.changed`：权限模式变更（`{ old_mode, new_mode }`）
- `tool.denied`：工具被 permission 规则拒绝（`{ tool_call_id, tool_name, reason }`）
- approval 相关事件（`approval_request` / `approval_response`）见 §12

### 11.10 已删除设计的指针

相对 v2 初稿，本轮重写从旧 §11 / §12 / §6.12 / §4.5 删除了一组 permission / approval 相关设计元素（7 层权限检查链、Tool 的各种自检字段、`Runtime.permissionChecker`、`SoulRegistry.createSoul` 里的 per-Soul PermissionChecker 注入、旧 `ApprovalRuntime` 的 2 方法接口等）。完整清单、每项的替代方案以及"保留的硬核部分"见 **附录 F.4**。

---

## 十二、Approval 系统（审批流与崩溃恢复）

### 12.1 定位

Approval 系统是 **SoulPlus 内部** 负责"弹框、等用户响应、落盘、崩溃恢复"的子系统。它的消费者是 §11.7 里描述的 `beforeToolCall` 闭包：当 permission 决策为 `ask` 时，闭包通过 ApprovalRuntime 发起一次 request 并 await 用户响应。

**Soul 完全无感知**——它既不导入 ApprovalRuntime 类型，也不知道有 approval 这个概念。Soul 看到的只是 `beforeToolCall` 闭包返回 `undefined`（继续）或 `{block: true, reason}`（拦截）。

**嵌入方可以替换**：嵌入方完全不用 kimi-cli 的 ApprovalRuntime，直接在自己的 `beforeToolCall` 闭包里实现任何审批逻辑（例如查企业 ACL API、写 GUI 弹框、纯日志审计）。这就是方案 Z 的终极价值（见 §12.7）。

### 12.2 ApprovalRuntime 接口

```typescript
interface ApprovalRuntime {
  // 发起一次 approval 请求，await 直到用户响应
  // 返回 Promise，由 wire server 收到 ApprovalResponse 后 resolve
  request(req: ApprovalRequest): Promise<ApprovalResult>;

  // SoulPlus 在崩溃恢复阶段调用：
  // 扫描 wire.jsonl 里所有"有 request 无 response"的 pending approval
  // 自动生成 synthetic cancelled response 写回 wire.jsonl
  recoverPendingOnStartup(): Promise<void>;

  // Wire server 收到 ApprovalResponse 时调用
  resolve(requestId: string, response: ApprovalResponseData): void;

  /**
   * 按来源批量取消（例如 subagent 被杀时取消它发出的所有 pending approval）。
   *
   * **同步 void 的承诺范围**（决策 #102 / 避免实现者误读为"必须 await SQLite"）：
   *
   * 本方法**必须立即生效**：
   * - in-memory waiter 立即被 reject 成 cancelled（调用方在 `cancelBySource(...)` return 后
   *   下一行就能假定卡在 `request(...)` 的 promise 已经 settle）；
   * - cancel event 立即 emit 到 EventSink（UI 立即能看到 approval 状态切换为 cancelled）。
   *
   * 本方法**不承诺**：
   * - synthetic cancelled response 写入 wire.jsonl 走 SessionJournal fire-and-forget（异步追赶
   *   落盘，与决策 #95 JournalWriter 异步批量一致）；
   * - agent team 跨进程撤销靠 mailbox publish ApprovalCancel envelope（异步），远端 member daemon
   *   自己 poll 处理，不在本方法的同步路径内。
   *
   * 即同步 void 只承诺"in-memory 状态立即一致"，落盘和跨进程通信都异步。
   * 这与 §7.2 abort 标准顺序兼容（`cancelBySource` 是 abort 链的第一步，必须不阻塞，
   * 才能让后续 `controller.abort(...)` 能立刻接力）。
   *
   * 崩溃窗口：cancel 已发但 wire 未落 → 重启时 `recoverPendingOnStartup` 扫到 pending →
   * 自动生成一份 cancelled response（重复一份）。最终一致，wire 多一条幽灵记录但不影响逻辑
   * （ApprovalRuntime 内部按 request_id 去重；resolve 后再来的同 id response 直接丢弃）。
   *
   * 参考：Python `cancel_by_source` 同样是同步函数（`approval_runtime/runtime.py:149`）。
   */
  cancelBySource(source: ApprovalSource): void;

  // TeamDaemon 收到跨进程 teammate 转发的 approval_request envelope 时调用：
  // 注入一条 pending ApprovalRequest 到本地 waiter 表和 wire.jsonl，
  // 等待远端 teammate 或本地 UI 把 response 回送回来。data 形态对齐 §8.3.3
  // ApprovalRequestPayload（envelope.data 在 type === "approval_request" 分支里的 payload）。
  // 语义详见 §8.3.3 TeamDaemon 的 teammate approval 转发流程。
  ingestRemoteRequest(data: ApprovalRequestPayload): Promise<void>;

  // TeamDaemon 收到跨进程 teammate 回送的 approval_response envelope 时调用：
  // 用 request_id 定位对应 waiter 并 resolve，同时由实现内部负责追加一条
  // approval_response record 到 wire.jsonl。非 Promise —— 和本地 resolve(...) 对齐，
  // side effect 在内部 fire-and-forget 调用 sessionJournal.appendApprovalResponse
  // （SessionJournal 自己保证落盘顺序）。data 形态：{ request_id, response, feedback? }
  // 对齐附录 B ApprovalResponseSchema.data 与 §12.2 的 ApprovalResponseData。
  resolveRemote(data: { request_id: string } & ApprovalResponseData): void;
}

interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  action: string;            // 简短描述，例如 "execute bash command"
  display: ApprovalDisplay;  // 结构化展示数据（决策 #98 后即 ToolInputDisplay）
  source: ApprovalSource;
}

// 决策 #98 / Tool UI 渲染契约：ApprovalDisplay 收编为 ToolInputDisplay 的别名。
// 调用前展示给用户审批（approval）、调用时展示在 transcript（tool.call.input_display）
// 共享同一份 hint。完整 union 定义见 §10.7.3 / 附录 D.2。
//
// 旧 union 的 5 个 kind（command / diff / file_write / task_stop / generic）仍然支持，
// ToolInputDisplay 在此基础上扩展了 file_io / search / url_fetch / agent_call /
// skill_call / todo_list / background_task 等 ~10 个 kind + generic fallback。
type ApprovalDisplay = ToolInputDisplay;

// ApprovalSource discriminated union——兼容五种批量取消语义：
// - "soul"      当前 Soul 发起的所有 pending approval
// - "subagent"  某个具体 subagent 发起的所有 pending approval
// - "turn"      绑定到某个 turn_id（TurnManager.abortTurn → cancelBySource 用这个）
// - "session"   绑定到整个 session（shutdown 时用）
// - "mcp"       MCP server 发起的 elicitation / auth / tool_call approval（决策 #100 / D-MCP-4）
//               server 断开时 McpRegistry 调 cancelBySource({ kind: "mcp", server_id }) 批量清理
type ApprovalSource =
  | { kind: "soul"; agentId: string }
  | { kind: "subagent"; agentId: string }
  | { kind: "turn"; turn_id: string }
  | { kind: "session"; session_id: string }
  | { kind: "mcp"; server_id: string; reason: "elicitation" | "auth" | "tool_call" };

interface ApprovalResult {
  approved: boolean;
  feedback?: string;  // 用户拒绝时留给 LLM 的提示
}

interface ApprovalResponseData {
  response: "approved" | "rejected" | "cancelled";
  feedback?: string;
}
```

### 12.3 Request → Response 完整流程

```
SoulPlus 内 beforeToolCall 闭包
  → approvalRuntime.request({...})
  → 分配 request_id
  → 构造 ApprovalRequest wire record
  → journalWriter.append(...)            // wire.jsonl 落一条 approval_request
  → 在 _waiters[requestId] 里放一个 Future<ApprovalResult>
  → await 这个 Future（带超时，例如 300s）
  ↓
  ↓ (用户在 UI 上操作)
  ↓
Wire Server 收到 client 的 ApprovalResponse 消息
  → approvalRuntime.resolve(requestId, responseData)
    → 查 _waiters[requestId]
    → 构造 ApprovalResponse wire record
    → journalWriter.append(...)          // wire.jsonl 落一条 approval_response
    → waiter.resolve({approved, feedback})
  ↓
beforeToolCall 的 await 返回
  → 根据 approved 返回 undefined 或 {block: true}
```

**关键不变量**：
- `approval_request` 和 `approval_response` **都进 wire.jsonl**（走 JournalWriter，属于 ContextState 写入路径的变体，遵循 §4.5 / §4.8 的 EventSink 铁律）
- 落盘顺序：**先写 request，再 await**；**先写 response，再 resolve waiter**。这保证崩溃后磁盘语义和内存语义对齐
- Future / Promise 是 in-memory 机制，崩溃后会丢——所以才需要 §12.4 的 `recoverPendingOnStartup`

### 12.4 崩溃恢复（被动 journal repair，对齐 D5 / §9）

**核心原则（D5）**：崩溃恢复是**被动 journal repair**，**不是主动续跑**。重启后 lifecycle 一律回到 `idle`，不自动起 recovery turn，也不恢复到 `active`。崩溃后原 turn 的闭包 / `AbortController` / `waiter` / subprocess 都已经丢失，所谓"续跑"不成立。**禁止**追加 synthetic `user_message` 作为 recovery prompt（这是和 §9 新口径的对齐点）；用户可见的"上次被中断"提示由 UI out-of-band 或 notification 传达，不经 transcript。

崩溃点 → 修复策略矩阵（approval 相关）：

| 崩溃发生点 | wire.jsonl 状态 | Replay 策略（被动 repair） |
|---|---|---|
| `tool_call_dispatched` 之前 | 无 tool_call 记录 | 下一个真实 user turn 才会产生新的 tool_call，此崩溃点无需额外修复；Soul 不重新走旧 step |
| `approval_request` 之前 | 有 tool_call_dispatched，无 request | 按 D2 的 ownership：由对应 writer（这里是 Soul 原本会发的 synthetic error tool_result）在 dangling 修复阶段补 synthetic error `tool_result`；**不**重发 approval request |
| `approval_request` 之后，response 之前 | 有 request 无 response（**关键情况**） | `recoverPendingOnStartup` 写回 synthetic cancelled `approval_response`，同时为对应 `tool_call_id` 补 synthetic error `tool_result`；replay 时对话状态呈现"tool 执行被取消"的完整语义，无需 LLM 重试 |
| `approval_response` 之后，tool 执行中 | 有 request+response 无 tool_result | 补 synthetic error `tool_result`（content 写明"execution interrupted by crash"），对 Soul 呈现"tool 已执行但失败"的完整语义；不重跑 tool |
| `tool_result` 已写 | 完整 | 正常 replay，无额外动作 |

**共同模式**：所有崩溃点的修复都是**补 synthetic record 让对话状态语义完整**，**不重发 request、不 LLM 重试、不 recovery prompt**。LLM 下一次被调用是新 user turn 的事，不是恢复动作。

**recoverPendingOnStartup 的详细逻辑**：

```typescript
async recoverPendingOnStartup() {
  const records = await readAllWireRecords();
  // key   = request_id
  // value = 原始 approval_request record（保留其 turn_id / step，用于补 response 时对齐）
  type ApprovalRequestRecord = Extract<WireRecord, { type: "approval_request" }>;
  const pendingRequests = new Map<string, ApprovalRequestRecord>();

  for (const r of records) {
    if (r.type === "approval_request") {
      pendingRequests.set(r.data.request_id, r);
    } else if (r.type === "approval_response") {
      pendingRequests.delete(r.data.request_id);
    }
  }

  // 剩下的都是 pending —— 被动 journal repair，补 synthetic cancelled response
  // 注意调用 shape：appendApprovalResponse 的入参按 JournalInput<"approval_response">
  // 严格对齐附录 B 的 schema —— {turn_id, step, data:{...}}，不是打平的 {request_id, ...}
  for (const [requestId, request] of pendingRequests) {
    await sessionJournal.appendApprovalResponse({
      turn_id: request.turn_id,
      step: request.step,
      data: {
        request_id: requestId,
        response: "cancelled",
        feedback: "interrupted by crash",
        synthetic: true,  // 标记是系统生成的，UI 可区分
      },
    });
    // 注意：synthetic cancelled response 属于 "管理类 record"，
    // 通过 SessionJournal 的 appendApprovalResponse 窄门写入，
    // 底层最终走 JournalWriter（见 D2）
  }

  // dangling tool_call（有 dispatched 但无 tool_result 的）由
  // §9 的 dangling 修复阶段补 synthetic error tool_result，属于 ContextState 写入路径
  // 两个修复 phase 按 D2 的 record ownership 分流，互不越权
}
```

**调用时机**：这个操作在 SoulPlus 启动时、**行为组件层创建之前**完成（D10 初始化顺序第 3 步）。之后任何人调 `TurnManager.handlePrompt` 看到的都是完整的 request/response 对 + 补齐的 synthetic tool_result，语义干净。lifecycle 此时已经是 `idle`，等第一个真实 user prompt 进来才会转 `active`——这是 D5 的"回 idle 不主动续跑"。

**禁止的做法**（过去设计里出现过，现在一律作废）：
- ❌ 重新发 approval request 让用户"再审批一次"——原 waiter 已经丢失，重发只会让 UI 出现多条幽灵 pending
- ❌ 追加 synthetic `user_message` 作为 recovery prompt——会污染 transcript，破坏 D7（user_message 只在真实 user turn 写）
- ❌ 启动 recovery turn 让 LLM "决定下一步"——LLM 恢复的职责由下一个真实 user prompt 承担，不是系统的职责
- ❌ 重跑崩溃中的 tool——tool 的副作用（已写文件、已发 HTTP）无法可靠判断，再跑一次可能二次损害

### 12.5 超时与取消（对齐 §7 AbortScope 契约）

三种"非正常完成"路径，全部必须和 §7 / D17 的 Abort Propagation Contract 对齐：

- **超时**：`request()` 内部用 `setTimeout` + `Promise.race`（超时值默认 300s），超时后自动 reject 成 `{approved: false, feedback: "timed out"}`，**同时写 synthetic cancelled `approval_response` 到 wire.jsonl**（保持内存 / 磁盘一致）
- **signal 级联 abort**：`request()` 的内部 await 必须监听传入的 `signal`（来自 turn 的 root `AbortController`）。当 `TurnManager.abortTurn(...)` 按 D17 固定顺序执行时，**先** `approvalRuntime.cancelBySource({ kind: "turn", turn_id })` 让所有 approval waiter 立即 unblock，**再** `rootController.abort(...)` 让 HTTP / subprocess 级联取消。`request()` 在接到 signal 后抛 `AbortError` 让 `beforeToolCall` 立即返回 `{block: true, reason: "tool execution cancelled"}`——这是 D17 明确要求的 cancellation 语义（不是 generic error）
- **主动 cancelBySource**：`cancelBySource(source: ApprovalSource)` 是 AbortScope 契约的一部分。`source` 可以是 `{kind: "turn", turn_id}` / `{kind: "subagent", agentId}` / `{kind: "session", session_id}` 等。匹配的 pending waiter 全部被 reject 成 cancelled，并写 synthetic cancelled response。典型场景：subagent 被杀（`cancelBySource({kind:"subagent",agentId})`）、用户按 ESC / 按 D17 顺序取消当前 turn（`cancelBySource({kind:"turn",turn_id})`）、session shutdown（`cancelBySource({kind:"session",session_id})`）

**关键不变量**：
- 三种路径都**必须**保证 wire.jsonl 里有对应的 cancelled `approval_response` 记录，否则下次启动 `recoverPendingOnStartup` 会再生成一条重复记录（违反幂等）
- `cancelBySource` 是 **AbortScope 契约的一部分**（D17），而不是一个可有可无的辅助方法；`TurnManager.abortTurn` 的顺序固定为"先 cancelBySource、再 AbortController.abort"，Soul 才能自然退出
- `request()` 传入的 `signal` 必须一路贯穿到 approval waiter 内部（不是只在方法入口检查一次），才能在 abort 时立即释放——这是 §7 "每个 await 点都要支持 signal" 原则在 approval 子系统的具体落地

### 12.6 Hook 集成（Phase 1 起步，Phase 3+ 完善）

**Phase 1 范围**：`beforeToolCall` 一个入口处理 permission + approval + hook 三件事。如果 SoulPlus 加载了 Hook 系统，hook 作为 `beforeToolCall` 闭包内部的一段——在 permission 决策之后、approval 请求之前/之后插入（具体顺序见 §13）。

**未来扩展**：独立的 PreToolUse / PostToolUse hook 系统挂在 `beforeToolCall` / `afterToolCall` 的装饰链上，参考 cc-remake 的 `resolveHookPermissionDecision` 设计。这个在 §13 Hook 系统扩展里已经有框架，本节保持占位、不展开。

### 12.7 嵌入方如何替换 Approval

嵌入方完全不用 kimi-cli 的 ApprovalRuntime，直接实现自己的 `beforeToolCall`：

```typescript
const runtime = createSimpleRuntime({...});

await runSoulTurn(
  input,
  {
    tools,
    beforeToolCall: async ({ toolCall, args }) => {
      // 嵌入方的审批逻辑：比如查企业 ACL API
      const allowed = await myCompanyACL.check(currentUser, toolCall.name, args);
      if (!allowed) return { block: true, reason: "ACL denied" };
      return undefined;
    },
  },
  context, runtime, sink, signal,
);
```

嵌入方的审批系统可以是任何东西——本地 ACL、远程 API、GUI 弹框、日志审计、纯放行——只要最终返回 `BeforeToolCallResult`（`undefined` 或 `{block, reason}`）。Soul 无需任何修改，照常运行。这就是方案 Z 把 approval gate 收敛到一个 callback 的核心收益。

---

## 十三、Hook 系统

> **本章总览**：Hook 系统是 kimi-core 提供给 server 端 / wire 端 / tool 执行链的横切扩展机制。本章统一覆盖三层内容：(1) Hook 的双通道基础概念（继承 v1，§13.1–§13.4）；(2) HookExecutor 可插拔架构（HookExecutor 接口 / HOOK_EXECUTOR_REGISTRY / HookEngine 调度器，§13.5–§13.7）；(3) Tool 执行链上的 PreToolUse / PostToolUse / OnToolFailure 三个 Hook 事件如何与 ToolCallOrchestrator 阶段对应（§13.8）。下面按这个顺序展开，每一节都假设读者已经看过 §10（Tool 系统）/ §11（Permission 系统）/ §12（Approval 系统）。

### 13.1 双通道

- **Server-side hook**：shell 命令，在 Core 进程执行（沿用 Python kimi-cli）
- **Wire hook**：通过双向 RPC 发给 client，client 回调（沿用 v1 已有设计）

### 13.2 事件触发

Soul 在关键时机调用 `HookEngine.execute(event, context)`：
- `PreToolUse` / `PostToolUse`
- `UserPromptSubmit`
- `Stop` / `SubagentStop`
- `Notification`
- `SessionStart` / `SessionEnd`
- `PreCompact` / `PostCompact`

### 13.3 执行顺序

```
Event 触发
  ↓
HookEngine
  ├─ 匹配 server-side hooks → 依次 shell exec → 收集 result
  └─ 匹配 wire hooks → 通过双向 RPC 发 hook.request → 收集 result
  ↓
合并结果（优先级：block > modify > allow）
  ↓
返回给 Soul
```

Soul 根据结果决定：
- `allow`：继续执行
- `modify`：用 modified input 继续
- `block`：抛出 HookBlocked 异常，turn 结束

### 13.4 与 v1 的差异

v1 文档没有明确 wire hook 的 timeout 和错误处理。v2 明确：
- Wire hook 超时默认 30s（可配置）
- 超时视为 `allow`（不阻塞正常流程）
- client 断连时，所有 pending hook 自动 fallback 为 `allow`


### 13.5 HookExecutor 接口

```typescript
interface HookExecutor {
  readonly type: string;
  execute(
    hook: HookConfig,
    input: HookInput,
    signal: AbortSignal,
  ): Promise<HookResult>;
}
```

**HookResult**：单个 executor 的返回结果。字段概览：`ok` / `reason?` / `blockAction?`（阻断当前 event 对应的动作）/ `additionalContext?`（注入给 LLM 的补充上下文）/ `updatedInput?`。完整 TypeScript 定义见 **附录 D.7**。`HookConfig`、`HookInput`、`AggregatedHookResult` 等相关类型同样定义在附录 D.7。

### 13.6 HOOK_EXECUTOR_REGISTRY

```typescript
const HOOK_EXECUTOR_REGISTRY = new Map<string, HookExecutor>();

// 第一阶段
HOOK_EXECUTOR_REGISTRY.set("command", new CommandHookExecutor());
HOOK_EXECUTOR_REGISTRY.set("wire", new WireHookExecutor());

// 未来扩展（只需实现接口 + 注册，不改调度器）
// HOOK_EXECUTOR_REGISTRY.set("http", new HttpHookExecutor());
// HOOK_EXECUTOR_REGISTRY.set("prompt", new PromptHookExecutor());
// HOOK_EXECUTOR_REGISTRY.set("agent", new AgentHookExecutor());
```

### 13.6.1 WireHookExecutor 协议流程

WireHookExecutor 是通过 Wire 双向 RPC 将 hook 事件转发给外部 client 的执行器。完整协议流程如下：

**1. Hook 订阅声明**

客户端在 `initialize` 请求时通过 `data.hooks` 数组声明感兴趣的 hook 事件和匹配条件（详见 §3.5 InitializeRequest schema）。WireHookExecutor 在 HookEngine 初始化后注册这些订阅，记录 `clientId → subscriptions[]` 的映射。

**2. 触发流程**

```
Soul 执行到 hook 点
  → HookEngine.executeHooks(event, input, signal)
    → 匹配到 WireHookExecutor
      → WireHookExecutor 查找订阅了该 event 的 client
        → 通过 Wire 双向 RPC 发 hook.request 给 client
          → client 处理后返回 hook.response
```

**3. 消息格式**（基于 §3.1 Wire 统一消息信封）：

```
Core → Client:
{ type: "request", method: "hook.request", request_id: "req_xxx",
  data: { event: "PreToolUse", tool_name: "Bash", tool_input: {...} } }

Client → Core:
{ type: "response", request_id: "req_xxx",
  data: { ok: true, blockAction: false, updatedInput: {...} } }
```

**4. 超时与错误处理**

- Wire hook 超时默认 30s，可通过 `HookConfig.timeout` 配置（§13.4 已约定）
- 超时视为 `{ ok: true }`（不阻断正常流程）
- client 断连时，所有 pending hook 请求自动 fallback 为 `{ ok: true }`
- 多个 client 注册同一 hook 事件时，结果按 HookEngine 的 `aggregateResults` 合并（§13.7：`blockAction` 有一个 true 就阻断，`additionalContext` 累积，`updatedInput` 后者覆盖前者）

**5. WireHookExecutor 伪代码**

```typescript
class WireHookExecutor implements HookExecutor {
  readonly type = "wire";

  async execute(hook: HookConfig, input: HookInput, signal: AbortSignal): Promise<HookResult> {
    const client = this.findSubscribedClient(hook.event, hook.matcher);
    if (!client) return { ok: true };  // 无订阅者，放行

    try {
      const response = await client.request("hook.request", {
        event: hook.event,
        ...input,
      }, { timeout: hook.timeout ?? 30_000, signal });

      return response.data as HookResult;
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "DisconnectedError") {
        return { ok: true };  // 超时或断连，不阻断
      }
      throw err;
    }
  }
}
```

### 13.7 HookEngine 调度器

```typescript
class HookEngine {
  async executeHooks(
    event: HookEventType,
    input: HookInput,
    signal: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const matchingHooks = this.getMatchingHooks(event, input);

    // 并行执行所有匹配的 hooks
    const results = await Promise.allSettled(
      matchingHooks.map(hook => {
        const executor = HOOK_EXECUTOR_REGISTRY.get(hook.type);
        if (!executor) {
          console.warn(`Unknown hook type: ${hook.type}, skipping`);
          return { ok: true };  // 未知类型跳过，不阻断
        }
        return executor.execute(hook, input, signal);
      })
    );

    return this.aggregateResults(results);
    // 聚合：blockAction 有一个 true 就阻断
    // additionalContext 累积
    // updatedInput 后者覆盖前者
  }
}
```

**新增 Hook 类型只需**：
1. 实现 `HookExecutor` 接口
2. 注册到 `HOOK_EXECUTOR_REGISTRY`
3. 在 Hook 配置 schema 的 discriminated union 中加新类型

**不需要改**：HookEngine、匹配逻辑、聚合逻辑。比 cc 的 7 文件改动模式更简洁。

### 13.8 Tool 执行 Hook 事件与 ToolCallOrchestrator 阶段对应

本节把 §13.5–§13.7（HookExecutor 可插拔架构）里定义的**通用 Hook 框架**，和 §11.7 的 `ToolCallOrchestrator` 固定阶段顺序明确对应起来，并给出 Phase 1 的 Hook 事件集合。

### 13.8.1 背景与定位（D18）

根据 D18 的决策，SoulPlus 内部引入 `ToolCallOrchestrator` 作为 D10 服务层的**显式**节点（和 `Runtime` / `ConversationProjector` / `ApprovalRuntime` / `MemoryRuntime` 平级），但**对 Soul 的公开 API 保持不变**——Soul 只看到 `SoulConfig.beforeToolCall` / `SoulConfig.afterToolCall` 两个 callback，不知道 orchestrator 的存在。Orchestrator 内部的固定阶段顺序在 Phase 1 就写死：

```
validate        （留在 Soul 内，非 orchestrator 阶段）
    ↓
preHook         （触发 PreToolUse hook 事件）
    ↓
permission      （checkRules 纯函数）
    ↓
approval/display（permission=ask 时，通过 ApprovalRuntime 发起 request）
    ↓
execute         （留在 Soul 内，非 orchestrator 阶段）
    ↓
postHook        （触发 PostToolUse hook 事件）
    ↓
OnToolFailure   （独立阶段，Phase 1 即拆出，不并入 postHook；作者拍板）
```

### 13.8.2 PreToolUse / PostToolUse / OnToolFailure 三个 Hook 事件

这三个事件通过 §13.7 的 `HookEngine.executeHooks(event, input, signal)` 通用调度器触发，事件类型 `HookEventType` 是字符串常量，HookExecutor（command / wire）自己决定怎么处理。Orchestrator 只负责"在对的时机调 HookEngine"，不直接知道 executor 细节。

> 表头说明：下表只列事件级的入参与返回效应，`HookInput` 本身还带共享的 `event` / `context` 基字段（`sessionId` / `turnId` / `stepNumber` / `agentId`），详见附录 D.7 `HookInputBase`。

| Hook 事件 | 触发时机（orchestrator 阶段） | 输入 (HookInput) | Phase 1 允许的修改 | 返回值影响 |
|---|---|---|---|---|
| `PreToolUse` | preHook 阶段（permission 之前） | `{toolCall, args}` | **禁止修改 args**（Phase 1，未来再说） | `blockAction = true` 让 orchestrator 直接返回 `{block: true, reason}`；`additionalContext` 累积用于审计 |
| `PostToolUse` | postHook 阶段（execute 之后、OnToolFailure 之前） | `{toolCall, args, result}` | 禁止修改 `result`（Phase 1） | `additionalContext` 累积；不可阻断 |
| `OnToolFailure` | **独立阶段**（execute 抛 error 时触发） | `{toolCall, args, error}` | 禁止修改 error | `additionalContext` 累积用于 UI / 审计；不可让 tool "复活" |

**关键约束（D18）**：

1. **OnToolFailure 是独立阶段**，和普通的 `PostToolUse` hook 严格分开。实现上是 orchestrator 在 `try / catch` 里的两条不同分支：
   ```typescript
   try {
     const result = await tool.execute(...);
     await hookEngine.executeHooks("PostToolUse", { toolCall, args, result }, signal);
     return result;
   } catch (error) {
     await hookEngine.executeHooks("OnToolFailure", { toolCall, args, error }, signal);
     throw error;  // 不让 hook 阻止错误传播
   }
   ```
   即使 Phase 1 的实现只是一个 `switch case`，在 Hook 事件类型层面也必须是独立的 event kind，不能用 `PostToolUse` + `result.isError` 代替。
2. **PreToolUse 在 Phase 1 不允许改写 args**——允许改写的语义（例如 "sanitize 用户输入里的敏感字段"）留 Phase 2 决定，Phase 1 先把通道拉通但禁止污染输入。
3. **参数 schema 校验不触发 hook**——参数 schema 校验永久留在 Soul 内（`zod.safeParse`），不属于 orchestrator 阶段，自然也不触发 PreToolUse hook。

### 13.8.3 和既有 Hook 系统的对接

§13.5–§13.7 定义的 `HookExecutor` / `HOOK_EXECUTOR_REGISTRY` / `HookEngine` 保持不变：

- `HookEngine.executeHooks(event, input, signal)` 照常按匹配规则选 executor，**并行** `Promise.allSettled` 执行所有匹配的 hook
- 聚合逻辑不变：`blockAction` 有一个 true 就阻断；`additionalContext` 累积；`updatedInput` 在 Phase 1 因 PreToolUse 不允许改 args 而被忽略
- Phase 1 只实现 Command / Wire 两种 HookExecutor；未来要加 HTTP / Prompt / Agent 时，**不需要**改 Orchestrator，只需要加新的 HookExecutor 实现 + 注册到 registry

### 13.8.4 TurnManager 的感知度

TurnManager 不直接调 `hookEngine.executeHooks(...)`——这层编排由 `ToolCallOrchestrator.buildBeforeToolCall` / `buildAfterToolCall` 负责。TurnManager 只知道 "我有 `orchestrator` 依赖、调它拿到两个 callback、透传给 `runSoulTurn`"；PreToolUse / PostToolUse / OnToolFailure 的分支细节对 TurnManager 隐藏。这是 D10 行为组件层只依赖服务层窄接口的典型落地。

---

## 十四、Transport 层

### 14.1 Transport 接口

```typescript
/**
 * Transport 是纯粹的双向字节帧通道。
 * 职责：建立/断开连接、发送/接收帧（string）。
 * 非职责：消息序列化/反序列化（WireCodec 层）、消息路由（Router 层）、session 管理。
 *
 * 状态机：idle → connecting → connected → closing → closed（终态，不可恢复）
 * 重连 = 创建新的 Transport 实例。
 */
interface Transport {
  readonly state: "idle" | "connecting" | "connected" | "closing" | "closed";
  connect(): Promise<void>;
  send(frame: string): Promise<void>;  // state !== "connected" 时 reject
  close(): Promise<void>;
  onMessage: ((frame: string) => void) | null;  // handler 不应 throw
  onConnect: (() => void) | null;
  onClose: ((code?: number) => void) | null;
  onError: ((error: Error) => void) | null;
}

/**
 * TransportServer 管理多 client 连接（Socket/WebSocket 场景）。
 * 每个 accept 到的连接变成一个独立的 Transport 实例。
 */
interface TransportServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  onConnection: ((transport: Transport) => void) | null;
}
```

**语义约定**：
- `send()` 的 Promise 在数据提交给底层传输后 resolve，不保证对端已收到
- `onMessage` 的 `frame` 保证是一个完整的消息字符串（分帧由实现层处理）
- `closed` 是终态——重连通过创建新 Transport 实例实现
- 认证和身份识别通过 Wire 协议层的 `initialize` 握手完成，不在 Transport 层

### 14.2 四种实现

| 实现 | 场景 | 连接方式 | 重连 | 备注 |
|------|------|---------|------|------|
| **MemoryTransport** | 测试 | `createLinkedTransportPair()` 创建一对，A.send → B.onMessage | 无 | 用 `queueMicrotask` 异步投递避免递归 |
| **StdioTransport** | CLI 子进程 | `process.stdin` 读 / `process.stdout` 写 | 无 | 需 stdout guard 防 console.log 污染 |
| **SocketTransport** | Unix socket | `net.connect(socketPath)` / `net.createServer()` | client 支持 | newline-delimited JSON 分帧（见下方说明） |
| **WebSocketTransport** | Web/远程 | `ws.connect(url)` / `ws.Server` | 指数退避 1s→30s | 参考 cc 的消息缓冲 + keepalive |

**SocketTransport 分帧协议**：newline-delimited JSON（NDJSON）——每行一个完整 JSON 消息，以 `\n` 分隔。注意：v1 文档曾设计为 4 字节 big-endian uint32 长度前缀，v2 统一为 NDJSON 以简化跨语言实现。Python SDK 等外部客户端应使用 `readline` 逐行解析，不要使用 `struct.pack` 长度前缀方式。

### 14.3 架构分层

```
调用方（TUI / SDK / Web）
        │ WireMessage (typed)
        ▼
  ┌──────────────┐
  │   WireCodec  │  序列化/反序列化：WireMessage ⇆ string (JSON)
  └──────┬───────┘
         │ string (frame)
         ▼
  ┌──────────────┐
  │  Transport   │  纯字节帧通道：connect / send / close
  └──────┬───────┘
         │ 底层 I/O
    Memory / Stdio / Socket / WebSocket
```

Transport 不知道消息语义，WireCodec 不知道传输方式，Router 不知道底层是什么 Transport。

### 14.4 客户端使用方式

#### 14.4.1 Transport 选择推荐

| 调用方 | Transport | 连接方式 |
|--------|-----------|---------|
| Node.js 同进程（库模式）| MemoryTransport | `createLinkedTransportPair()` |
| TUI（同进程）| MemoryTransport | `createLinkedTransportPair()` |
| Python SDK（跨进程）| SocketTransport | spawn subprocess → 连 Unix socket |
| Node.js SDK（跨进程）| SocketTransport | 连 Unix socket |
| Web 浏览器 | WebSocketTransport | 连 WebSocket |
| Hive（远程）| WebSocketTransport | 连 WebSocket |
| 测试 | MemoryTransport | `createLinkedTransportPair()` |

#### 14.4.2 Node.js 同进程使用示例

```typescript
import { createKimiCore, createLinkedTransportPair } from 'kimi-core';

// 1. 创建 Core 和 Transport
const core = createKimiCore(config);
const [clientTransport, serverTransport] = createLinkedTransportPair();

// 2. 连接
core.acceptTransport(serverTransport);
await clientTransport.connect();

// 3. 握手（详见 §3.5 InitializeRequest schema）
const initResponse = await wireClient.request("initialize", {
  protocol_version: "2.1",
  capabilities: { hooks: true, approval: true, streaming: true },
});

// 4. 创建 session
const { session_id } = await wireClient.request("session.create", {});

// 5. 监听事件
wireClient.on("session.event", (event) => {
  switch (event.type) {
    case "content.delta": process.stdout.write(event.delta); break;
    case "tool.call": console.log(`Calling ${event.name}...`); break;
    case "turn.end": console.log("Turn complete"); break;
  }
});

// 6. 发送 prompt（非阻塞，立即返回 turn_id）
await wireClient.request("session.prompt", {
  session_id,
  text: "帮我分析这个 bug",
});
```

#### 14.4.3 Python SDK 使用示例（subprocess + socket）

```python
import subprocess, socket, json

# 1. 启动 Core 子进程
proc = subprocess.Popen(
    ["kimi-core", "--transport", "socket", "--socket-path", "/tmp/kimi.sock"],
    stdout=subprocess.PIPE
)

# 2. 连接 Unix socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect("/tmp/kimi.sock")

# 3. NDJSON 分帧：每行一个 JSON（对齐 §14.2 SocketTransport 分帧协议）
def send(msg):
    sock.sendall((json.dumps(msg) + "\n").encode())

def recv():
    data = b""
    while not data.endswith(b"\n"):
        data += sock.recv(4096)
    return json.loads(data)

# 4. 握手
send({"type": "request", "method": "initialize", "request_id": "1",
      "data": {"protocol_version": "2.1"}})
init_resp = recv()

# 5. 创建 session + 发 prompt
send({"type": "request", "method": "session.create", "request_id": "2", "data": {}})
create_resp = recv()
session_id = create_resp["data"]["session_id"]

send({"type": "request", "method": "session.prompt", "request_id": "3",
      "data": {"session_id": session_id, "text": "你好"}})
```

#### 14.4.4 TUI 使用示例

```typescript
import { createKimiCore, createLinkedTransportPair } from 'kimi-core';

const core = createKimiCore(config);
const [clientTransport, serverTransport] = createLinkedTransportPair();
core.acceptTransport(serverTransport);
await clientTransport.connect();

// 事件驱动渲染
wireClient.on("session.event", (event) => {
  switch (event.type) {
    case "content.delta": tui.appendText(event.delta); break;
    case "tool.call": tui.showToolBadge(event.name, event.description); break;
    case "approval.request": tui.showApprovalDialog(event); break;
    case "turn.end": tui.showPrompt(); break;
  }
});

// 用户输入 → session.prompt
tui.onSubmit(async (text) => {
  await wireClient.request("session.prompt", { session_id, text });
});
```

---

## 十五、Skill 系统

### 15.1 Skill 的定义

**Skill 是可复用的任务模板**，用户通过 `/name` slash command 调用。Skill 和 Agent Definition 是两个不同的概念：

| | Skill | Agent Definition |
|--|--|--|
| **是什么** | 任务模板（"做什么"） | 身份定义（"是谁"） |
| **谁触发** | 用户（/commit）或 LLM | LLM（AgentTool）或 team 创建 |
| **上下文** | inline 共享当前对话 / fork 隔离 | 始终隔离 |
| **环境修改** | 有（临时覆盖工具集、模型） | 无（agent 有独立环境） |
| **模板变量** | 有（$ARGUMENTS, ${KIMI_SKILL_DIR}） | 无 |
| **持续时间** | 短暂（一个任务） | 持久（多轮对话） |

**Skill 不包括 session-control slash**（D4 决策）：`/compact` / `/cancel` / `/exit` / `/quit` 这类命令**不是** skill，而是 session 管理命令：

| slash 命令 | 分类 | 承载方式 |
|---|---|---|
| `/compact` | session 管理 | 由 `session.compact` Wire method 承载（见 §3.5） |
| `/cancel` | session 管理 | 由 `session.cancel` Wire method 承载 |
| `/exit`、`/quit` | session 管理 | 由 `session.destroy` 或客户端 shutdown 流程处理 |
| `/commit` / `/review-pr` / ... | skill | 走本章的 SkillManager |

这些 session-control slash 的转换**发生在 TUI 层**，并且**必须先于 SkillManager**——TUI 在看到 `/compact` 时直接转换为 `session.compact` Wire 请求，**不会**进入 SoulPlus.handlePrompt 也不会触达 SkillManager。SkillManager 永远看不到 session-control slash，这是 D4 的明确边界。

（idle 时的 `session.compact` 走 metadata-only 的 system-triggered turn，不写 synthetic `user_message`；详见 §6.4 TurnManager.handlePrompt 和 §5.1.7 runSoulTurn。）

### 15.2 Skill 定义文件

**存储位置**（优先级从低到高）：

```
内置 skills（代码注册）
↓
Plugin skills（$KIMI_HOME/plugins/<name>/skills/）
↓
用户全局 skills（$KIMI_HOME/skills/）
↓
项目级 skills（<project>/.kimi/skills/）
```

**文件格式**（Markdown + YAML frontmatter）：

```markdown
---
name: commit
description: "Review staged changes and create a commit"
execution: inline
allowed-tools: [Bash, Read]
arguments: [message]
---

Review all staged changes using `git diff --staged`.
If $message is provided, use it as the commit message.
Otherwise, generate a descriptive commit message following the project's conventions.
```

**Frontmatter 字段**：

```typescript
interface SkillDefinition {
  name: string;                     // skill 标识符，即 slash command 名
  description: string;              // 一行描述（注入 system reminder listing 给 LLM 展示用）
  execution: "inline" | "fork";     // 执行模式（默认 inline）
  allowedTools?: string[];          // 限制工具集（inline 时通过 TurnOverrides 传给 Soul）
  disallowedTools?: string[];       // 禁用的工具
  model?: string;                   // 模型覆盖（"inherit" = 继承当前模型）
  effort?: string;                  // effort 覆盖
  arguments?: string[];             // 参数名列表（$arg_name 展开用）
  hooks?: HookConfig;               // skill 级别的 hooks

  // ─── 决策 #99 / Skill 自主调用新增字段（§15.9） ───

  /**
   * 何时使用该 skill 的引导语，会和 description 拼接进 SystemReminder listing
   * 给 LLM 看（"<description> — <whenToUse>"）。推荐 1-2 句话，触发条件用动词开头。
   * 例: "Use this skill when the user asks to commit changes after editing code."
   * 决策 #99 / D-O 引导文字方案。
   */
  whenToUse?: string;

  /**
   * true 时 SkillTool.execute 会拒绝该 skill 的 LLM 自主调用（"can only be triggered by the user"），
   * skill 仍然可以通过 /name slash 由用户触发。
   * 默认 false（允许 LLM 自主调用）。
   * 用于：包含潜在副作用、需要用户明示意图的 skill（例如 /destroy / /publish）。
   * 决策 #99 / D-B explicit opt-in。
   */
  disableModelInvocation?: boolean;

  /**
   * true 时 SkillTool.execute 走 auto-allow（不弹审批）；false / 未设时按 §11 PermissionMode 判定
   * （default 模式弹审批）。
   * 默认 false。
   * 设计依据：v2 不学 CC 的 SAFE_SKILL_PROPERTIES allowlist（复杂、隐式），
   * 改为"显式 opt-in"——skill 作者明确声明这是安全的。
   * **建议**：v2 builtin skill 出厂时统一带 `safe: true`，避免首次调用都弹审批。
   * 决策 #99 / D-B B1。
   */
  safe?: boolean;
}
```

**Frontmatter 示例**：

```markdown
---
name: commit
description: Review staged changes and create a commit
when-to-use: Use this skill when the user wants to commit their work after editing code.
execution: inline
allowed-tools: [Bash, Read]
safe: true
---

Review all staged changes ...
```

### 15.3 模板变量

| 变量 | 展开为 | 示例 |
|------|--------|------|
| `$ARGUMENTS` | 完整参数字符串 | `/commit -m "fix"` → `"-m fix"` |
| `$1`, `$2` | 位置参数 | `/commit fix bug` → `$1="fix"` |
| `$arg_name` | 命名参数（frontmatter arguments 定义） | `$message="fix"` |
| `${KIMI_SKILL_DIR}` | skill 文件所在目录 | `$KIMI_HOME/skills/` |
| `${KIMI_SESSION_ID}` | 当前 session ID | `ses_xxx` |

### 15.4 执行流程

#### 15.4.1 三种 invocation_trigger 路径分类（决策 #99）

v2 把 skill 触发口径系统化为 3 种 invocation_trigger，落 wire 审计：

```typescript
type SkillInvocationTrigger =
  | "user-slash"        // 用户输入 /name（§15.4.2，handlePrompt 前缀检测）
  | "claude-proactive"  // LLM 在顶层 turn 调 SkillTool（§15.9）
  | "nested-skill";     // skill A（fork 模式）的 sub-agent 又调了 SkillTool（§15.9）
```

**关键边界**（决策 #99 / D-I）：user-slash 路径**不走 SkillTool**——保持 §15.4.2 现有 handlePrompt 直通流程，user 输入 `/commit` 立即跑（保持 Python 用户已习惯的体验）。SkillTool 仅服务 claude-proactive / nested-skill 两条路径。两条路径共享 SkillManager 解析层和审计 record schema，**下游执行机制不同**。

#### 15.4.2 user-slash 路径（既有路径）

**Inline 模式**（默认）：

```
用户输入 "/commit -m fix"
  ↓
SoulPlus.handlePrompt() 检测 "/" 前缀
  ↓
SkillManager.detectAndPrepare("/commit -m fix")
  ↓
1. 加载 skill 定义
2. 展开模板变量（$message → "fix"）
3. 构建 TurnOverrides { activeTools: [Bash, Read], model?: ... }
4. 写 skill_invoked WireRecord（invocation_trigger: "user-slash"）
  ↓
runSoulTurn({ text: expandedPrompt }, config, contextState, runtime, sink, signal, soulOverrides)
  ↓
Soul 用 overrides.activeTools 代替 contextState.activeTools（不修改 ContextState）
Soul 用 overrides.model 代替 contextState.model（不修改 ContextState）
  ↓
Turn 结束 → overrides 随 turn 自然失效（无需恢复操作）
```

**关键**：user-slash 路径**不进 §11 Permission 层**——用户主动 `/commit` 已经表达了明确意图，再弹审批是 UX 退化（参考 §15.4.1 的"保持 Python 体验"边界）。这一路径的 permission 检查仅在 skill 内部 tool（Bash / Edit 等）执行时按 §11 正常进行，对 SkillTool 本身免审。

#### 15.4.3 claude-proactive / nested-skill 路径（决策 #99 新增）

LLM 在 turn 中段自主调用 skill 走 §15.9 SkillTool：

```
（turn 已经在跑）
  ↓
LLM 调 SkillTool({ skill: "commit", args: "-m fix" })
  ↓
ToolCallOrchestrator beforeToolCall：
  - permission 检查：skill.safe === true → allow；否则 default 模式 → ask
  - approval display：kind: "skill_call"（§10.7.3）
  ↓
SkillTool.execute()
  - skillManager.detectAndPrepareByName("commit", "-m fix", { trigger: "claude-proactive" })
  - 写 skill_invoked record（invocation_trigger="claude-proactive"，query_depth=0）
  - 分派 inline / fork
  ↓
inline 模式：调 SkillInlineWriter.injectSkillPrompt → 写 user-meta message + skill_invoked
            （包裹为 <kimi-skill-loaded name="commit">...</kimi-skill-loaded>，§15.9 / D-O 防套娃）
            返回最小 ack tool_result，LLM 在下一个 step 立即看到注入内容
fork 模式：subagentHost.spawn({..., skillContext: { queryDepth+1, allowedTools, ... }})
            await sub-agent 完成，把结果文本作为 tool_result 返回 LLM
```

**nested-skill**：sub-Soul（fork 出来的 skill agent）内部又调 SkillTool 时，`queryDepth > 0` → invocation_trigger = "nested-skill"。

**深度上限**：`MAX_SKILL_QUERY_DEPTH = 3`（决策 #99 / D-E）——Phase 1 保守，超出 reject。

**Fork 模式**：

```
用户输入 "/review-pr 123"
  ↓
SkillManager.detectAndPrepare("review-pr", "123")
  ↓
skill.execution === "fork"
  ↓
subagentHost.spawn({
  parentAgentId: currentAgentId,
  agentName: "review-pr",
  prompt: expandedSkillPrompt,
  // host 内部根据 agentName 决定 activeTools / model 等参数；
  // abort 链经由父 turn 的 root signal 自然级联到新 subagent 的 scope，
  // 不需要在 SpawnRequest 里再传一次 signal（见 §6.5 / §8.2 的 SpawnRequest 定义）
})
  ↓
sub-Soul 独立运行，有自己的 ContextState
turn.begin { input_kind: "system_trigger", trigger_source: "skill_fork:review-pr" }
  ↓
结果作为 tool_result 返回主 agent 的 ContextState
```

（`SubagentHost` 是 D1 定义的 host-side 接口，由 `SoulRegistry` 实现；skill fork 走和 `AgentTool` 同一套 host 入口，不经 Runtime。详见 §6.5 / §8.2。）

### 15.5 TurnOverrides 与 ContextState 的关系（关键设计）

**TurnOverrides 不修改 ContextState**——这是避免和 config 通道（setModel）冲突的核心设计。

> 注：`ContextState` 是持久状态；`wire.jsonl` 是 session 对话状态与会话审计记录的唯一持久化真相源。

```
                  ContextState（持久状态，wire.jsonl 是 session 对话状态与会话审计记录的唯一持久化真相源）
                       │
                       │  setModel → 正常修改，落盘 model_changed
                       │
            ┌──────────┼──────────┐
            │                     │
        正常 turn              Skill turn
     Soul 直接读            Soul 优先用 TurnOverrides
     contextState.model     overrides.model ?? contextState.model
```

- `setModel` 修改 ContextState.model 并落盘 → 永久生效
- Skill 的 TurnOverrides 只在当前 turn 内通过参数传递 → 临时生效
- 两者不冲突——TurnOverrides 是"读取时覆盖"，不是"写入时修改"
- Turn 结束后 TurnOverrides 消失，ContextState 保持 setModel 设置的值

### 15.6 SkillManager

```typescript
class SkillManager {
  private skills: Map<string, SkillDefinition> = new Map();

  // 加载所有来源的 skill，按优先级合并（同名后者覆盖前者）
  loadSkills(paths: PathConfig, pluginSkills: SkillDefinition[]): void {
    // builtin → plugin → user → project
    for (const skill of allSkills) {
      this.skills.set(skill.name, skill);  // 后覆盖前
    }
  }

  // 内置 skills 列表明文排除 session-control slash（D4）
  // 这一层是 defense-in-depth——SessionControl slash 在 TUI 层就应该直接转换为
  // 对应的 Wire method，不会到达 handlePrompt / SkillManager。这里的 Set 只是最后一道
  // 编程错误兜底：即便上层漏过滤，SkillManager 也绝不 parse 这些 slash。
  private static readonly SESSION_CONTROL_SLASH: ReadonlySet<string> = new Set([
    "compact",   // → session.compact
    "cancel",    // → session.cancel
    "exit",      // → session.destroy / shutdown
    "quit",      // → session.destroy / shutdown
  ]);

  // 检测用户输入是否是 skill 调用，如果是则准备执行参数
  detectAndPrepare(userInput: string): SkillPrepareResult | null {
    if (!userInput.startsWith("/")) return null;

    const { name, args } = parseSlashCommand(userInput);
    // D4: session-control slash 永远不进 skill 路径
    if (SkillManager.SESSION_CONTROL_SLASH.has(name)) return null;

    const skill = this.skills.get(name);
    if (!skill) return null;  // 未知 skill → 返回 null，fallback 到普通 prompt

    const expandedPrompt = expandTemplateVariables(skill.content, args, skill.arguments);

    return {
      skill,
      expandedPrompt,
      // 完整 FullTurnOverrides：disallowedTools 让 skill 文件的 disallowed-tools 能流动到权限层
      overrides: {
        model: skill.model !== "inherit" ? skill.model : undefined,
        activeTools: skill.allowedTools?.filter(t => this.deps.hasTool(t)),
        disallowedTools: skill.disallowedTools,
        effort: skill.effort,
      },
    };
  }

  // 列出全部可用 skill（含 disable_model_invocation 的，主要给 user-slash 路径 / `/help` 等使用）
  listSkills(): SkillInfo[] {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      skillMdFile: s.skillMdFile,    // 决策 #99 / D-K2：listing 带 Path，让 LLM 可 Read 兜底（fail-safe）
    }));
  }

  // ─── 决策 #99 / Skill 自主调用新增方法 ───

  // SkillTool 路径专用：输入已经分离的 name + args（不带 / 前缀），并接受 trigger 元信息
  // B7：TS 接口层用 camelCase；落 wire 时 schema 转 snake_case
  detectAndPrepareByName(
    name: string,
    args: string,
    meta: { trigger: SkillInvocationTrigger; queryDepth?: number },
  ): SkillPrepareResult | null {
    if (SkillManager.SESSION_CONTROL_SLASH.has(name)) return null;
    const skill = this.skills.get(name);
    if (!skill) return null;
    const expandedPrompt = expandTemplateVariables(skill.content, args, skill.arguments);
    return {
      skill,
      expandedPrompt,
      overrides: {
        model: skill.model !== "inherit" ? skill.model : undefined,
        activeTools: skill.allowedTools?.filter(t => this.deps.hasTool(t)),
        disallowedTools: skill.disallowedTools,
        effort: skill.effort,
      },
    };
  }

  // SystemReminder listing 专用：排除 disable_model_invocation: true 的 skill
  // 决策 #99 / D-F F1：避免 LLM 看到却调不了的体验落差
  listInvocableSkills(): SkillInfo[] {
    return this.listSkills().filter(s => !s.disableModelInvocation);
  }
}
```

SkillManager 在 SoulPlus 内部，Soul 不知道它的存在。

### 15.7 Wire 事件

| method | 关键 data 字段 | 触发场景 |
|--------|---------------|---------|
| `skill.invoked` | `skill_name, execution_mode, original_input, invocation_trigger, query_depth?, sub_agent_id?` | skill 被调用（决策 #99 新增 `invocation_trigger` / `query_depth`；`sub_agent_id` 仅 fork 模式写入） |
| `skill.completed` | `skill_name, execution_mode, success, error?, invocation_trigger, query_depth?, sub_agent_id?` | skill 执行完成/失败（决策 #99 镜像同步 `invocation_trigger` / `query_depth`，保持成对） |

`invocation_trigger` 三元集（决策 #99 / §15.4.1）：
- `"user-slash"` —— 用户 `/name` 触发（既有路径，§15.4.2，不进 permission 层）
- `"claude-proactive"` —— LLM 在顶层 turn 调 SkillTool（§15.9）
- `"nested-skill"` —— skill 内嵌套调 SkillTool（query_depth > 0，§15.9）

落盘为 `SkillInvokedRecord` 和 `SkillCompletedRecord`（schema 见附录 B）。inline 模式的 `TurnOverrides` 临时覆盖不落盘（纯参数传递）。

**有始有终**：`skill.invoked` + `skill.completed` 构成一对。

### 15.8 边界场景

| 场景 | 处理方式 |
|------|---------|
| 未知 skill（/不存在的名字） | SkillManager 返回 null → fallback 到普通 prompt（不报错） |
| Soul busy 时收到 /skill | handlePrompt 拒绝（"agent_busy"） |
| Skill 的 allowed-tools 包含不存在的工具 | 在 TurnOverrides 构建时过滤掉不存在的工具名 |
| Cancel 正在执行的 skill | 走正常 abort 路径，TurnOverrides 随 turn 自然失效 |
| Skill 嵌套（skill A 触发 skill B） | 通过 depth tracking 检测，`MAX_SKILL_QUERY_DEPTH = 3` 硬上限（决策 #99） |
| Compaction 后 skill prompt 丢失 | 不需要特殊处理，和普通 user_message 一样被摘要 |
| LLM 输出 `/skill:name` 文本回退 | SkillTool description 明确禁止（§15.9.5），引导 LLM 走 tool 调用而不是文本输出 |
| LLM 把 SkillTool 套娃调 | inline wrapper `<kimi-skill-loaded name="X">` + SkillTool description anti-loop guard 双保险（§15.10.4） |
| Hot-reload 后 LLM 看到多份 listing | "DISREGARD any earlier" header 让 LLM 以最新为准（§15.10.3） |

### 15.9 SkillTool（决策 #99 / Skill 自主调用）

#### 15.9.1 定位：协作工具族（D11），不是普通 builtin

按 §10.3.1 协作工具族的定义，SkillTool 是"调起另一段 LLM 行为"的入口（不是原子能力），通过 host-side constructor 注入依赖（SkillManager / SkillInlineWriter / SubagentHost），和 `AgentTool` / Team Mail tool 平级。

**§10.3.1 表格补充**（决策 #99）：

| Tool | 归属 | host-side 注入的依赖 | 说明 |
|---|---|---|---|
| `SkillTool` | 协作工具族 | `SkillManager` + `SkillInlineWriter`（inline）+ `SubagentHost`（fork） | 让 Soul 在 turn 中自主调用已注册的 skill；user-slash 路径不走本 tool（§15.4.2） |

**注册路径**：在 SoulPlus 装配时构造，主 Soul / sub-Soul 各装一份（不同 `parentAgentId` / `queryDepth`），加入 ToolRegistry。详见 §15.9.6。

**默认对 LLM 可见**（决策 #99 / D-A A1）——v2 的核心问题就是 Soul 当前调不了 skill；默认隐藏等于没解决。少数嵌入场景如不需要 skill，host 不 `new SkillTool` 即可（D11 嵌入屏蔽路径）。

#### 15.9.2 接口定义

```typescript
const SkillToolInputSchema = z.object({
  skill: z.string()
    .describe('Skill name to invoke, e.g. "commit", "review-pr". No leading slash.'),
  args: z.string().optional()
    .describe('Optional argument string, parsed by the skill itself (e.g. "-m \'fix\'" or "1234").'),
});
type SkillToolInput = z.infer<typeof SkillToolInputSchema>;

// 输出：discriminated union，inline / fork 两形态
type SkillToolOutput =
  | { mode: "inline"; skill_name: string; injected: true }
  | { mode: "fork"; skill_name: string; sub_agent_id: string; result: string };
```

**inline 输出设计差异 vs CC**：CC 通过 tool 的 `newMessages` 副作用注入对话；v2 没有 `newMessages` 接口（§10.2 窄接口），改为：**SkillTool.execute 内部直接调 SkillInlineWriter.injectSkillPrompt 写 ContextState**，返回最小 ack tool_result。LLM 在下一个 step 的 buildMessages 立刻能看到注入内容。

**tool_result 文本极简**（决策 #99 / D-J J1）：inline 返回 `"Skill X loaded; follow the instructions now."`；fork 返回 forked agent 的输出文本——LLM 对自然语言更敏感，inline 真正内容在注入的 user-meta message 里。

#### 15.9.3 执行流程

```typescript
class SkillTool implements Tool<SkillToolInput, SkillToolOutput> {
  readonly name = "Skill";
  readonly description = SKILL_TOOL_DESCRIPTION; // 见 §15.9.5

  constructor(
    private readonly skillManager: SkillManager,
    private readonly contextWriter: SkillInlineWriter,    // §15.11
    private readonly subagentHost: SubagentHost,
    private readonly parentAgentId: string,
    private readonly queryDepth: number = 0,
  ) {}

  async execute(toolCallId, args, signal, onUpdate) {
    const skillName = args.skill.replace(/^\//, '');  // 兼容 LLM 偶尔加 /
    const trigger: SkillInvocationTrigger = this.queryDepth > 0 ? "nested-skill" : "claude-proactive";

    const prepared = this.skillManager.detectAndPrepareByName(
      skillName, args.args ?? '',
      { trigger, queryDepth: this.queryDepth },
    );
    if (!prepared) {
      return { isError: true, content: `Unknown skill: ${skillName}`, output: undefined };
    }

    // disableModelInvocation 闸门（§15.2 / 决策 #99）
    if (prepared.skill.disableModelInvocation) {
      return {
        isError: true,
        content: `Skill "${skillName}" can only be triggered by the user, not by the model.`,
        output: undefined,
      };
    }

    if (prepared.skill.execution === "fork") {
      return await this.executeFork(prepared, signal, onUpdate);
    }
    return await this.executeInline(prepared, signal);
  }

  // ─── Display hint（决策 #98 / Tool UI 渲染契约，§10.7） ───
  display = {
    getUserFacingName: (input) => input?.skill ? `Skill: ${input.skill}` : "Skill",
    getActivityDescription: (input) =>
      input?.skill ? `Running skill /${input.skill}` : "Running skill",
    getInputDisplay: (input) => ({
      kind: "skill_call" as const,
      skill_name: input.skill,
      arguments: input.args,
    }),
    // SkillTool 通常没有专属 result_display（inline 走默认 "text" fallback；fork 返回 agent_summary
    // 由 orchestrator 自动选；这里不强制覆盖）
  };
}
```

**inline 路径**：

```typescript
private async executeInline(prepared, signal): Promise<ToolResult<SkillToolOutput>> {
  signal.throwIfAborted();
  await this.contextWriter.injectSkillPrompt({
    skillName: prepared.skill.name,
    expandedPrompt: prepared.expandedPrompt,
    invocationTrigger: this.queryDepth > 0 ? "nested-skill" : "claude-proactive",
    queryDepth: this.queryDepth,
    overrides: prepared.overrides,
  });
  return {
    content: `Skill "${prepared.skill.name}" loaded. ` +
             `Its instructions are now in the conversation; follow them directly.`,
    output: { mode: "inline", skill_name: prepared.skill.name, injected: true },
  };
}
```

**关键约束**（决策 #99 / D-D D1 软约束）：inline 模式 **TurnOverrides 不直接影响当前 turn**——当前 turn 的 SoulConfig.tools / model 已经固定，无法在 turn 中段切换（违反决策 #50）。allowedTools / disallowedTools 信息一并写进注入的 user-meta 引导文字（"This skill expects to use only Bash / Read"），靠 LLM 自觉。**硬权限需求的 skill 应该用 fork 模式**。

**fork 路径**：

```typescript
const MAX_SKILL_QUERY_DEPTH = 3;  // 决策 #99 / D-E E1

private async executeFork(prepared, signal, onUpdate): Promise<ToolResult<SkillToolOutput>> {
  if (this.queryDepth >= MAX_SKILL_QUERY_DEPTH) {
    return {
      isError: true,
      content: `Skill recursion depth limit (${MAX_SKILL_QUERY_DEPTH}) reached.`,
      output: undefined,
    };
  }

  const handle = await this.subagentHost.spawn({
    parentAgentId: this.parentAgentId,
    agentName: `skill:${prepared.skill.name}`,
    prompt: prepared.expandedPrompt,
    description: prepared.skill.description,
    model: prepared.overrides.model,
    // 决策 #99：透传 skill 元信息给子 Soul，便于子 SkillTool 实例正确装配
    // B7：TS 接口层 camelCase；落 wire record 时由 schema 转 snake_case
    skillContext: {
      queryDepth: this.queryDepth + 1,
      allowedTools: prepared.overrides.activeTools,
      disallowedTools: prepared.overrides.disallowedTools,
    },
  });
  const result = await handle.completion;
  return {
    content: result.text ?? "Skill (forked) completed.",
    output: {
      mode: "fork",
      skill_name: prepared.skill.name,
      sub_agent_id: handle.agentId,
      result: result.text ?? "",
    },
  };
}
```

`SpawnRequest` 新增可选 `skillContext?: { queryDepth: number; allowedTools?: string[]; disallowedTools?: string[] }`（§6.5 / §8.2，TS 接口层 camelCase；落 wire record 时由 schema 转 snake_case）；`SubagentHost.spawn` 在装配子 SoulConfig.tools 时按 allowed/disallowed 过滤，并新建子 SkillTool 实例时传 `queryDepth = skillContext.queryDepth`。

**fork mode subagent_type 边界**（v2 vs Python 经验）：v2 SkillTool fork **不借用 AgentTool 的 `subagent_type` 体系**——subagent_type 决定 toolset/model 默认值（`coder` / `general` 等），skill name 决定 prompt + 可选 overrides，两者**不同维度**保持正交。`agentName: "skill:<name>"` 是用于 UI 标识 + Wire 审计的命名约定，不是 subagent_type。

#### 15.9.4 Permission 集成（§11）

SkillTool 受 §11 Permission 系统管。`beforeToolCall` 闭包评估时：

| 条件 | 行为 |
|---|---|
| skill 不存在 | 不进 permission 层（SkillTool.execute 自己 isError 返回） |
| skill `disableModelInvocation: true` | 不进 permission 层（execute 自己拒绝） |
| skill `safe: true` | 在 PermissionRule 匹配阶段，命中 turn-override `allow Skill(<skill_name>)` rule → allow |
| skill 没设 `safe` 且 PermissionMode = `default` | `ask` → 弹审批 |
| skill 没设 `safe` 且 PermissionMode = `auto` | `allow`（按 §11.2） |
| 任何 deny rule 命中 | deny |
| `invocation_trigger == "user-slash"` | **不进 permission 层**（决策 #99 / D-I 边界——保留 Python 用户 `/commit` 立即跑的体验，§15.4.2 直通流程） |

**PermissionRule 字段匹配**：复用 §11.3.1 `RuleMatcher`，匹配字段 `Skill(<skill_name>)`：

```
"Skill(commit)"        → 允许 SkillTool 调 commit
"Skill(review-*)"      → 允许所有 review-* 前缀的 skill
"Skill"                → 允许所有 skill
```

`fieldMatcher.field` 取 `args.skill`。

**inline 注入的 user-meta message 不触发额外 permission**——它是 SkillTool.execute 的副作用，permission 已经在 SkillTool 上做过一次。fork 模式的 sub-agent 有自己的 PermissionRule 集合，由 SubagentHost 在装配子 SoulConfig 时把 skill 的 `allowedTools` / `disallowedTools` 转换为 turn-override rules。

#### 15.9.5 SkillTool.description（引导 LLM 何时调）

完整文本（决策 #99 / D-O 落地）——实施时直接 copy，禁止改动语义：

```
Execute a skill within the main conversation.

A skill is a reusable, composable capability defined by a SKILL.md file. Each skill bundles
domain knowledge, workflows, scripts, and reference material that you can use to handle a
specific kind of task more reliably than from first principles.

When the user asks you to do something, check the available skill listing (delivered via
system-reminder messages). If any skill's description or "when to use" criteria match the
request, this is a BLOCKING REQUIREMENT: invoke the matching skill via this tool BEFORE
writing any other response about the task. Do not paraphrase the skill, do not mention it in
prose, and never reply with "/skill:<name>" or "/<name>" text — that is a deprecated
invocation syntax and the user will not see it execute. The only way to actually run a skill
is to call this tool.

How to invoke:
- Set `skill` to the exact skill name from the listing (no leading slash, no `skill:` prefix).
- Optionally pass `args` as a single string of free-form arguments the skill expects.
- Examples:
  - `skill: "commit"` — run the commit skill with no args
  - `skill: "commit", args: "-m 'Fix login bug'"` — run with arguments
  - `skill: "pull-request", args: "draft"`
  - `skill: "frontend-design:landing-page"` — fully-qualified plugin skill name

When NOT to invoke:
- The user is only asking what a skill does, not asking you to run it. In that case, use the
  `Path` field from the listing to Read the SKILL.md file and summarize it. Do not invoke the
  skill just to inspect it.
- The skill is already running (a `<kimi-skill-loaded name="X">` tag is present in the
  current turn — see below).
- The request maps to a built-in slash command like `/help`, `/clear`, `/compact` — those are
  not skills.

Anti-loop guard:
- When a skill is loaded inline, its SKILL.md content is injected into the conversation
  wrapped as `<kimi-skill-loaded name="<skillName>">…</kimi-skill-loaded>`. If you see this
  tag for a skill in the current turn, the skill is ALREADY active — follow its instructions
  directly. Do NOT call this tool again for the same skill in the same turn (it will recurse).

Listing freshness:
- Multiple "Available skills" system-reminders may appear in the conversation if skills were
  hot-reloaded. ALWAYS treat the most recent one as authoritative and ignore earlier ones; a
  skill present in an old listing but missing from the latest may have been removed.
```

**关键设计要点**：
1. **BLOCKING REQUIREMENT** + **NEVER reply with `/skill:<name>`**——直接对治 Python 用户痛点（Python 模型常输出 `/skill:xxx` 文本而不真正调用）
2. **"When NOT to invoke" 第一条**：拆出"只问不做"场景 → Read SKILL.md，配合 listing 的 Path 字段
3. **Anti-loop guard**：`<kimi-skill-loaded name="X">` tag 检测，与 §15.10.4 inline wrapper 双保险
4. **Listing freshness**：v2 独创，处理 hot-reload 后 LLM 可能看到多份过时 listing

#### 15.9.6 注册路径

```typescript
// 在 SoulPlus 装配阶段（参照 §6.5 SoulRegistry / §8.2 SubagentHost）
const skillTool = buildSkillTool({
  parentAgentId: "main",
  queryDepth: 0,
  fullContextState: this.journal.contextState,
  sessionJournal: this.journal.sessionJournal,
  skillManager: this.components.skillManager,
  subagentHost: this.components.soulRegistry,
});
this.infra.toolRegistry.register(skillTool);
```

子 Soul 启动时 `buildSkillTool({ parentAgentId: subAgentId, queryDepth: parent.queryDepth + 1, ... })`，加入子 SoulConfig.tools。`buildSkillTool` 内部组装 `SkillInlineWriter` facade（§15.11）。

### 15.10 SystemReminder 注入 + Hot-reload（决策 #99 / D-C C1 + D-L 策略 1）

#### 15.10.1 注入位置：ContextState SystemReminder（durable）

按 §4.7 + §4.5.2 的设计，"LLM 看得到的内容" 必须走 ContextState durable 写入；ConversationProjector 不接受 turn-scope 临时参数（Phase 6E 撤销 `ephemeralInjections`）。

所以 skill listing 的注入路径是 **复用 SystemReminder 路径**——写 `SystemReminderRecord` 到 ContextState，Projector 投影时自动 wrap 为 `<system-reminder>...</system-reminder>` 包裹的系统消息（和 CC 对齐）。

> **vs Python C2**：Python 选 `${KIMI_SKILLS}` system prompt 模板变量，4 个月稳定运行。v2 选 C1 是为了支持后续 dynamic skill add（plugin reload）的增量 publish；如果 v2 不打算做 plugin hot-reload，C2 是更简单且经过验证的方案。Phase 1 决策走 C1，原因：v2 §3.6 已规划 plugin hot-reload 路径，需要"以最新为准"的 reminder 机制。

#### 15.10.2 SkillListingPublisher

```typescript
// SoulPlus 服务层组件，启动时和每次 SkillManager 状态变化时调
class SkillListingPublisher {
  constructor(
    private readonly skillManager: SkillManager,
    private readonly fullContextState: FullContextState,
  ) {}

  /** 启动时一次性 publish 完整 listing。 */
  async publishInitial(): Promise<void> {
    const listing = this.formatSkillListing(this.skillManager.listInvocableSkills(), { isDelta: false });
    if (!listing) return;
    await this.fullContextState.appendSystemReminder({
      content: listing,
      tag: "skill_listing",   // 用于审计/dedup（不影响 LLM 投影）
    });
  }

  /** Hot-reload 后调（决策 #99 / D-L 策略 1：全量重发）。 */
  async publishDelta(): Promise<void> {
    const listing = this.formatSkillListing(this.skillManager.listInvocableSkills(), { isDelta: true });
    await this.fullContextState.appendSystemReminder({
      content: listing,
      tag: "skill_listing",
    });
  }

  private formatSkillListing(skills: SkillInfo[], opts: { isDelta: boolean }): string { /* §15.10.3 */ }
}
```

#### 15.10.3 listing 格式（决策 #99 / D-O 引导文字落地）

**初始 listing** 模板：

```
The following skills are available for use with the Skill tool. Each entry shows the skill
name, its SKILL.md path (so you can Read it to inspect what the skill does without running
it), and a description.

- {name}
  - Path: {absolute_path_to_SKILL.md}
  - Description: {description} [— {whenToUse if present}]
- ...

To run a skill, call the Skill tool with `skill: "<name>"` and any args. Do NOT reply with
"/skill:<name>" or "/<name>" text — only the Skill tool call actually executes a skill. Use
the Path field only to Read SKILL.md when you need to preview a skill's contents (for example,
when the user is asking what the skill does rather than asking you to run it).
```

**字段填充与截断规则**：

| 字段 | 来源 | 截断规则 |
|---|---|---|
| `{name}` | `SkillDefinition.name` | 不截断 |
| `{absolute_path_to_SKILL.md}` | `SkillDefinition.skillMdFile`（绝对路径，决策 #99 / D-K K2 / D-M `${KIMI_HOME}` 模板可在 UI 层渲染时反向替换） | 不截断；落入预算时优先保留 |
| `{description}` | `SkillDefinition.description` | 与 whenToUse 拼接后 hard cap = `MAX_LISTING_DESC_CHARS`（v2 取 250，与 CC 对齐） |
| `{whenToUse}` | `SkillDefinition.whenToUse`（可选） | 同上，拼接为 `{description} — {whenToUse}` |

**Path 字段的 fail-safe 设计**（决策 #99 / D-K K2）：保留 Path 让 LLM 既可以走 SkillTool 主路径，也可以走 Read SKILL.md 兜底——SkillTool 出问题时不至于 skill 完全不可用。Phase 1 listing footer 明确"Use Path only to Read SKILL.md when you need to preview a skill's contents"，引导 LLM 主路径仍走 tool。

**预算溢出降级**（参考 CC `formatCommandsWithinBudget`）：
1. **Level 1（正常）**：完整三行格式
2. **Level 2（trim）**：description 截断至 `maxDescLen`（按剩余预算 / skill 数计算），Path 保留
3. **Level 3（极端）**：仅 `- {name}\n  - Path: {path}`（去掉 Description 行，但保留 Path——LLM 还能 Read 兜底）

> 与 CC 的差异：CC Level 3 退化为 `- {name}` 单行（CC 不允许 Read），v2 必须保留 Path 行——这是 fail-safe 的核心承诺。

**Hot-reload Delta listing**（决策 #99 / D-L 策略 1：每次 hot-reload 都重发**完整 listing**）：

```
The following skills changed (hot-reload). DISREGARD any earlier "Available skills"
system-reminders in this conversation; this listing reflects the current authoritative skill
set, and any skill not listed here is no longer available.

- {name}
  - Path: {...}
  - Description: ...
- ...

To run a skill, call the Skill tool. Use Path only to Read SKILL.md for inspection, not to
execute the skill.
```

**为什么用 "DISREGARD any earlier"**：
- LLM 看到多份 system-reminder 时没有时间戳意识；显式让它"以最新为准"是最稳的做法
- "any skill not listed here is no longer available" 防止 LLM 凭旧 listing 调一个已经被删的 skill
- 即使没有 removed 的 skill，header 那句也要保留——这是反复提醒机制，不能省

**实施细节**：
- 旧的 SystemReminderRecord 不删除（违反 ContextState durable 原则），靠 LLM 自觉以最新为准
- 如果担心多份 listing 占预算，Phase 2 可走"删除旧 reminder record（用 SkillListingObsoletedRecord）"路径——Phase 1 不做，靠引导文字解决

#### 15.10.4 inline 注入消息的 wrapper 格式（`<kimi-skill-loaded>` 防套娃）

当 LLM 调用 `SkillTool({ skill: "commit", args: "..." })` 触发 inline 模式时，`SkillInlineWriter.injectSkillPrompt` 把 SKILL.md 内容包成以下结构作为 user-meta message 写入 ContextState：

```
<kimi-skill-loaded name="{skillName}" args="{escapedArgs}">
{SKILL.md 完整内容}

---

User-supplied args (raw): {args}

Follow the instructions above to handle the user's request. The skill is now ACTIVE in this
turn — do NOT call the Skill tool again for "{skillName}" in this turn (that would recurse).
When the skill's task is complete, return control to the main conversation by responding to
the user normally.
</kimi-skill-loaded>
```

**关键 invariants**：
1. `name=` 属性必须出现——SkillTool description anti-loop guard 检测的就是这个 tag
2. `args=` 属性可省略；当 args 为空字符串时也写 `args=""`
3. **trailing footer 那句话必须每次都写**——双保险，配合 SkillTool description 的 anti-loop guard 形成两道防线
4. **escapedArgs**：使用 XML attribute 转义（`&` → `&amp;`、`"` → `&quot;`、`<` → `&lt;`）

**`<kimi-skill-loaded>` tag 的 export filter 约束**：
- `/export` 导出会话时**必须保留**这个 tag（不能 strip），否则 LLM 在 import 后会失去回路防护
- `/import` / replay 时同样保留
- `<kimi-skill-loaded>` 与 §3.6.1 的 `<notification>` tag（Python CHANGELOG 1.26.x bugfix）走同一个白名单机制
- UI 渲染时可以 unwrap 显示——这是 UI 层关注，与 LLM 引导无关

### 15.11 SkillInlineWriter facade

`SkillInlineWriter` 是 SkillTool 的 host-side 注入依赖（§15.9.6），把 inline 模式需要的两件事打包成一个窄接口：

```typescript
// 给 SkillTool 用的 ContextState 注入 facade
// 由 buildSkillTool 在 SoulPlus 装配阶段构造，SkillTool 看不到 FullContextState 全貌
interface SkillInlineWriter {
  /**
   * 把展开后的 skill prompt 作为一条 user-meta message append 到当前 ContextState；
   * 同时写 skill_invoked SessionJournal record（落 wire 时 invocation_trigger / query_depth 走 snake_case）。
   *
   * 调用方式：返回前 await 完成；保证 LLM 在下一个 step 的 buildMessages 立刻能看到注入内容。
   *
   * 命名约定（B7）：TS 接口层用 camelCase；落 wire record 时由 schema 转 snake_case。
   */
  injectSkillPrompt(args: {
    skillName: string;
    expandedPrompt: string;
    invocationTrigger: SkillInvocationTrigger;
    queryDepth: number;
    overrides: SkillOverrides;
  }): Promise<{ skillInvokedSeq: number }>;
}

// buildSkillTool 内部组装：
function buildSkillTool(opts: {
  parentAgentId: string;
  queryDepth: number;
  fullContextState: FullContextState;
  sessionJournal: SessionJournal;
  skillManager: SkillManager;
  subagentHost: SubagentHost;
}): SkillTool {
  const writer: SkillInlineWriter = {
    async injectSkillPrompt(args) {
      // 1. 用 <kimi-skill-loaded> 包裹（§15.10.4）
      const wrapped = formatKimiSkillLoadedWrapper(args.skillName, args.expandedPrompt, args.overrides);

      // 2. 决策 #99 / D-H H1：用 appendUserMessageMeta(...) 注入（§4.5.2 已明确定义）
      //    选 H1 是因为 CC 在生产中验证过 user-meta 形态对 LLM 自然程度最高；
      //    user-meta 也对齐 §4.5.2 现有的 "isMeta user message" 惯例。
      //    appendUserMessageMeta 是 §4.5.2 FullContextState 上的 SoulPlus 独占写方法——
      //    投影到 LLM 时仍是 user role，但 export/import/replay 路径会过滤掉 isMeta=true 的消息。
      await opts.fullContextState.appendUserMessageMeta(
        { text: wrapped },
        { tag: "kimi-skill-loaded" },
      );

      // 3. 写 skill_invoked SessionJournal record（落 wire 时字段为 snake_case）
      //    B7 命名约定：appendSkillInvoked 接受 wire-shape 字段（snake_case）。
      const seq = await opts.sessionJournal.appendSkillInvoked({
        skill_name: args.skillName,
        execution_mode: "inline",
        invocation_trigger: args.invocationTrigger,
        query_depth: args.queryDepth,
        original_input: args.expandedPrompt,
      });
      return { skillInvokedSeq: seq };
    },
  };

  return new SkillTool(
    opts.skillManager, writer, opts.subagentHost,
    opts.parentAgentId, opts.queryDepth,
  );
}
```

**SkillInlineWriter 不是新接口爆炸**——它是 facade，没有引入新的"种类"，只是把"写 user-meta message + 写 skill_invoked"两步打包成 SkillTool 唯一需要的 host-side 能力，与 §10.3.1 的协作工具族 host-side 注入原则一致（AgentTool 用 SubagentHost、Team Mail 用 TeamMailPublisher、SkillTool 用 SkillInlineWriter）。

### 15.12 与 ConversationProjector 的关系（§4.7 cross-reference）

§4.7 ConversationProjector 不接受 turn-scope 注入，纯读 ContextSnapshot。Skill listing 通过 `SystemReminderRecord` 走 §4.5.2 durable 写入路径，projector 自然从 snapshot 读出并组装为 `<system-reminder>` 包裹的系统消息——**skill listing 是 SystemReminder 的典型 use case**，和 NotificationManager / 未来 MemoryRecall 走同一条路径，无需任何 projector 侧改动。

### 15.13 Path 白名单（KIMI_SKILL_DIR）

为支持 LLM 从 listing 的 Path 字段 Read SKILL.md（§15.10.3 fail-safe 路径），Read / Glob 工具必须把 skill 根目录加入访问白名单（决策 #99 / D-N N1）：

| 路径模板（决策 #99 / D-M `${KIMI_HOME}` 模板） | 用途 |
|---|---|
| `${KIMI_HOME}/skills/` | 用户全局 skills |
| `${PROJECT}/.kimi/skills/` | 项目级 skills |
| `${KIMI_HOME}/plugins/<name>/skills/` | Plugin skills |

**注意**：白名单只加 skill 根目录之外的部分（已经在 workspace 内的 project 级 skills 不需要重复加，避免和 §17 PathConfig 冲突）。Phase 1 实现时 Read / Glob 工具通过 `PathConfig.skillsRoots(): string[]` 拿到这些根目录，与 workspace 白名单合并。

> **Python 教训 3 吸取**（CHANGELOG 1.27.0：`Glob: Allow Glob tool to access skills directories`）：Python 已踩过坑——Glob 默认只能搜 workspace，导致 LLM 看到 skill listing 但 Glob 不到 SKILL.md。v2 Phase 1 直接把 skills 根目录加入白名单。

---

## 十六、Plugin 系统

### 16.1 Plugin 的定义

**Plugin 是一个扩展包**，可以注入 Tools、MCP Servers、Hooks、Agent 定义到 Kimi CLI 中。

### 16.2 Plugin 目录结构

```
my-plugin/
├── plugin.json              # 主清单（必需）
├── tools/                   # 工具脚本（子进程执行）
│   └── greet.py
├── skills/                  # Skill 定义（Markdown）
│   └── my-skill.md
├── agents/                  # Agent 定义（Markdown）
│   └── reviewer.md
├── hooks.json               # Hook 配置（可选）
└── mcp.json                 # MCP Server 声明（可选）
```

**plugin.json**：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "示例插件",
  "tools": [
    {
      "name": "greet",
      "description": "生成问候",
      "command": ["python3", "tools/greet.py"],
      "parameters": {
        "type": "object",
        "properties": { "name": { "type": "string" } }
      }
    }
  ],
  "inject": { "api_key": "api_key" }
}
```

### 16.3 Plugin 能注入什么

| 能力 | 来源 | 加载时机 |
|------|------|---------|
| **Tools** | `plugin.json` 的 `tools` 数组 | 启动时注册到 SoulPlus.toolRegistry |
| **Skills** | `skills/` 目录下的 .md 文件 | 启动时注册到 SkillManager |
| **Agent 定义** | `agents/` 目录下的 .md 文件 | 启动时注册到 AgentDefinitions |
| **MCP Servers** | `mcp.json` | 启动时连接 |
| **Hooks** | `hooks.json` | 启动时注册到 HookEngine |

### 16.4 Plugin Tool 执行

Plugin 定义的工具通过子进程执行：

```typescript
// 参数通过 stdin JSON 传入
// 结果通过 stdout 返回
// 超时：120 秒
// 环境变量：inject 映射的 host values（API key, base URL）
```

参考 kimi-cli 现有的 `PluginTool` 实现。

### 16.5 Plugin 安装

第一阶段只支持：
- **本地目录**：`kimi-core plugin install /path/to/plugin`
- **Git URL**：`kimi-core plugin install https://github.com/user/plugin.git`

不做 Marketplace / 远程 registry。

安装目录：`$KIMI_HOME/plugins/<name>/`

> 全文二进制命名统一使用 `kimi-core`（和 §19.2.1 `kimi-core migrate` 一致），早期稿中混用的 `kimi plugin` / `kimi-cli plugin` 均已收敛。

### 16.6 Plugin 与 Host Values

Plugin 安装时通过 `inject` 映射将 host values（API key、base URL 等）写入 plugin 的配置文件。运行时通过环境变量传给 tool 子进程。

---

## 十七、路径配置（KIMI_HOME）

### 17.1 设计原则

**零硬编码路径**：代码中不允许出现 `~/.kimi` 字面量。所有路径通过 `PathConfig` 服务获取。

**单一配置源**：只有一个环境变量 `KIMI_HOME` 控制所有路径。其余路径从 `KIMI_HOME` 派生，不可独立覆盖。

**完全实例隔离**：不同 `KIMI_HOME` 值的 Kimi CLI 实例之间完全独立——不共享 sessions、config、SQLite、temp 文件、socket 文件。同一个 agent team 的所有成员共享同一个 `KIMI_HOME`。

### 17.2 目录结构

```
KIMI_HOME (默认: ~/.kimi，通过环境变量 KIMI_HOME 或 CLI 参数 --home 覆盖)
├── config.json              # 全局配置
├── team_comms.db            # SQLite 消息总线（同 KIMI_HOME 下的所有 team 共享）
├── mcp.json                 # 用户级 MCP 配置（决策 #100，§17A）
├── auth/                    # OAuth token 持久化（mode 0700）
│   └── mcp/
│       └── <serverId>.json  # 单 server token（mode 0600，决策 #100 / D-MCP-7）
├── skills/                  # 用户全局 skills（决策 #99 / §15.13 白名单）
│   └── <skill-name>/
│       └── SKILL.md
├── plugins/                 # plugin 安装目录
│   └── <plugin-name>/
│       ├── mcp.json         # plugin 注入的 MCP 配置（决策 #100，§17A.7.2）
│       └── skills/          # plugin 提供的 skills
├── sessions/                # 所有 session 数据
│   └── <session_id>/
│       ├── wire.jsonl       # session 对话状态与会话审计记录的唯一持久化真相源（D15）
│       ├── wire.1.jsonl     # compaction 归档（可选）
│       ├── state.json       # session 缓存
│       ├── tool-results/    # 决策 #96 Tool Result Budget 持久化目录
│       │   └── <tool_use_id>.txt
│       └── subagents/       # in-process subagent 数据
│           └── <sub_id>/
│               ├── wire.jsonl
│               └── state.json   # 由子 SoulPlus 的 SessionMetaService 维护（决策 #113）；
│                                # session_meta.changed 事件冒泡到主 EventBus 时由
│                                # SoulRegistry wrapper 注入 source: { kind: "subagent", id, name }
├── teams/                   # agent team 注册信息（可选）
│   └── <team_id>/
│       └── registry.json
└── tmp/                     # 临时文件（不使用系统 /tmp，保证隔离）
```

**项目级路径**（基于 cwd / workDir）：
- `<workDir>/.kimi/skills/` —— 项目级 skills（决策 #99）
- `<workDir>/.kimi/mcp.json` —— 项目级 MCP 配置（决策 #100）

**企业级路径**（决策 #100 / D-MCP-6）：
- macOS: `/Library/Application Support/Kimi/managed-mcp.json`
- Linux: `/etc/kimi/managed-mcp.json`
- Windows: `%ProgramData%\Kimi\managed-mcp.json`

### 17.3 PathConfig 服务

```typescript
class PathConfig {
  readonly home: string;

  constructor(args?: { home?: string }) {
    // 优先级：CLI 参数 > 环境变量 > 默认值
    this.home = args?.home
      ?? process.env.KIMI_HOME
      ?? path.join(os.homedir(), '.kimi');
  }

  // === 派生路径（全部从 home 计算，不可独立覆盖）===

  get sessionsDir(): string {
    return path.join(this.home, 'sessions');
  }

  get sqlitePath(): string {
    return path.join(this.home, 'team_comms.db');
  }

  get configPath(): string {
    return path.join(this.home, 'config.json');
  }

  get tmpDir(): string {
    return path.join(this.home, 'tmp');
  }

  sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId);
  }

  wirePath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'wire.jsonl');
  }

  statePath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'state.json');
  }

  subagentDir(sessionId: string, subId: string): string {
    return path.join(this.sessionDir(sessionId), 'subagents', subId);
  }

  archivePath(sessionId: string, n: number): string {
    return path.join(this.sessionDir(sessionId), `wire.${n}.jsonl`);
  }

  // ─── 决策 #99 / Skill 自主调用：Read / Glob 工具的 skill 根白名单（§15.13） ───
  // Phase 1 把 skill 根目录加入访问白名单，让 LLM 从 listing 的 Path 字段 Read SKILL.md（fail-safe 路径）
  // 不重复 workspace 内已有的根（project 级 skills 已在 work_dir 内时跳过）
  skillsRoots(workDir?: string): string[] {
    const roots = [
      path.join(this.home, 'skills'),                  // 用户全局 skills（${KIMI_HOME}/skills/）
      path.join(this.home, 'plugins'),                 // plugin skills 根目录（${KIMI_HOME}/plugins/<name>/skills/ 由 plugin loader 单独加）
    ];
    // 项目级 skills 路径由调用方按 ${PROJECT}/.kimi/skills/ 自行计算并合并
    if (workDir) {
      roots.push(path.join(workDir, '.kimi', 'skills'));
    }
    // 去重 + 跳过已在 workspace 内的（避免和工作区白名单重复）
    return Array.from(new Set(roots));
  }

  // ─── 决策 #100 / MCP 集成：Phase 1 必做路径派生（§17A） ───

  // 用户级 MCP 配置文件
  mcpConfigPath(): string {
    return path.join(this.home, 'mcp.json');
  }

  // 项目级 MCP 配置文件（基于 workDir）
  mcpProjectConfigPath(workDir: string): string {
    return path.join(workDir, '.kimi', 'mcp.json');
  }

  // OAuth token 持久化目录（mode 0700）
  mcpAuthDir(): string {
    return path.join(this.home, 'auth', 'mcp');
  }

  // 单 server OAuth token 文件（mode 0600，决策 #100 / D-MCP-7：不加密，靠文件权限）
  mcpAuthPath(serverId: string): string {
    return path.join(this.mcpAuthDir(), `${serverId}.json`);
  }

  // 企业策略文件（决策 #100 / D-MCP-6：平台相关路径）
  enterpriseMcpConfigPath(): string {
    if (process.platform === 'darwin') {
      return '/Library/Application Support/Kimi/managed-mcp.json';
    }
    if (process.platform === 'win32') {
      return path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Kimi', 'managed-mcp.json');
    }
    return '/etc/kimi/managed-mcp.json';   // linux 默认
  }

  // Plugin 注入的 MCP 配置文件
  pluginMcpConfigPath(pluginName: string): string {
    return path.join(this.home, 'plugins', pluginName, 'mcp.json');
  }
}
```

### 17.4 注入方式

PathConfig 在进程启动时创建一次，注入到所有需要路径的组件：

```typescript
// 进程启动（main.ts）
const paths = new PathConfig({ home: cliArgs.home });

// 注入到 SessionManager → SoulPlus → JournalWriter → ...
const sessionManager = new SessionManager(paths);
const soulPlus = new SoulPlus(sessionId, paths);
const journalWriter = new JournalWriter(paths.wirePath(sessionId));
const sqliteDb = new SQLiteDb(paths.sqlitePath);
```

### 17.5 并行实例场景

```bash
# 实例 A（开发用）
KIMI_HOME=~/.kimi-dev kimi-core ...

# 实例 B（测试用）
KIMI_HOME=~/.kimi-test kimi-core ...

# 实例 C（默认）
kimi-core ...  # KIMI_HOME=~/.kimi
```

三个实例各自有独立的 sessions、SQLite、config。完全不互通。

**Agent team 成员**始终共享 leader 的 `KIMI_HOME`（leader spawn 成员时不需要额外传 SQLite 路径——因为同 KIMI_HOME 下自然共享同一个 `team_comms.db`）：

```bash
# Leader spawn member（同一个 KIMI_HOME）
kimi-core --home "$KIMI_HOME" --team-id "team_ses_xxx" --session-id "ses_yyy" \
  --agent-name "researcher" --prompt "..."
```

### 17.6 确保隔离的检查清单

| 检查项 | 要求 |
|--------|------|
| 代码中无 `~/.kimi` 字面量 | 全部通过 `PathConfig` 获取 |
| PID / lock 文件在 `$KIMI_HOME` 下 | 不使用 `/tmp` 或 `/var/run` 等全局位置 |
| temp 文件在 `$KIMI_HOME/tmp/` 下 | 不使用 `os.tmpdir()` |
| SQLite WAL/SHM 文件自动在 `$KIMI_HOME/` 下 | SQLite 自动管理，和 db 文件同目录 |
| 进程间无隐式共享 | 不同 KIMI_HOME 的实例之间零数据交叉 |

### 17.7 源码包结构（参考）

以下是 kimi-core 源码的推荐 package 组织，基于 v2 架构设计。这是参考结构，不是强制约束——实现者可以根据实际情况调整文件拆分粒度。核心约束是**铁律 3 的 import 边界**（§5.0）：`packages/soul/` 不能 import `packages/core/` 或 `packages/hooks/` 或 `packages/tools/`。

```
kimi-core/
├── packages/
│   ├── soul/                    # Soul 无状态函数包（铁律 3：不 import SoulPlus）
│   │   ├── runSoulTurn.ts       # Soul 执行入口（§5.1）
│   │   ├── types.ts             # SoulConfig, SoulContextState, SoulTurnOverrides
│   │   └── compaction.ts        # Soul 侧 compaction 检测逻辑
│   │
│   ├── core/                    # SoulPlus + 管理层
│   │   ├── soulplus/
│   │   │   ├── SoulPlus.ts      # 三层 DAG 宿主（§六）
│   │   │   ├── TurnManager.ts
│   │   │   ├── RequestRouter.ts
│   │   │   ├── SoulRegistry.ts
│   │   │   ├── NotificationManager.ts
│   │   │   ├── SkillManager.ts
│   │   │   └── TeamDaemon.ts
│   │   ├── state/
│   │   │   ├── WiredContextState.ts   # ContextState 实现（§4.5）
│   │   │   ├── SessionJournal.ts      # §4.6
│   │   │   ├── JournalWriter.ts       # §4.5.4
│   │   │   └── ConversationProjector.ts # §4.7
│   │   ├── permission/
│   │   │   ├── PermissionRule.ts
│   │   │   ├── checkRules.ts
│   │   │   └── ToolCallOrchestrator.ts
│   │   ├── approval/
│   │   │   └── ApprovalRuntime.ts     # §十二
│   │   ├── session/
│   │   │   └── SessionManager.ts      # §6.13.4
│   │   └── runtime/
│   │       └── Runtime.ts             # §6.12
│   │
│   ├── wire/                    # Wire 协议定义 + codec
│   │   ├── types.ts             # WireMessage, WireRecord, WireResponse
│   │   ├── codec.ts             # WireCodec（§14.3）
│   │   └── schema.ts            # Zod schemas（附录 A/B）
│   │
│   ├── transport/               # Transport 实现
│   │   ├── Transport.ts         # Transport 接口（§14.1）
│   │   ├── MemoryTransport.ts
│   │   ├── StdioTransport.ts
│   │   ├── SocketTransport.ts
│   │   └── WebSocketTransport.ts
│   │
│   ├── hooks/                   # Hook 系统
│   │   ├── HookEngine.ts        # §13.7
│   │   ├── HookExecutor.ts      # §13.5 接口
│   │   ├── CommandHookExecutor.ts
│   │   └── WireHookExecutor.ts  # §13.6.1
│   │
│   ├── tools/                   # 内置 Tool 实现
│   │   ├── ToolRegistry.ts      # §10.3
│   │   ├── ReadTool.ts
│   │   ├── WriteTool.ts
│   │   ├── BashTool.ts
│   │   ├── AgentTool.ts         # §8.2（SubagentHost）
│   │   └── TeamMailSendTool.ts  # §8.3
│   │
│   └── team/                    # Agent Team 通信层
│       ├── TeamCommsProvider.ts # §8.3.2 接口
│       ├── SqliteTeamComms.ts   # 默认实现
│       └── MemoryTeamComms.ts   # 测试实现
│
├── kaos/                        # 执行环境抽象（§十八.1）
├── kosong/                      # LLM Provider 适配（§十八.2）
└── cli/                         # TUI 入口（§14.4.4）
```

### 17.8 Self-Introspection API（决策 #108）

v2 提供 3 个自检 API，用于生产环境诊断、嵌入方监控和用户自助排障。Phase 1 只骨架（返回基本信息），Phase 2 丰富字段。

**1. `session.dump`**：导出 session 当前状态快照，不影响运行。debug 时一键导出完整 session 信息，替代"让用户上传 wire.jsonl + state.json"的低效排障流程。

```typescript
interface SessionDumpResult {
  session_id: string;
  lifecycle: string;                 // §6.12.2 SoulLifecycle
  broken: boolean;                   // §9.4 健康标记
  broken_reason?: string;
  context_summary: {
    message_count: number;
    token_count: number;             // 当前 ContextState 的 estimated tokens
    last_message_time?: number;
  };
  journal_stats: {
    record_count: number;
    last_rotation?: number;          // 最后一次 compaction rotate 时间
    pending_drains: number;          // JournalWriter batch queue 待写入数
  };
  usage: { input_tokens: number; output_tokens: number; total_cost_usd?: number };
  subagents: Array<{ id: string; status: string; last_activity?: number }>;
  team?: { team_id: string; role: string; members: number };
  current_turn?: { turn_id: string; step: number; started_at: number };
}
```

**2. `session.healthcheck`**：返回 session 是否 healthy，附带具体检查项列表。嵌入方可用于监控 session 健康度。

```typescript
interface SessionHealthcheckResult {
  healthy: boolean;
  broken_reason?: string;
  turn_count: number;
  checks: Array<{
    name: string;                    // 检查项名（如 "journal_drain" / "lifecycle" / "memory"）
    status: "ok" | "warn" | "fail";
    detail?: string;                 // 异常详情
  }>;
  // Phase 1 检查项：
  //   - journal_drain：drain queue 是否堆积（> 100 条 → warn）
  //   - lifecycle：是否卡在非 idle/active（> 60s → warn）
  //   - broken：broken 标记
  //   - subagent_health：是否有 "lost" 状态的 subagent
}
```

**3. `core.metrics`**：进程级指标快照，session_id="__process__"。返回内存、session 数、active turns 等全局指标。

```typescript
interface CoreMetricsResult {
  heap_used: number;                 // process.memoryUsage().heapUsed
  heap_total: number;                // process.memoryUsage().heapTotal
  rss: number;                       // process.memoryUsage().rss
  sessions: number;                  // SessionManager.list().length
  active_turns: number;              // 所有 session 中 lifecycle=active 的数量
  uptime_ms: number;                 // process.uptime() * 1000
  // Phase 2 加：open_fds / event_loop_lag / gc_count 等
}
```

**暴露方式**（取决于运行模式）：
- **CLI 模式**：`/doctor`（healthcheck）+ `/dump`（session.dump）内部命令
- **SDK 模式**：`KimiCore` 实例上的方法
- **Server 模式**（Phase 2）：HTTP `/health` / `/metrics` endpoint

---

## 十七A、MCP 集成架构（决策 #100 / Phase 1 接口预留 + Phase 3 实现）

### 17A.1 设计目标与原则

MCP（Model Context Protocol）是 Anthropic 主导的 LLM 工具标准协议。**Phase 1 必做接口预留**——所有 Phase 3 会触碰的契约（ToolRegistry / ApprovalSource / Wire methods / PathConfig）在 Phase 1 就定型，Phase 3 只做 implementation 不破坏契约。**8 人日 vs Phase 3 大重构 9 个核心子系统**，明显划算。

**核心原则**：
1. **接口先行，实现后置**——Phase 1 定义接口 + 提供 `NoopMcpRegistry` 占位（同 §12 `MemoryRuntime no-op` 模式），Phase 3 替换为真实实现
2. **基于 v2 现有抽象**——MCP tool 走 `Tool` 接口、UI 弹框走 `ApprovalRuntime`、配置走 `PathConfig`、跨进程走 Wire 协议、生命周期受 SoulPlus 管理
3. **不破坏 Soul stateless**——Soul 继续不知道 MCP 存在（铁律 6 不变）；MCP 是 SoulPlus 的内部组件，通过 ToolRegistry 暴露给 Soul
4. **Crash recovery 一致**——MCP 连接是 transient state，崩溃后**重新建立**（不复用），不需要 dangling repair；wire.jsonl 记录 connect/disconnect 仅用于审计
5. **不抄 CC 全部**——Phase 3 只实现 stdio + streamable-http 两种 transport（覆盖 90%+ server）；OAuth 只做基础 RFC 6749 + PKCE；不做 XAA / claudeai-proxy / sse-ide / sampling

### 17A.2 核心接口（Phase 1 定义全 9 个，Phase 3 实现）

#### 17A.2.1 配置层

```typescript
type McpConfigScope = "enterprise" | "user" | "project" | "dynamic" | "plugin";

type McpTransportConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string>; oauth?: McpOAuthConfig }
  | { type: "sse";  url: string; headers?: Record<string, string>; oauth?: McpOAuthConfig };

interface McpOAuthConfig {
  clientId?: string;
  callbackPort?: number;
  authServerMetadataUrl?: string;
}

interface McpServerConfig {
  serverId: string;                    // 已规范化（normalize）的 server 名
  name: string;                        // 用户可见的原始名
  transport: McpTransportConfig;
  scope: McpConfigScope;
  pluginSource?: string;               // plugin 注入的 server 标记（用于 plugin 卸载时清理）
  capabilities?: {                     // 能力声明（client 侧告诉 server 我支持啥）
    elicitation?: boolean;
    sampling?: boolean;
    roots?: boolean;
  };
  toolCallTimeoutMs?: number;
  toolMaxOutputChars?: number;         // 决策 #100 / D-MCP-11：覆盖默认 100K
  enabled?: boolean;                   // 用户手动 disable 用
}

// 企业策略（Phase 1 schema 预留 + Phase 3 实施）
interface McpPolicy {
  denied?: McpServerEntry[];           // 黑名单
  allowed?: McpServerEntry[];          // 白名单（非空时只允许列内）
}
type McpServerEntry =
  | { kind: "name"; pattern: string }
  | { kind: "url"; pattern: string }
  | { kind: "command"; pattern: string };
```

#### 17A.2.2 McpClient 接口

```typescript
type McpClientState =
  | "disconnected" | "connecting" | "connected"
  | "needs-auth" | "failed" | "disabled";

// 决策 #100 / D-MCP-2：interface + 默认 RealMcpClient 实现（Phase 3）；
// interface 让嵌入方可以替换（mock test、自定义 transport）
interface McpClient {
  readonly serverId: string;
  readonly state: McpClientState;
  readonly capabilities?: McpServerCapabilities;
  readonly lastError?: string;

  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;

  // Tool
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: unknown,
           opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpToolResult>;

  // Resource（Phase 3）
  listResources(): Promise<McpResource[]>;
  readResource(uri: string): Promise<McpResourceContent>;

  // Prompt（Phase 3+）
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args?: unknown): Promise<McpPromptContent>;

  // 事件回调（registry 内部分发 server 来的 notification / request）
  onNotification: ((notif: McpNotification) => void) | null;
  onElicitation: ((req: McpElicitationRequest) => Promise<McpElicitationResponse>) | null;
  onClose: ((reason?: string) => void) | null;
  onToolsChanged: (() => void) | null;        // server 推 tools/list_changed 时
  onResourcesChanged: (() => void) | null;
}

interface McpToolDefinition {
  name: string;                        // server 侧的原名（不带前缀）
  description?: string;
  inputSchema: unknown;                // JSONSchema
  meta?: Record<string, unknown>;      // 例如 anthropic/alwaysLoad
}

interface McpToolResult {
  isError: boolean;
  content: McpContent[];               // text | image | audio | resource_link
  structuredContent?: unknown;
}
```

#### 17A.2.3 McpTransport 接口

```typescript
// Phase 1 接口 / Phase 3 实现 stdio + http
interface McpTransport {
  readonly type: "stdio" | "http" | "sse" | "ws";
  connect(signal?: AbortSignal): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onMessage: ((msg: unknown) => void) | null;
  onClose: ((reason?: string) => void) | null;
  onError: ((err: Error) => void) | null;
}
```

| Transport 实现 | Phase | 说明 |
|---|---|---|
| `StdioMcpTransport` | Phase 3 必做 | spawn subprocess + JSON-RPC framing；覆盖 80%+ server（git / playwright / chrome-devtools / 私有脚本） |
| `HttpMcpTransport` | Phase 3 必做 | streamable-http SDK 封装；OAuth server 必备（slack / linear / context7） |
| `SseMcpTransport` | Phase 3 可选 | http 出来之前的协议，部分老 server 仍用 |
| `WebSocketMcpTransport` | Phase 4+ | YAGNI 直到 IDE 集成 |
| `InProcessMcpTransport` | YAGNI | CC 用来挂自己的 builtin server，v2 用不上 |
| `ClaudeAIProxyTransport` | YAGNI | CC 专用 |

#### 17A.2.4 McpRegistry 接口

```typescript
interface McpRegistry {
  // 加载 + 连接
  register(config: McpServerConfig): Promise<void>;
  unregister(serverId: string): Promise<void>;
  refresh(serverId: string): Promise<void>;        // 重新拉 ToolList

  // 查询
  list(): McpClient[];
  get(serverId: string): McpClient | undefined;
  status(): McpRegistrySnapshot;                   // status.update.mcp_status 的数据源

  // 启动 / 关闭（SoulPlus 生命周期管理）
  startAll(): Promise<void>;
  closeAll(): Promise<void>;

  // 被动 hook：tools 列表变化时通知 ToolRegistry
  onToolsChanged: ((serverId: string, tools: Tool[]) => void) | null;
}

interface McpRegistrySnapshot {
  loading: boolean;
  total: number;
  connected: number;
  toolCount: number;
  servers: Array<{
    serverId: string;
    name: string;
    state: McpClientState;
    toolNames: string[];
    error?: string;
  }>;
}

// Phase 1 占位：NoopMcpRegistry 实现所有方法返回 empty / no-op
class NoopMcpRegistry implements McpRegistry {
  async register() { /* no-op */ }
  async unregister() { /* no-op */ }
  async refresh() { /* no-op */ }
  list() { return []; }
  get() { return undefined; }
  status() { return { loading: false, total: 0, connected: 0, toolCount: 0, servers: [] }; }
  async startAll() { /* no-op */ }
  async closeAll() { /* no-op */ }
  onToolsChanged = null;
}
```

#### 17A.2.5 McpToolAdapter（Tool 桥接）

```typescript
// Phase 1 类骨架（execute 抛 NotImplementedError）+ Phase 3 接 RealMcpClient
class McpToolAdapter implements Tool {
  readonly name: string;               // mcp__<serverId>__<normalizedToolName>
  readonly description: string;
  readonly inputSchema: ZodType;
  readonly metadata: { source: "mcp"; serverId: string; originalName: string };
  // 决策 #96 + #100 协调：MCP 独立 100K 预算（vs builtin 50K）
  readonly maxResultSizeChars: number;

  // 决策 #98 / Tool UI 渲染契约：MCP tool 走保守 fallback（kind: "generic"）
  // Phase 3 升级：如果 MCP 协议未来扩展 _meta 字段提供 display hint，适配层升级映射
  readonly display: ToolDisplayHooks<unknown, unknown> = {
    getActivityDescription: (args) =>
      `${this.metadata.originalName}(${truncate(JSON.stringify(args), 60)})`,
    getInputDisplay: (args) => ({
      kind: "generic",
      summary: this.metadata.originalName,
      detail: args,
    }),
    // getResultDisplay 不覆盖——走 §10.7 默认 fallback（自动按 isError / content 选 error / text）
  };

  constructor(
    private readonly client: McpClient,
    private readonly definition: McpToolDefinition,
    private readonly serverId: string,
    private readonly config: { toolMaxOutputChars?: number },
  ) {
    this.name = `mcp__${serverId}__${normalizeToolName(definition.name)}`;
    this.description = definition.description ?? "";
    this.inputSchema = jsonSchemaToZod(definition.inputSchema);
    this.metadata = { source: "mcp", serverId, originalName: definition.name };
    // 决策 #100 / D-MCP-11：默认 100K，per-server 可覆盖
    this.maxResultSizeChars = config.toolMaxOutputChars ?? DEFAULT_MCP_MAX_RESULT_CHARS;
  }

  async execute(toolCallId, args, signal, onUpdate): Promise<ToolResult> {
    const result = await this.client.callTool(this.metadata.originalName, args, {
      signal,
      timeoutMs: this.config.toolCallTimeoutMs,
    });
    return convertMcpResultToToolResult(result);  // 内部走 §10.6 Tool Result Budget 路径
  }
}

// 失败时 server 的伪工具（让 LLM 触发 OAuth）
class McpAuthAdapter implements Tool {
  readonly name: string;               // mcp__<serverId>__authenticate
  // ... Phase 3 实现
}
```

### 17A.3 配置层级（决策 #100 / D-MCP-12 5 层，去掉 CC 的 cloud 那层）

```
enterprise (managed-mcp.json，平台路径见 PathConfig.enterpriseMcpConfigPath())  ← 最高
↓
user ($KIMI_HOME/mcp.json)
↓
project (<workDir>/.kimi/mcp.json)
↓
dynamic (--mcp-config <path> CLI 参数)
↓
plugin ($KIMI_HOME/plugins/<name>/mcp.json，每个 plugin 一份)                     ← 最低
```

**合并规则**：
- 后者覆盖前者（同 serverId 时）
- enterprise 的 `deniedMcpServers` / `allowedMcpServers` 永远生效
- 加载时给每个 server 打 `scope` 标签（用于 UI 显示来源）
- plugin 注入的 server 同时打 `pluginSource` 标签（用于 plugin 卸载时清理）

**冲突解决**：决策记录 #64 "ToolRegistry 冲突处理 内置 > SDK > MCP > Plugin" 仍适用——MCP server 之间的命名冲突由 prefix 自然消除（不同 serverId）。

**enterprise 文件平台路径**（决策 #100 / D-MCP-6）：
- macOS: `/Library/Application Support/Kimi/managed-mcp.json`
- Linux: `/etc/kimi/managed-mcp.json`
- Windows: `%ProgramData%\Kimi\managed-mcp.json`

详见 §17.3 PathConfig 的新增方法。

### 17A.4 OAuth 流程（决策 #100 / D-MCP-7）

**支持范围**：标准 OAuth 2.0 + PKCE（RFC 6749 + 7636）。**不做** XAA / claude.ai connectors / step-up 认证。

**触发条件**：
- 首次连接 OAuth-enabled server（无 token）→ 走 `mcp.startAuth` 流程
- 401 → token 失效 → 自动 refresh（如有 refresh token）→ 否则降级 needs-auth
- LLM 调 `mcp__server__authenticate` 伪工具（`McpAuthAdapter`）→ 主动触发

**与 Approval 系统集成**：

```typescript
// 用户主动跑 kimi-core mcp auth <serverId>
// 或 Wire method mcp.startAuth → ApprovalRequest
{
  toolCallId: `mcp_auth_${serverId}_${nanoid()}`,
  toolName: "mcp:auth",
  action: `Authorize MCP server: ${serverName}`,
  display: {
    kind: "url_fetch",  // 或新增 elicitation kind，Phase 3 决定
    url: authUrl,
    method: "OAuth2 + PKCE flow",
  },
  source: { kind: "mcp", server_id, reason: "auth" },
}
```

**Token 持久化**（决策 #100 / D-MCP-7）：
- 位置：`$KIMI_HOME/auth/mcp/<serverId>.json`（PathConfig.mcpAuthPath）
- 文件 mode：0600
- 目录 mode：0700
- 内容：`{ access_token, refresh_token?, expires_at, scope, server_url }`
- **暂不加密**（Phase 4+ 决定是否上 keychain / age）—— 文件权限已能挡 90% 误读；上 keychain 引入 native 依赖，谨慎
- LRU memo 在内存里，避免每次 callTool 都读盘

### 17A.5 错误处理 + 自动重连（决策 #100 / D-MCP-8 + D-MCP-10）

| 错误 | 处理 |
|---|---|
| 连接失败（network / spawn） | 指数退避重试：1s → 2s → 4s → 8s → 16s → 30s（最多 30s）；最多 5 次后标记 `failed`，需用户手动 `mcp.connect` 才再试 |
| 401 Unauthorized | 标记 `needs-auth` + emit `mcp.auth_required` 事件；尝试 refresh token，失败则等用户 `mcp.startAuth` |
| 会话过期（HTTP 404 + JSON-RPC -32001） | 自动透明重连一次；失败再走标准重连逻辑 |
| Tool call 失败（含 timeout） | 不影响 client 状态；只把 ToolResult 标 `isError=true` 返回给 Soul（**被动健康检测**，决策 #100 / D-MCP-8——不主动 ping） |
| Server 主动 close / EOF | 标记 `disconnected` + 触发 onClose 回调；**仅 remote 自动重连**，stdio 不重连（决策 #100 / D-MCP-10——避免反复 spawn 死掉的进程） |
| 用户手动 `mcp.disconnect` | 标记 `disabled`，**不**自动重连 |

**stdio 不自动重连的理由**：stdio 是子进程，挂掉通常意味着 server bug，反复 spawn 会消耗系统资源。让用户手动 `mcp.connect` 恢复。

### 17A.6 Elicitation 协议

MCP server 在工具执行中途向用户请求输入（典型场景：OAuth、付费授权、动态参数）。两种 mode：

- **`form`**：server 给 schema，UI 渲染表单让用户填
- **`url`**：server 给 URL，UI 提示用户去浏览器完成

**v2 适配**：elicitation 走 `ApprovalRuntime`，新增 `ToolInputDisplay.kind: "elicitation"`（或复用 `url_fetch` / 新增 kind，Phase 3 决定）。流程：

```
McpClient.onElicitation(req)
  → 转 ApprovalRequest:
      { toolName: "mcp:elicitation",
        action: req.params.message,
        display: { kind: "elicitation", mode, schema, url, message, server_id },
        source: { kind: "mcp", server_id, reason: "elicitation" } }
  → ApprovalRuntime.request(req)
  → await user response（可能要填 form / 点 url）
  → 转回 McpElicitationResponse 给 server
```

**Server 断开时批量取消**：

```typescript
// McpRegistry 在 client.onClose 时调
approvalRuntime.cancelBySource({ kind: "mcp", server_id: client.serverId });
```

### 17A.7 与现有架构的集成

#### 17A.7.1 SoulPlus 注入 McpRegistry

MCP 集成**不引入新的 SoulPlus 类型**，按 §6.1 的 6 facade 模型，新增的 `McpRegistry` 归入 **`services` facade**（与 `approvalRuntime` / `toolCallOrchestrator` / `memoryRuntime` 同层）。Phase 1 注入 `NoopMcpRegistry`，Phase 3 注入 `RealMcpRegistry`。

启动序列（`SoulPlus.start` 内 services facade 装配完成后追加的钩子，不再独立列 SoulPlus 字段）：

```typescript
// services facade 已构造（§6.1 阶段 5）后追加的 MCP wiring；
// 所有引用 mcpRegistry / toolRegistry / approvalRuntime 都走 facade，没有新增 SoulPlus 字段。

async function wireMcp(soulPlus: SoulPlus, paths: PathConfig) {
  const { services, infra } = soulPlus;  // facade 视图（见 §6.1）
  const { mcpRegistry, approvalRuntime } = services;
  const { toolRegistry, eventBus } = infra;

  // 1. 加载配置 → 注册到 McpRegistry → 后台 startAll
  const configs = await McpConfigLoader.load(paths);  // 5 层加载 + 企业策略过滤
  for (const cfg of configs) {
    await mcpRegistry.register(cfg);
  }

  // 2. McpRegistry 在 ToolList 拉到后通过 onToolsChanged 把 tools 注入 ToolRegistry
  mcpRegistry.onToolsChanged = (serverId, tools) => {
    toolRegistry.registerBatch(`mcp__${serverId}__`, tools);
  };

  // 3. ToolRegistry.onChanged → emit mcp.tools_changed Wire 事件
  toolRegistry.onChanged = (change) => {
    eventBus.emit({ type: "mcp.tools_changed", server_id: change.server_id, ...change });
  };

  // 4. 后台启动连接（不阻塞 SoulPlus.start）
  mcpRegistry.startAll().then(() => {
    eventBus.emit({ type: "mcp.loading", status: "loaded" });
  });

  // 5. McpRegistry 把 elicitation 转给 ApprovalRuntime
  for (const client of mcpRegistry.list()) {
    client.onElicitation = async (req) => {
      const approval = await approvalRuntime.request({ /* ... */ });
      return convertApprovalToElicitResult(approval);
    };
    client.onClose = () => {
      toolRegistry.unregisterByPrefix(`mcp__${client.serverId}__`);
      approvalRuntime.cancelBySource({ kind: "mcp", server_id: client.serverId });
      eventBus.emit({ type: "mcp.disconnected", server_id: client.serverId });
    };
  }
}
```

**Soul 永远不知道 MCP 存在**——它通过 ToolRegistry 看到的是 `Tool` 接口，通过 `beforeToolCall` 闭包看到的是 `ApprovalRuntime`（铁律 6 不变）。MCP 也不需要新增 SoulPlus 私有字段或新 facade，所有依赖都已在 §6.1 现有的 6 facade 内。

#### 17A.7.2 Plugin 系统集成（§16）

```typescript
// Plugin 加载阶段新增（Phase 1 stub / Phase 3 实现）
async function loadPlugin(plugin: LoadedPlugin) {
  // ... tools, skills, agents, hooks ...

  // 决策 #100 新增：mcp.json
  const mcpJsonPath = paths.pluginMcpConfigPath(plugin.name);
  if (await fileExists(mcpJsonPath)) {
    const configs = await loadMcpJson(mcpJsonPath, {
      scope: "plugin",
      pluginSource: plugin.source,
    });
    for (const cfg of configs) {
      await mcpRegistry.register(cfg);
    }
  }
}

// Plugin 卸载时按 pluginSource 反向清理对应的 server
async function unloadPlugin(plugin: LoadedPlugin) {
  for (const client of mcpRegistry.list()) {
    if (client.config.pluginSource === plugin.source) {
      await mcpRegistry.unregister(client.serverId);
    }
  }
}
```

#### 17A.7.3 Crash Recovery（§9 矩阵新增一行）

| 子系统 | Phase 1 写入点 | 崩溃恢复策略 |
|---|---|---|
| MCP 连接 | wire.jsonl 记录 `mcp.connected` / `mcp.disconnected` 事件，**仅审计用**，不影响 replay | 启动时**全部重新建立连接**（不复用），不需要 dangling repair。重启后 ContextState replay 看到的 MCP tool result 就和当初一样（已记录在 wire.jsonl 的 tool_result record 里）；MCP 连接本身的 transient state 丢失但无害 |
| MCP elicitation 等待中崩溃 | wire.jsonl 有 `approval_request` 无 `approval_response` | 走 §12.4 已有的 `recoverPendingOnStartup` 逻辑：补 synthetic cancelled response + synthetic error tool_result |
| MCP OAuth token | `$KIMI_HOME/auth/mcp/<serverId>.json` | 文件本身是持久化的；崩溃后仍可用；token 过期由正常的 401 → refresh 链路处理 |

**结论**：MCP 不引入新的 dangling 类型，只是在 §9.x 矩阵下添加 elicitation 这一类（实际就是 approval 的子类）。

#### 17A.7.4 Hook 系统集成

新增 hook 事件：

| Hook 事件 | 触发 | 用途 |
|---|---|---|
| `OnMcpElicitation` | 收到 elicitation 请求时（弹给用户之前） | 让 hook 程序化响应 elicitation |
| `OnMcpServerConnected` | server 连上时 | 例如自动 `mcp.refresh` 或加载额外配置 |

Phase 1 在 HookEngine 事件名单加 `OnMcpElicitation` 占位（其他 Phase 3+）。

### 17A.8 内置 MCP Tool（暴露给 LLM）

**Phase 3 实现**两个 builtin tool（决策 #100 / D-MCP-5）：

| Tool | 用途 | 注入条件 |
|---|---|---|
| `ListMcpResourcesTool` | LLM 列出所有连接 server 的 resource | 至少 1 个 connected server 声明了 resources capability |
| `ReadMcpResourceTool` | LLM 读 resource（输入 URI） | 同上 |

**Phase 1 不做 placeholder**——没有连接的 server 这两个 tool 没意义，强行加占位污染 ToolRegistry。

**`ListMcpPromptsTool` / `GetMcpPromptTool`**：YAGNI，等真有 server 用 prompts 再说。

### 17A.9 Phase 1 必做接口预留 vs Phase 3 实现

#### Phase 1 必做（约 8 人日）

| 项 | 类型 |
|---|---|
| `McpClient` / `McpTransport` / `McpRegistry` interface 定义 | 接口文件 |
| `McpServerConfig` / `McpTransportConfig` / `McpPolicy` Zod schema | 类型定义（附录 D） |
| `McpToolAdapter` 类骨架（execute 抛 NotImplementedError） | 占位类 |
| `NoopMcpRegistry` 实现（所有方法返回 empty / no-op） | 占位实现 |
| ToolRegistry 改造：`registerBatch` / `unregister` / `unregisterByPrefix` / `onChanged`（§10.5 已落） | 破坏性改造 |
| `ApprovalSource` union 加 `mcp` 分支（§12.2 已落） | 类型扩展 |
| `PathConfig.mcpConfigPath` / `mcpAuthDir` / `mcpAuthPath` / `enterpriseMcpConfigPath` / `pluginMcpConfigPath`（§17.3 已落） | 路径派生 |
| Wire methods 表加 `mcp.*` 占位（§3.5 已落，routing 阶段返回 NotImplemented） | 协议扩展 |
| Wire events 表加 `mcp.connected` / `mcp.disconnected` / `mcp.error` / `mcp.tools_changed` / `mcp.auth_required` schema（§3.6 已落） | 协议扩展 |
| `status.update.mcp_status` 的 `McpRegistrySnapshot` schema（§3.6 已落） | 协议扩展 |
| `mcp.loading` event 明确 producer = `McpRegistry.startAll`（§3.6 已落） | 文档 |
| HookEngine 事件名单加 `OnMcpElicitation` 占位 | 接口扩展 |

#### Phase 3 实现（约 45 人日）

| 项 |
|---|
| `StdioMcpTransport` 实现（spawn subprocess + JSON-RPC framing） |
| `HttpMcpTransport` 实现（streamable-http SDK 封装） |
| `RealMcpRegistry` 替换 `NoopMcpRegistry`（连接管理 + 自动重连 + 状态机） |
| `McpClient` 默认实现（基于 `@modelcontextprotocol/sdk` 的 Client 类包装） |
| `McpToolAdapter.execute` 实现（含 100K 预算 + media 处理 + 截断） |
| `McpAuthAdapter` 伪工具实现（OAuth 触发） |
| OAuth 2.0 + PKCE 流程（含本地回调 server / token 持久化 / refresh） |
| `ListMcpResourcesTool` + `ReadMcpResourceTool` builtin tools |
| `McpConfigLoader` 5 层加载 + 合并 + 企业策略过滤 |
| Elicitation 协议（client → ApprovalRuntime 路径） |
| 自动重连指数退避 + 会话过期重试 |
| Wire methods `mcp.*` 全部接通 |
| Hook `OnMcpElicitation` 真实接通 |
| `kimi-core mcp` CLI 子命令（add/remove/list/auth/test） |
| Plugin 注入 mcp.json 支持 |
| TUI 渲染 MCP 状态 |

#### 永远不做（YAGNI）

| 项 | 理由 |
|---|---|
| 自身作为 MCP Server 暴露 builtin tool | CC 的 server 域 v2 用不上；如果其他工具想调 v2，应该走 Wire 协议 |
| 8 种 transport 全部实现 | Phase 3 只做 stdio + http，覆盖 90%+ server |
| XAA Cross-App Access | 企业 SSO 复杂，等真实需求来 |
| step-up 认证 | YAGNI，标准 OAuth 已够 |
| claude.ai connectors | CC 专用 |
| sse-ide / ws-ide 协议 | IDE 集成 Phase 4+ |
| sampling 协议（server 反向请求 host LLM） | 极少 server 用，等真实需求 |
| MCP server 进度推流（独立 mcp progress 协议） | 走 v2 现有 `tool.progress` Wire 事件即可 |
| Resource 全文索引 / 自动 prefetch | LLM 按需 read 即可 |

### 17A.10 与 §10.6 Tool Result Budget 的协调

§10.6 已统一三种来源的预算梯度（决策 #96 + #100 协调）：

- **builtin**：`DEFAULT_BUILTIN_MAX_RESULT_CHARS = 50K`
- **MCP wrapper**：`DEFAULT_MCP_MAX_RESULT_CHARS = 100K`（独立预算，text + media 共享）
- **第三方 plugin tool**：tool 自定义（推荐 50K）

`McpToolAdapter` 构造时统一传 `maxResultSizeChars: 100K`；用户可在 `McpServerConfig.toolMaxOutputChars` 里 per-server 覆盖。MCP tool 的 result 走 `ToolCallOrchestrator.runAfterToolCall` 时同样会触发 §10.6 的 "持久化 + preview 替换" 路径——超 100K 的 result 会被持久化到 `$KIMI_HOME/sessions/<sid>/tool-results/<tool_use_id>.txt`，preview 替换为 `<persisted-output>` 块（不 truncate 丢弃）。

### 17A.11 与 §10.7 Tool UI 渲染契约的协调

`McpToolAdapter` 实现 `Tool.display` 字段的方式（决策 #100 + #98 协调）：

- **getInputDisplay**：MCP 协议自身不携带 display hint，走保守 fallback `{ kind: "generic", summary: originalName, detail: args }`
- **getResultDisplay**：不覆盖，走 §10.7 默认 fallback（按 `isError` / content 自动选 `error` / `text`）
- **getActivityDescription**：用 `${originalName}(${args})` 截断 60 字符
- **getUserFacingName**：默认 fallback 为 `tool.name`（即 `mcp__server__tool` 格式，UI 可解析显示为 "MCP: server / tool"）

未来如果 MCP 协议扩展 `_meta` 字段提供 display hint，适配层升级映射（Phase 3+）。

---

## 十八、依赖组件

本章集中说明 v2 第一阶段**保留并继承**的两个外部依赖组件——Kaos（执行环境抽象）和 Kosong（LLM Provider 适配）。它们都不是 v2 的核心创新，但 Soul / SoulPlus 的设计假设它们以当前形态稳定存在；这里解释"为什么保留 / 接口长啥样 / 未来怎么扩展"。Phase 1 只继续沿用既有实现，不做重写或深度演化。

### 18.1 Kaos 与 Sandbox

#### 18.1.1 Kaos 的角色

Kaos 是 **"执行环境抽象"**：把"跑 shell 命令、读写文件、执行进程"这些操作统一到一个接口后面。

```typescript
interface Kaos {
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  spawn(cmd: string, args: string[], opts?: SpawnOpts): KaosProcess;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<Stat>;
  kill(pid: number, signal: string): Promise<void>;
  // ...
}
```

实现：
- `LocalKaos`：直接用 Node 的 `child_process` / `fs`
- `SSHKaos`：ssh2 远程执行（已有）
- `SandboxKaos`：未来——接 sandbox 执行器，隔离文件/网络
- `ContainerKaos`：未来——Docker/gVisor 容器执行

**关键**：所有工具都调 `getCurrentKaos()`，不直接用 Node API。这样切换执行环境（本地 → SSH → sandbox）不需要改工具代码。

#### 18.1.2 路径透明化

讨论里提到的"路径透明化"是指：工具代码写 `kaos.readFile("~/project/file.txt")`，但实际读的是哪个机器上的文件由 Kaos 实现决定。工具**不知道**文件在哪——它只知道"给 Kaos 一个路径，Kaos 给我内容"。

#### 18.1.3 Sandbox 集成（延后）

v2 第一阶段不做 sandbox。但设计上保留接口——未来只需实现 `SandboxKaos` 注入。

### 18.2 Kosong（LLM Provider 层）

#### 18.2.1 职责

Kosong 是 **LLM provider adapter**：
- 统一不同 provider（OpenAI / Anthropic / Google / Moonshot / ...）的 API
- 输入：kimi-cli 的 message/tool 格式
- 输出：kimi-cli 的 StreamEvent 格式

#### 18.2.2 与 Soul 的关系

Soul 只依赖 `Kosong` 接口，不直接调 OpenAI SDK 等：

```typescript
interface LLMProvider {
  chat(messages: Message[], tools: Tool[], opts: ChatOpts): AsyncIterable<StreamEvent>;
}
```

#### 18.2.3 保留 Kosong 的决定

讨论里明确了：
> "我觉得还是得保留这套系统吧"
> "保留呗"

**原因**：AI SDK（Vercel）等方案做 demo 好用，但不够灵活、不够稳定。我们在 Kosong 上投入了很多（流式、多 provider、错误处理、cancel 支持），继续用。

---

## 十九、项目规划

本章把 v2 第一阶段**不直接实现但必须为之留接口**的能力，以及**从 v1 / Python 向 v2 切换**的迁移策略集中收拢。两节内容都属于"交付节奏"层面，和架构铁律本身无关——它们回答的是"我们什么时候做、怎么接住旧数据、前后端怎么并行"，不是"系统长什么样"。

### 19.1 延后能力（预留接口，第一阶段不实现）

| 能力 | 预留方式 | 触发实现的时机 |
|---|---|---|
| **消息级 Edit（email 式）** | `ContextEditRecord` wire 事件已定义（5 种操作），MethodCategory `context_mut` 已设计，排队机制已就绪。`session.editMessage` / `session.deleteMessage` / `session.rewind` 方法暂不开放 | 用户明确需要 rewind/undo 时 |
| **命令式 Rewind** | `context_edit { operation: "rewind", to_turn }` 已定义，compaction 轮转保证 rewind 不越过压缩边界 | 用户明确需要时间旅行时 |
| **外部 CLI 集成** | `AgentBackendBridge` 接口已定义，`AgentMemberConfig.backend` 字段已预留，`BACKEND_REGISTRY` 工厂模式已设计。`TeamCommsProvider` 统一抽象保证所有 backend 走同一 mailbox 路径（Phase 1 默认 `SqliteTeamComms`）。当前只实现 `KimiCliBridge` | 需要 Kimi CLI 控制 Claude Code / Codex / 其他 CLI 做 agent team 时 |
| **`FileTeamComms`（Phase 2）** | `TeamCommsProvider` 接口已定义（见 §8.3.2 / 决策 #90），三个窄接口 `TeamMailbox` / `TeamRegistry` / `TeamHeartbeat` 稳定。Phase 1 只实现 SQLite + Memory，File 实现作为降级方案预留。参考 CC 的文件 inbox 设计 + `proper-lockfile` 并发控制，但要避免 CC 的两个教训（缺 envelope_id 去重、不清理老消息） | 无 native binding 环境、纯 Node 发行包、受限容器 |
| **`RedisTeamComms`（Phase 3）** | 同一 `TeamCommsProvider` 接口。用 Redis list 作为 mailbox（`RPUSH` publish / `LPOP` poll）、Redis hash 作为 registry、Redis key + TTL 作为 heartbeat、Redis pub-sub 作为 `subscribe` 的事件驱动实现（把轮询降到兜底级别） | 跨机器 team、大规模并发场景 |
| **`TeamMailbox.subscribe` 事件驱动（Phase 2+）** | 可选方法已在接口里预留。支持的 provider（SQLite 的 `update_hook`、Redis pub-sub、File watcher）可以实现 push 语义，TeamDaemon 自动降低轮询频率到兜底级别（几秒一次） | 低延迟要求的 team 场景 |
| **MemoryRuntime / Session Memory（D14）** | 服务层节点 `MemoryRuntime` Phase 1 为 `NoopMemoryRuntime` 占位（见 §6.1 共享资源/服务层 DAG）。未来支持三种 scope 的记忆召回：`global`（跨 session 的长期偏好）、`report`（跨项目的汇总）、`session`（当前 session 的历史检索）。**Recall 结果走 `FullContextState.appendMemoryRecall` 做 durable 写入**（Phase 6E 后与 notification / system reminder 的路径对称；对齐 CC 的 memory recall 行为），作为 `MemoryRecalledRecord` 进 transcript，由 projector 从 snapshot 读出组装进 LLM 输入。`CompactionRecord.archive_file` 字段已预留（指向归档文件），未来为 `session` scope 的 SearchHistory 工具铺路 | 对话太长、用户需要搜索历史或跨 session 偏好记忆时 |
| **Flow-based Agent Workflow** | Wire `agent_type: "independent"` 已预留，SessionManager 的 create 接受 `team_spec` 参数但不解析 | 需要做 hive-like 工作流时 |
| **Sandbox 集成** | Kaos 接口已准备，`SandboxKaos` 类框架已在 | 安全要求提高时 |
| **Agent Color** | `agentColorManager` 设计参考 cc-remake（8 色、per-agentType 缓存），但第一阶段不实现 | UI 需要区分不同 agent 时 |
| **Hot reload** | — | 不计划做 |
| **`/export` 恢复命令** | — | 数据丢失事件出现后再做 |

---

### 19.2 迁移策略

#### 19.2.1 旧 session 迁移

提供 `kimi-core migrate` CLI 命令：

```bash
kimi-core migrate --from ~/.kimi/sessions --to ~/.kimi-v2/sessions
```

内部调用 `migrate()` 函数（§4.9），支持：
- Python kimi-cli 三文件格式 → v2 两文件格式
- v1 三文件格式（早期 TypeScript 实现的 context + wire + state）→ v2 两文件格式

**一次性工具**，迁移完成后用户可以备份并删除旧 session 目录。

#### 19.2.2 前后端并行开发

讨论里的决策：
- **新人力** 做前端（TY——基于 Ink 的新 TUI）
- **内部资深** 做 core（新 Soul/SoulPlus 架构）
- **最紧急**：先把 Wire 消息结构体（§3.1-3.3）定下来，让两边并行

消息结构体定下来后，两边都有 contract 可以开发：
- 前端可以 mock Core，先搭 UI 框架
- 后端可以用 `CollectingSink` 测 Soul

---

## 二十、第一阶段 Scope

Phase 1 scope 按 Phase 1-4 终稿架构（Soul 无状态函数 / 双通道 / SoulPlus 内部消化 permission / `beforeToolCall` 单一 gate）展开。下面按"必做 / 不做 / 硬约束 / 里程碑"四节组织。

### 20.1 必做

- Wire 协议 2.1（envelope + 所有核心方法 + UI 友好字段）
- 四种 Transport（Memory / Stdio / Socket / WebSocket）
- Router + SessionManager
- Soul（纯状态机 agent loop）
- SoulPlus（多 Soul 注册表 + 请求路由器 + auto-wake 机制）
- wire.jsonl 存储 + 内存 ContextState 重放
- state.json 缓存
- Notification 系统（`targets` 三路分发：`llm` 走 `FullContextState.appendNotification` durable 写入进 transcript、`wire` 走 EventBus 广播、`shell` 触发 hook；`system_reminder` / `memory_recalled` 复用对称路径）
- subagent（同进程 Soul，resumable，history 复用可选，`SubagentHost` 接口由 `SoulRegistry` 实现，通过 `AgentTool` constructor 注入而非 Runtime）
- **Agent Team**（多进程 SoulPlus + **可插拔 `TeamCommsProvider` 接口**（`TeamMailbox` / `TeamRegistry` / `TeamHeartbeat` 三窄接口）+ Phase 1 默认 `SqliteTeamComms`（生产）+ `MemoryTeamComms`（测试）+ TeamMail + 统一 TeamDaemon + auto-wake + 消息优先级处理（`shutdown_request > approval_* > team_mail`） + 定期清理（每小时 cleanup 24h 前老消息））
- Hook 双通道 + HookExecutor 可插拔（Phase 1 仅 Command + Wire）
- Kosong 保留 + adapter
- Kaos LocalKaos + SSHKaos（已有）
- **Skill 系统**（SkillManager + inline/fork 执行 + TurnOverrides + 模板变量 + 内置 skills）
- **Plugin 系统**（plugin.json + Tools/Skills/Agents/MCP/Hooks 注入 + local/git 安装）
- **MCP 集成接口预留**（决策 #100 / 约 8 人日）：`McpClient` / `McpRegistry` / `McpTransport` / `McpToolAdapter` 接口定义 + `NoopMcpRegistry` 占位实现 + ToolRegistry 异步 `registerBatch` / `unregister*` / `onChanged` 改造 + ApprovalSource `mcp` 分支 + Wire methods `mcp.*` 占位 + Wire events `mcp.connected/disconnected/error/tools_changed/auth_required` schema + PathConfig `mcpConfigPath` / `mcpAuthDir` / `enterpriseMcpConfigPath` / `pluginMcpConfigPath` + HookEngine `OnMcpElicitation` 占位（详见 §17A）
- **Tool Result Budget**（决策 #96 / L1，详见 §10.6）—— builtin 默认 50K 字符 + MCP wrapper 100K + 超阈值结果由 `ToolCallOrchestrator` 持久化到磁盘并替换为 `<persisted-output>` preview；`Tool.maxResultSizeChars` 字段（§10.2）+ `DEFAULT_MCP_MAX_RESULT_CHARS` / `DEFAULT_BUILTIN_MAX_RESULT_CHARS` 常量；持久化文件路径由 `PathConfig.toolResultArchiveDir` 派生；写入 ContextState 之前替换 content
- **Tool UI 渲染契约**（决策 #98，详见 §10.7）—— 6 个 display hook（`getUserFacingName` / `getActivityDescription` / `getInputDisplay` / `getResultDisplay` / `getProgressDescription` / `getCollapsedSummary`）+ `ToolInputDisplay` / `ToolResultDisplay` 2 套 discriminated union（10+ 个具名 kind + `generic` fallback）+ `ApprovalDisplay` 收编为 `ToolInputDisplay` 别名（§12.2 / §10.7.7）；EditTool / WriteTool 的 diff 由 `ToolCallOrchestrator` 统一计算并复用给 transcript / approval（§10.7.6）
- **Streaming Tool Execution Phase 1 hook**（决策 #97，详见 §11.7.1 + §10.7.5）—— Soul loop 内增加 3 行 prefetch 检查（在 `runToolCall` 入口先查 `kosong.drainPrefetched()`）+ KosongAdapter 接口预留 `onToolCallReady?(toolCall)` 回调和 `_prefetchedToolResults: Map<string, ToolResult>` 字段；Phase 1 不启用并发，但接口槽位到位，Phase 2 启用受控并发不破坏接口
- **JournalWriter 异步批量**（决策 #95，详见 §4.5.4）—— 双层架构（`pendingRecords` 内存可见 + `diskWriteQueue` WAL 入队）+ force-flush kinds（`approval_response` / `turn_end` / `subagent_completed` / `subagent_failed`）等磁盘 fsync 完成才 resolve + 默认 `drainIntervalMs=50ms` 后台 drain；`onPersistError` hook + `journal.write_failed` telemetry
- **Overflow Recovery 三层防御 L2/L3**（决策 #96，详见 §6.4 + §3.5）—— L2 阈值触发 `executeCompaction(reason: "auto")`（与 #93 `needs_compaction` 路径合流）+ L3 反应式 `executeCompaction(reason: "overflow")` 在 KosongAdapter 检测到 input overflow 抛 `ContextOverflowError` 后由 TurnManager 兜底 + `MAX_COMPACTIONS_PER_TURN = 3` 熔断 + 超过熔断后 emit `session.error(error_type: "context_overflow")` + `turn_end(reason: "error")`
- **SkillTool 协作工具族**（决策 #99，详见 §15.9 / §15.10 / §15.11）—— `SkillTool` 加入 §10.3.1 协作工具族 + 通过 `SkillManager` + `SkillInlineWriter`（inline）/ `SubagentHost`（fork）host-side 注入 + Skill listing 走 `FullContextState.appendSystemReminder` durable 写入（projector 自然组装）+ Read / Glob 工具白名单加入 skill 根目录（fail-safe）+ inline 注入用 `<kimi-skill-loaded>` tag 包裹（防套娃，export filter 保留）+ `MAX_SKILL_QUERY_DEPTH = 3` 限制
- **401 / connection retry 归 KosongAdapter**（决策 #94，详见 §6.13）—— OAuth 401 自动 token refresh + 瞬时网络错误（ECONNRESET / ETIMEDOUT / 5xx 等可恢复错误）指数退避重试，由 `KosongAdapter` 统一兜底；Soul loop 不感知 retry 行为，只看到 `ContextOverflowError` 等不可恢复错误抛回
- **Transport 层**（Transport 接口 + 4 种实现 + WireCodec 分层）
- **Permission 系统**（SoulPlus 内部消化：PermissionRule 规则引擎 + 3 种 PermissionMode + `buildBeforeToolCall` 闭包构造 + `checkRules` 纯函数匹配）
- **Approval 系统**（独立于 Permission：`ApprovalRuntime` 接口 + 基本 UI 弹框 + 崩溃恢复 synthetic cancelled response）
- **Tool 系统**（极简 Tool 接口 + constructor 注入 + ToolRegistry + `__` 双下划线命名空间 + 冲突处理）
- **ContextState 一分为二**（`SoulContextState` / `FullContextState` + `WiredContextState` / `InMemoryContextState` 两种实现）
- **EventSink 双通道**（fire-and-forget，`emit` 返回 void）
- **SoulConfig + SoulTurnOverrides 窄视图**（权限 override 不走 Soul 参数通道，由 TurnManager baked 进 `beforeToolCall` 闭包）
- Crash recovery（write-ahead + dangling repair + 重新 approval + pending approval 扫描回填）
- PathConfig 服务（KIMI_HOME 环境变量 + 零硬编码路径 + 实例隔离）
- 旧 session 迁移 adapter

### 20.2 不做（v2 第一阶段）

- Plugin 系统的 Marketplace / Reconciler / pi-mono 风格的 Plugin/Extension 高级管理层（`plugin.json` 清单格式和基本 Tools/Skills/Agents/MCP/Hooks 注入保留）
- MCP server 真实连接 / Transport 实现 / OAuth / Resource 工具 / 自动重连等具体实现（决策 #100 / Phase 3 主要任务，约 45 人日）——**Phase 1 必做接口预留**（McpClient / McpRegistry / McpTransport / McpToolAdapter 接口 + `NoopMcpRegistry` 占位 + ToolRegistry 异步路径 + ApprovalSource mcp 分支 + Wire 协议 mcp.* 占位 + PathConfig 5 个路径方法）已纳入 §20.1 必做清单，Phase 3 直接填实现不破坏契约（详见 §17A）
- ToolSearch / 懒加载（§10.6 阈值触发，Phase 1 全量暴露内置 tool）
- HookExecutor 扩展类型（HTTP / Prompt / Agent Executor），Phase 1 只实现 Command + Wire
- 高级 approval display 类型（除 `command / diff / file_write / task_stop / generic` 之外的自定义 UI 延后）
- Subagent 进程级隔离（Phase 1 先做 in-process subagent，走同进程 Soul 实例）
- 消息级 Edit / 命令式 Rewind（`ContextEditRecord` 和 `MethodCategory: context_mut` 已设计、wire 事件 schema 已预留，`session.editMessage` / `session.deleteMessage` / `session.rewind` 方法暂不开放）
- Flow-based Agent Workflow（YAML 定义的 dev→review 流水线）
- Sandbox
- `/export` 容错
- Hot reload
- 树形 session 存储（pi-mono 式）
- Agent Team 中的 agent_color（颜色自动分配，延后到 UI 开发阶段）
- 外部 CLI Backend（ClaudeCodeBridge / CodexBridge）——AgentBackendBridge 接口和 BACKEND_REGISTRY 已定义，当前只实现 KimiCliBridge
- Session Memory / SearchHistory 工具

### 20.3 硬约束检查清单（Phase 1 必须通过）

这一节不是"功能清单"而是"交付前必须通过的纪律"——每一条都对应 Phase 1-4 + Phase 6（Round 1-3）引入的铁律：

- **Soul import whitelist**：`packages/soul/**` 的 `.ts` 文件 import 受限于铁律 3 的白名单，`tsconfig paths` + ESLint `no-restricted-imports` 双重强制，CI 检查（铁律 3）
- **Soul 零 permission 词汇**：`packages/soul/**` 下代码里不允许出现 `permission` / `approval` / `askForPermission` / `canUseTool` / `permissionChecker` / `approvalRuntime` 等 identifier、字符串字面量、注释，ESLint 强制（铁律 2）
- **EventSink.emit 签名 = void**：从类型签名上就禁止 `await sink.emit(...)` 的误用（铁律 4）
- **wire.jsonl 唯一物理写入点**：`JournalWriter` 是唯一物理写入点；状态类 durable 写走 `ContextState`，管理类 durable 写走 `SessionJournal`，compaction 走 `TurnManager.executeCompaction → journalCapability.rotate`（决策 #93 后调用方从 Soul 改为 TurnManager）；`wire.jsonl` 是 **session 对话状态与会话审计记录** 的唯一持久化真相源，transport/runtime coordination state（`team_mails` SQLite / approval waiters / pending notifications / lifecycle gate）有各自受限真相源与恢复策略；`state.json` 只是派生缓存（决策 #68 + D2 + D15）
- **权限规则路径可测试**：`PermissionRule schema → checkRules 纯函数 → ToolCallOrchestrator.buildBeforeToolCall 闭包` 全链路可用 unit test 覆盖，不依赖 Soul 或 LLM（D18）
- **Runtime 接口窄（D1 铁律 + 铁律 7）**：Runtime 编译期字段数 Phase 1 终稿只有 `{kosong}` 一项（决策 #93 收窄；compactionProvider / lifecycle / journal 已下沉到 TurnManagerDeps），任何新增必须有决策记录支持（铁律 6 / 铁律 7）；**`SubagentHost` 不在 Runtime 里**——subagent 创建/回收是 `AgentTool` 的 host-side 依赖，按 D1 通过 tool constructor 注入，而不是挂到 Runtime 上给 Soul 直接调用
- **协作工具族注入路径（D11）**：`AgentTool` / Team Mail 发送 tool / 未来的 coordination tools 都通过 tool constructor 注入 host-side 依赖（`SubagentHost` / `TeamMailPublisher` / ...），**不**经过 Runtime
- **双通道语义纯净**：ContextState 写入 = async（await WAL fsync），EventSink 发事件 = sync void（fire-and-forget），两条语义不混用（铁律 4）
- **ToolCallOrchestrator 固定阶段顺序（D18）**：Phase 1 写死为 `validate(Soul) → preHook → permission → approval/display → execute(Soul) → postHook → OnToolFailure`；**`OnToolFailure` 是独立阶段**不并入 `postHook`（作者拍板）；Soul 的公开 API（`beforeToolCall` / `afterToolCall`）保持 callback 形态不变；orchestrator 是 D10 服务层节点，不是第 7/8 个 sub-component
- **参数 schema 校验归 Soul（D18）**：`zod.safeParse(args)` 永久留在 Soul 内，不纳入 orchestrator 阶段
- **PreToolUse hook 禁止改写 args（D18 / Phase 1）**：Phase 1 的 PreToolUse hook 只能 `blockAction = true` 或累积 `additionalContext`，不能 `updatedInput`；允许改写的语义留 Phase 2 决定
- **Abort Propagation Contract（D17 / §7）**：`TurnManager.abortTurn` 固定顺序为"先 `approvalRuntime.cancelBySource({kind:'turn',turn_id})`、再 `rootController.abort(...)`、Soul 自然抛 `AbortError`"；`CompactionProvider.run(messages, signal, options?)` 必须接 signal，贯穿 turn 级 root scope；subprocess 统一两阶段 kill：`SIGTERM` → 5 秒 grace → `SIGKILL`；foreground subagent 必须等待子 agent cleanup 完成再写 `turn_end`
- **崩溃恢复被动 repair（D5 / §9）**：重启后 lifecycle 一律回 `idle`，**禁止**主动续跑旧 turn、**禁止**追加 synthetic `user_message` 作为 recovery prompt、**禁止**重跑 tool；dangling 修复按 D2 的 record ownership 分流（ContextState 补 synthetic error `tool_result`，SessionJournal 补 synthetic `turn_end` / cancelled `approval_response`）

### 20.4 里程碑（初步，待和技术负责人 align）

1. **M1 — 消息结构定版**：Wire 2.1 消息结构体敲定（含 UI 友好字段 + TeamMail + Notification），前后端开发 contract 冻结
2. **M2 — Core 核心**：Router + SessionManager + SoulPlus（含路由器 + auto-wake） + Soul 跑通 echo 场景
3. **M3 — wire/state 存储**：append-only + 内存 ContextState 重放 + state.json 缓存 + Notification 落盘
4. **M4 — 工具系统 + Hook**：所有已有工具迁移（含 getActivityDescription）+ hook 双通道
5. **M5 — subagent**：同进程 Soul 实例 + `SubagentHost` 接口（D1，由 `SoulRegistry` 实现，AgentTool constructor 注入） + foreground/background 模式 + resume（dangling repair）
6. **M6 — Agent Team**：多进程 SoulPlus + SQLite 消息总线 + TeamMail + Leader Daemon + approval via SQLite + resume
7. **M7 — Transport + SDK**：四种 transport + Python SDK + 库模式 SDK
8. **M8 — 迁移 + 前端联调**：旧 session 迁移工具 + TY 前端对接
9. **M9 — 线下 review + 上线**：技术负责人 review + 灰度

> 具体时间节点留空，等线下面对面会议敲定。

---

## 二十一、关键设计决策记录

| # | 决策 | 选择 | 理由 | v1/v2 |
|---|---|---|---|---|
| 1 | 外部交互方式 | 统一走 Wire 协议（包括同进程 import） | 保证所有产品形态的接口一致性 | v1 继承 |
| 2 | 协议格式 | JSON + 统一 WireMessage 信封 | 跨语言零成本 | v1 继承 |
| 3 | Transport | 可插拔（Memory / Stdio / Socket / WS） | 不同场景不同 transport | v1 继承 |
| 4 | 请求隔离 | Node 事件循环 + fire-and-forget prompt | 无需线程/队列 | v1 继承 |
| 5 | Core 内部路由 | 五通道分发（对话/管理/配置/工具） | 管理请求不被 agent loop 阻塞 | v1 继承 |
| 6 | Soul 解耦 | EventSink 抽象 | Soul 不知道 transport 的存在 | v1 继承 |
| 7 | Session 封装 | SoulPlus（=v1 的 ManagedSession，改名强调管理壳地位） | 外部不知道 Soul 的存在，管理 API 直接暴露在 SoulPlus 层 | **v2 改名 + 明确角色** |
| 8 | prompt 模式 | 非阻塞，立即返回 turn_id | SDK 可实时消费 streaming 事件 | v1 继承 |
| 9 | Hook 系统 | server-side + wire 双通道 | 同时支持 shell 命令和客户端回调 | v1 继承 |
| 10 | 事件体系 | 扁平（不分层），delta 模式（不用 partial 快照） | 沿用 kimi-cli 现有设计，降低迁移成本 | v1 继承 |
| 11 | **Session 存储** | **两文件：wire.jsonl（append-only） + state.json（缓存）** | **消除双状态机，编辑能力天然存在，fork/replay 简单** | **v2 关键变更** |
| 12 | 多 session | SessionManager + Map<id, SoulPlus> | 每 session 完全独立的实例 | v1 继承 |
| 13 | **Wire 信封字段** | **极繁：加 time/from/to/turn_id/agent_type** | **防止多 agent 串台；便于未来 agent team** | **v2 新增** |
| 14 | **Soul 架构** | **纯状态机，无 session 知识** | **可独立测试，可同进程多实例并发** | **v2 明确** |
| 15 | **Context 编辑** | **append wire 事件 + 内存重放，不直接改文件** | **维护 append-only 不变式；编辑能力可延后暴露** | **v2 新增** |
| 16 | **Crash recovery** | **write-ahead + dangling repair + 重新 approval（不做 promise 持久化）** | **简单可靠；极端场景接受数据丢失** | **v2 明确** |
| 17 | **Agent 类型** | **显式字段 main/sub/independent** | **为 subagent 和 agent team 铺路** | **v2 新增** |
| 18 | Kosong | 保留并继续用 | AI SDK 不够灵活 | 讨论确认 |
| 19 | Kaos | 保留 + 后续接 sandbox | 路径透明化 | 讨论确认 |
| 20 | **Notification 持久化** | **落盘到 wire.jsonl + targets 分发（llm/wire/shell）** | **kimi-cli 的 NotificationStore 验证了落盘必要性；targets:"llm" 需要崩溃恢复后仍能注入** | **v2 新增** |
| 21 | **Step.end** | **保留（有始有终原则）** | **kimi-cli 没有 step.end（隐式结束），v2 显式加——多端 UI 需要明确的 spinner 控制；pi-mono 有等价的 TurnEndEvent** | **v2 新增** |
| 22 | **ContextState 命名** | **ContextState（不叫 ContextTree）** | **v2 使用线性存储不是 DAG，"Tree" 名字误导** | **v2 改名** |
| 23 | **Task subagent 进程模型** | **同进程 Soul 实例（不开新进程）** | **kimi-cli 用 asyncio coroutine 验证可行；避免 spawn 进程的开销；`SubagentHost` 接口（D1）由 `SoulRegistry` 实现，通过 `AgentTool` constructor 注入而非 Runtime，嵌入方可以只替换 host 而不碰 Soul；见 v2-review-findings.md 已决策内容记录 D1** | **v2 新增** |
| 24 | **Agent team 进程模型** | **独立 Node.js 进程，各自运行 SoulPlus** | **参考 cc-remake 的 subprocess teammate 模式；进程隔离 = 崩溃不级联** | **v2 新增** |
| 25 | **Agent team 通信** | **SQLite 消息总线（team_mails 表）** | **比 cc 的文件邮箱更鲁棒（ACID）；比 Unix Socket 更持久（崩溃恢复）；100ms 轮询延迟可接受** | **v2 新增** |
| 26 | **消息关联** | **mail_id（必选）+ reply_to（可选），不做 thread_id** | **比 cc 更结构化（cc 无关联 ID）；参考 Email 的 Message-ID + In-Reply-To 标准；thread_id 对消息量不大的 agent team 来说多余** | **v2 新增** |
| 27 | **TeamMail 定位** | **Wire 协议的事件类型，标注为 soul-to-soul 通信** | **SQLite payload = WireMessageEnvelope，一套协议；不是新协议，是 Wire 的另一种传输** | **v2 新增** |
| 28 | **消息注入时机** | **三类：auto-wake / passive / immediate** | **teammate 消息 auto-wake（不打断当前 turn）；配置变更 passive；approval immediate** | **v2 新增** |
| 29 | **Auto-wake 行为** | **idle 时启动新 turn；busy 时排 wakeQueue，turn 结束后自动触发** | **参考 cc 的 onSubmitTeammateMessage：idle 立即提交，busy 排队到 inbox** | **v2 新增** |
| 30 | **UI 友好字段** | **tool.call+description, turn.end+usage, session.error+error_type, subagent.spawned+agent_name（以及 EventBus 事件的 source.name，见 #88）, TeamMail+summary** | **参考 cc-remake UI 组件需求：两层 tool 描述架构、per-turn token 统计、结构化错误、badge 展示** | **v2 新增** |
| 31 | **CompactionRecord 简化** | **结构化 summary + 最小元信息（range/tokens/trigger/archive_file）；不做 topics/tools 独立字段** | **参考 cc-remake：summary 本身就是索引，cc 也不提取结构化元信息；cc 的 compaction prompt 9 章节结构已涵盖所有信息** | **v2 新增** |
| 32 | **Compaction 触发轮转** | **compaction 后 rename 旧 wire.jsonl → wire.N.jsonl，新 wire.jsonl 以 CompactionRecord 开头** | **简化 replay（新文件小）；编辑操作只能操作当前文件（封存历史）；不破坏 append-only（rename 不修改内容）** | **v2 新增** |
| 33 | **消息编辑 = 纯编辑** | **editMessage 只修改内容，不级联失效；要级联用 rewind** | **原子化操作，调用方组合实现复杂功能；避免"半吊子 cascade"语义不清** | **v2 新增** |
| 34 | **deleteMessage 级联** | **cascade=true 时软删除整个 turn** | **敏感信息场景：删一条 user message，同 turn 的 assistant 回复和 tool 结果一起标记删除** | **v2 新增** |
| 35 | **管理方法五分类** | **ReadOnly / Config / Control / ContextMut / Conversation，通过 METHOD_REGISTRY 标注** | **ContextMut（edit/delete/rewind）在 turn 运行时排队到 turn 结束后执行，避免 wire 交叉写入和 ContextState 不一致** | **v2 新增** |
| 36 | **Session Memory / SearchHistory** | **架构预留但第一阶段不实现** | **CompactionRecord 的 archive_file 字段为未来 SearchHistory 工具铺路；Session Memory 可作为独立模块后续加入** | **v2 预留** |
| 37 | **外部 CLI 统一总线** | **所有 backend（Kimi/CC/Codex/...）都通过 SQLite 通信，leader 不区分来源** | **统一代码路径 + 统一崩溃恢复 + 统一审计；100ms 延迟对 agent team 可接受（cc 自己 500ms）** | **v2 新增** |
| 38 | **AgentBackendBridge** | **可插拔接口 + BACKEND_REGISTRY 工厂模式；当前只实现 KimiCliBridge** | **策略模式：新增 backend = 实现新 Bridge + 注册，不改 leader 代码** | **v2 新增** |
| 39 | **KimiCliBridge 极简** | **Kimi CLI 成员自己读写 SQLite，bridge 只管进程生命周期** | **Kimi CLI 懂 SQLite + Wire 协议，不需要翻译层；leader 预生成 session_id 传给 member，消除启动 race condition** | **v2 新增** |
| 40 | **Streaming 不入 SQLite** | **Bridge 缓冲外部 agent 的 content.delta，只写合并后的完整 TeamMail** | **SQLite 是消息级总线不是流级总线；避免 delta 洪水写入** | **v2 新增** |
| 41 | **Kimi CLI 被控协议** | **只支持 Wire 协议（不做 cc-compat / codex-compat 输出格式）** | **作为被控 agent 时，Wire over Stdio Transport 已足够；兼容格式在 Transport 层按需加** | **v2 确认** |
| 42 | **路径配置** | **单一 `KIMI_HOME` 环境变量，所有路径派生，不可独立覆盖** | **零硬编码路径 + 完全实例隔离；同一 team 共享 KIMI_HOME 自然共享 SQLite；不需要 KIMI_SQLITE_PATH（不存在跨 KIMI_HOME 的 team）** | **v2 新增** |
| 43 | **PathConfig 服务** | **进程启动时创建一次，注入到所有组件** | **依赖注入保证可测试性；temp/lock/PID 文件全部在 KIMI_HOME 下，不污染全局命名空间** | **v2 新增** |
| 44 | **Lifecycle completing 状态 + 两套状态集合** | **SoulPlus 内部 `SessionLifecycleStateMachine` 管完整 5 态 `idle/active/completing/compacting/destroying`；Runtime 暴露给 Soul 的 `LifecycleGate.transitionTo` 只接受 3 态 `active/compacting/completing`——`idle` 和 `destroying` 是 SoulPlus 内部管理，Soul 无感知** | **防止 auto-wake race condition（completing 下 isIdle()=false，新消息正确入 wakeQueue 而不会重复 startTurn）；同时保持 Soul 对 session 生命周期的最小感知** | **v2 新增** |
| 45 | **Subagent 7 态状态机** | **created/running/awaiting_approval/completed/failed/killed/lost** | **参考 kimi-cli 的 8 态简化；awaiting_approval 让 UI 展示等待状态；killed 区分用户主动取消 vs 错误** | **v2 新增** |
| 46 | **Member 崩溃检测** | **exit 事件（主路径，即时）+ SQLite heartbeat（备路径，90s）** | **exit 事件覆盖 leader 在线场景；heartbeat 覆盖 leader 重启场景；参考 kimi-cli BackgroundTaskManager.recover()** | **v2 新增** |
| 47 | **SQLite WAL + 自适应轮询** | **PRAGMA journal_mode=WAL + busy_timeout=5s + 自适应间隔（50ms-500ms）** | **WAL 允许并发读写；busy_timeout 处理写冲突；自适应减少空闲 CPU** | **v2 新增** |
| 48 | **context_mut 操作原子化** | **editMessage/deleteMessage/rewind 不做冲突检测，调用方管理** | **保持操作原子和简单；避免复杂的 cascade/conflict 语义** | **v2 新增** |
| 49 | **Skill ≠ Agent Definition** | **两个独立系统：Skill（任务模板）+ Agent（身份定义），共享 Markdown frontmatter 格式但不同字段和执行机制** | **Skill = "做什么"（临时任务），Agent = "是谁"（持久身份）；inline 需要当前上下文，Agent 始终隔离** | **v2 新增** |
| 50 | **TurnOverrides 不修改 ContextState** | **Skill 的环境覆盖通过参数传给 `runSoulTurn`，不修改 ContextState** | **避免和 setModel 等 config 操作冲突；wire 和内存状态一致；turn 结束后自然失效无需恢复** | **v2 新增** |
| 51 | **handlePrompt lifecycle 检查** | **active 状态下拒绝新 prompt（返回 agent_busy）** | **防止两个 turn 同时启动；用户需先 cancel 或等 turn 结束** | **v2 新增** |
| 52 | **Plugin 注入能力** | **Tools + Skills + Agents + MCP Servers + Hooks** | **参考 cc-remake 的 plugin 架构；比 kimi-cli 现有的"仅 tools"更完整** | **v2 新增** |
| 53 | **HookExecutor 可插拔** | **统一接口 + HOOK_EXECUTOR_REGISTRY 注册表，第一阶段 Command + Wire** | **比 cc 的硬编码 7 文件改动模式好；新增 hook 类型 = 实现接口 + 注册** | **v2 新增** |
| 54 | **SoulPlus 三层 DAG（取代旧"6 子组件 facade"）** | **三层结构（D10）：共享资源层（`SessionLifecycleStateMachine` / `SoulLifecycleGate` / `JournalWriter` / `WiredContextState` / `SessionJournal`）→ 服务层（`Runtime` / `ConversationProjector` / `ApprovalRuntime` / `ToolCallOrchestrator` / `MemoryRuntime` 占位）→ 行为组件层（`RequestRouter` / `TurnManager` / `SoulRegistry` / `SkillManager` / `NotificationManager` / `TeamDaemon`）；组件只依赖下层窄接口，绝不反向依赖** | **避免 god object（cc 的 AppState 450+ 字段的教训）；解决原"6 子组件 facade"里构造循环依赖和 `LifecycleGate` 归属不清的问题；`ApprovalRuntime` / `ToolCallOrchestrator` 被明确为服务层节点而不是第 7/8 个 sub-component；见 v2-review-findings.md 已决策内容记录 D10** | **v2 新增 → Phase 6B/D10 重构** |
| 55 | **wire.jsonl metadata header** | **第一行是 metadata（protocol_version + created_at + kimi_version），不是 WireRecord** | **参考 kimi-cli 的 WireFileMetadata 设计；支持版本兼容性检查和升级提示** | **v2 新增** |
| 56 | **未知 record type 处理** | **skip + warn（不 crash）** | **向前兼容：新版本产生的 record 在旧版本中被安全跳过；参考 cc 的静默跳过和 kimi-cli 的 extra="ignore"** | **v2 新增** |
| 57 | **版本号规则** | **minor = 向后兼容（新字段/新类型），major = 不兼容** | **semver 精神；minor 差异 skip + warn，major 差异报错提示升级** | **v2 新增** |
| 58 | **Transport 接口** | **callback 风格（onMessage/onConnect/onClose），所有场景走 Transport（含 stdio）** | **cc 的 stdio 不走 Transport 是设计缺陷；callback 支持多路复用；Transport 不知道消息语义（WireCodec 分离）** | **v2 新增** |
| 59 | **Transport closed 终态** | **closed 不可恢复，重连 = 创建新实例** | **简化状态机；避免"复活"对象的状态管理复杂度** | **v2 新增** |
| 60 | **PermissionMode 3 种** | **default / auto / bypass** | **cc 的 6 种 mode 中 acceptEdits/plan/delegate 可通过规则+Hook 组合实现；3 种语义清晰无重叠** | **v2 新增** |
| 61 | ~~**7 层权限检查链**~~ | — | 已撤销，详见附录 F.1 | **已撤销** |
| 62 | **TurnOverrides 权限为 dynamic rules** | **不直接替换工具列表，注入 Layer 5 规则；不能绕过 deny** | **双层防护：LLM 可见性过滤 + 权限检查链；安全边界不依赖 LLM 行为** | **v2 新增** |
| 63 | **工具命名空间 `__` 双下划线** | **内置短名 / MCP `mcp__s__t` / Plugin `plugin__n__t`** | **和 cc 一致；server/tool 名含 `_` 时无歧义；可反向解析** | **v2 新增** |
| 64 | **ToolRegistry 冲突处理** | **内置 > SDK > MCP > Plugin，冲突 warning 不静默覆盖** | **前缀命名空间几乎不冲突；冲突时通知用户** | **v2 新增** |
| 65 | ~~**ContextState 持有 WireStore**~~ | — | 已撤销，详见附录 F.2 | **已撤销** |
| 66 | **step.interrupted 在 catch 路径** | **step.begin 发出后被 cancel/error 时必须 emit step.interrupted** | **有始有终原则** | **v2 新增** |
| 67 | **Compaction lifecycle "compacting"** | **compaction 期间 lifecycle 进入 compacting 状态，阻止所有 wire 写入** | **防止 rename 和 new file 创建之间的并发写入；崩溃恢复检测中间状态** | **v2 新增** |
| 68 | **JournalWriter 单一写入入口** | **所有 wire.jsonl 写入通过 JournalWriter（lifecycle gate + 串行队列 + seq 分配）** | **解决写入分散导致 compacting 保护无法执行的问题；WiredContextState 持有 JournalWriter 而非 WireStore** | **v2 新增** |
| 69 | **行为组件层窄 Deps 接口（配合 D10）** | **行为组件层每个节点（`RequestRouter` / `TurnManager` / `SoulRegistry` / `SkillManager` / `NotificationManager` / `TeamDaemon`）通过一个 `Deps` 接口拿到下层服务 / 共享资源的引用，`不持有 SoulPlus 引用`；服务层（`Runtime` / `ConversationProjector` / `ApprovalRuntime` / `ToolCallOrchestrator` / `MemoryRuntime`）和共享资源层不需要 `Deps` 接口，它们就是下层** | **编译器强制依赖边界；消除 god object 间接变体；D10 三层 DAG 的落地保证之一——`Deps` 接口在行为组件层把依赖显式化，让静态分析就能看出某个组件会用到哪些下层能力；参考 cc 的 QueryDeps 模式；见 v2-review-findings.md 已决策内容记录 D10** | **v2 新增 → Phase 6B/D10 对齐** |
| 70 | **MailEnvelope 格式** | **SQLite wire_envelope 存 `{type, data}` 格式（snake_case + data 字段，和 WireRecord 对齐）** | **SQL 列承担路由职责，wire_envelope 只含业务内容；消除"假装 WireMessage 实际不是"的矛盾** | **v2 新增** |
| 71 | **TurnOverrides 双层防护** | **第一层 LLM 可见性（buildLLMTools 过滤）+ 第二层权限检查链（dynamic rules 注入 Layer 5）** | **解决 §5.1 和 §11.4 的矛盾；安全边界不依赖 LLM 行为；finally 清理 dynamic rules** | **v2 新增** |
| 72 | **统一 TeamDaemon** | **Leader 和 Member 共享同一个 TeamDaemon 类，role 参数化** | **参考 cc 的 useInboxPoller 共享模式；95% 代码可复用；member 也运行持续 daemon（250ms 间隔）** | **v2 新增** |
| 73 | **废除临时 poll** | **Member 不再在 tool 调用栈中临时 poll，统一走 daemon** | **member 等 approval 时仍能响应 leader 的 cancel/shutdown；不阻塞 tool 调用栈** | **v2 新增** |
| 74 | **崩溃恢复 at-least-once** | **先 wire.append 再 SQL update + envelope_id 级去重（live dedup + 启动同步 + replay dedup 三层防线）** | **参考 cc 的 side-effect-first-then-ack 模式；零 sidecar 表、零 intent log、零状态机；正常路径零开销；详见 §9.4.1** | **v2 新增 → Phase 6D 术语对齐** |
| 75 | **last_exit_code 标记** | **state.json 加字段区分 clean/dirty 关闭** | **崩溃检测用，配合 resume 的 SQL 同步（Phase C）** | **v2 新增** |
| 76 | **ContextState 写入方法异步** | **所有写入方法返回 Promise\<void\>（await journalWriter.append）** | **JournalWriter.append 本身是异步的；接口统一；WiredContextState 持有 JournalWriter** | **v2 新增** |
| 77 | ~~**PermissionChecker per-Soul 隔离**~~ | — | 已撤销，详见附录 F.3 | **已撤销** |
| 78 | **Soul/SoulPlus 边界** | **Soul = 纯 async function `runSoulTurn`（无 class/this）+ import whitelist（tsconfig path + ESLint `no-restricted-imports`）+ 双通道通信（ContextState 写状态 / EventSink 发事件）** | 纯函数让"无状态"从类型签名即可看出；双通道因同步写状态 + fire-and-forget UI 两个刚需无法合并。详见附录 ADR-X.78 | **v2 新增** |
| 79 | **Tool 执行模型 Model A + 方案 Z** | **while 循环在 Soul 内部（`runSoulTurn` 一次调用跑完整个 turn），不由 SoulPlus 外面逐步调；approval 通过 `beforeToolCall` / `afterToolCall` callback 注入 Soul，Soul 完全不知道 permission/approval 的存在** | cc-remake / kimi-cli Python / pi-mono 的参照实现都采用 Model A；callback 注入（方案 Z）让 Soul 零 permission 词汇。详见附录 ADR-X.79 | **v2 新增** |
| 80 | **Tool 接口极简化** | **Tool 接口删除 `checkPermissions` / `selfCheck` / `validateInput` / `canUseTool` 参数 / `description()` 函数 / `prompt()` 函数；只保留 `name / description / inputSchema / execute(id, args, signal, onUpdate?)`；外部依赖（shell executor / file system / HTTP client）通过 constructor 注入，不通过 execute 的 ctx 参数** | **pi-mono 的 Tool 就是这种极简形态；ctx 参数容易成为垃圾桶；constructor 注入让每个 Tool 实例是自包含的能力对象；permission 完全由 beforeToolCall 处理，Tool 不需要知道；相关章节：§10.2 / §10.3 / §10.7** | **v2 新增** |
| 81 | **beforeToolCall 唯一 approval gate** | **`beforeToolCall` 是唯一 approval gate，被允许做耗时操作（读文件、算 diff、查 registry、发 ApprovalRequest 并等响应）；tool 的 execute 不接收 `ctx.requestApproval` 能力；危险模式（shell 命令替换 `$(...)` / eval / 交互式命令）一律在 beforeToolCall 的静态分析阶段硬 deny** | 真问题不是"二次 approval 需求"而是"approval UI display 依赖业务计算"；统一 gate 让 review 成本 O(1)。详见附录 ADR-X.81 | **v2 新增** |
| 82 | **ContextState 一分为二（D2 收窄）** ⚠️ **Phase 6E 部分撤销：通知/提醒子设计作废** | **`SoulContextState`（Soul 能读能写的窄视图） + `FullContextState extends SoulContextState`（SoulPlus 独占 `appendUserMessage` + `appendNotification` / `appendSystemReminder`）；`WiredContextState` 实现 FullContextState，调 runSoulTurn 时 TypeScript 自动收窄；纯审计 / 生命周期 / 协作类 record 走并列窄门 `SessionJournal`**（⚠️ 子设计"notification/reminder 归 SessionJournal + pendingNotifications 缓冲"已被决策 #89 撤销，详见附录 F.5） | 边界靠类型保证不靠纪律；D2 把状态写入和纯审计写入彻底分开，共用底层 JournalWriter。详见附录 ADR-X.82 | **v2 新增 → Phase 6B/D2 收窄 → Phase 6E 部分撤销** |
| 83 | **TurnOverrides 一分为二 + SoulConfig.tools 按 turn 传入** | **`FullTurnOverrides`（TurnManager/SkillManager 内部用，含 `model/effort/activeTools/disallowedTools`）vs `SoulTurnOverrides`（Soul 看到，仅 `model/effort/activeTools`，且 activeTools 在 Soul 侧只做 LLM visibility filter）；TurnManager 调 runSoulTurn 前把权限相关 override（activeTools=allow / disallowedTools=deny）转成 turn-scope PermissionRule baked 进 beforeToolCall 闭包；`SoulConfig.tools` 按 turn 传入不从 Runtime 取（subagent 可每 turn 传不同子集）** | Soul 零 permission 词汇的必然推论；tool 按 turn 传入让 subagent 限制工具集成为一等公民。详见附录 ADR-X.83 | **v2 新增** |
| 84 | **Streaming progress 走 EventSink 不写 wire.jsonl** | **Tool 执行期的流式进度（stdout / stderr / progress percent / status）通过 `onUpdate` 回调转换为 EventSink 的 `tool.progress` 事件，不写入 wire.jsonl；同理 LLM 流式输出 `content.delta` 只走 EventSink** | **EventSink 是 fire-and-forget UI 通道（决策 #78）；流式事件高频触发，每次 await WAL fsync 会严重拖慢体验；崩溃恢复只需最终 tool_result / assistant_message（走 ContextState），不需要中间过程事件；"丢了没关系"是这类事件的本质特征；相关章节：§4.8 / §10.2 / §5.1.7** | **v2 新增** |
| 85 | **Compaction 由 Soul 驱动** ⚠️ **决策 #93 部分撤销：执行流程移到 TurnManager** | **Compaction 的触发检测（token 超阈值判断）和执行流程（生成 summary → rotate 文件 → reset context）都在 Soul 的 while 循环内；SoulPlus 只提供两个窄能力：`runtime.lifecycle.transitionTo("compacting"\|"active")` 切 lifecycle gate、`runtime.journal.rotate(boundaryRecord)` 物理轮转；Soul 按 `transitionTo compacting → compactionProvider.run → journal.rotate → context.resetToSummary → transitionTo active` 顺序驱动**（⚠️ "执行流程在 Soul" 部分已被决策 #93 撤销：Soul 仅检测、上报，TurnManager 执行；触发检测仍在 Soul 是合理内核被保留） | 只有 Soul 知道"下一次 LLM 调用快要超限"；两个窄接口让 SoulPlus 负责物理边界不侵入循环。详见附录 ADR-X.85 | **v2 新增 → 决策 #93 部分撤销** |
| 86 | **LifecycleGate 并发语义** | **`LifecycleGate.transitionTo(newState)` 等待所有 in-flight ContextState 写入完成（走 JournalWriter 的 AsyncSerialQueue 排空）后才原子切换 lifecycle；切换后的新写入按新状态被 gate（如 compacting 下非 compaction 相关的 ContextState 写入被阻塞直到回到 active）** | **不等 in-flight 会出现"compacting 开始后还有旧写入刚落盘"，打破 "compacting 期间 wire.jsonl 只有 compaction 记录" 的语义，给崩溃恢复引入复杂 case；等 in-flight 完成略增延迟但换到清洁的边界语义，值得；相关章节：§6.12.2 / §4.5.4** | **v2 新增** |
| 87 | **CompactionProvider 接受参数 + signal（D17）** ⚠️ **决策 #93 调整：调用方从 Soul 改为 TurnManager；返回类型从 `SummaryMessage` 改为 `CompactionOutput`** | **`CompactionProvider.run(messages, signal, options?)` 支持用户主动触发（`{targetTokens?, userInstructions?}`）；signal 是 D17 Abort Propagation Contract 的一部分，compaction 必须能响应 `abortTurn(...)` 的级联中断；Phase 1 必须支持自动 compaction（Soul 检测 token 超阈值后通过 TurnResult.reason 通知 TurnManager 执行）和用户主动 compaction（`session.compact` Wire method 直接走 TurnManager.executeCompaction）两个场景；返回 `CompactionOutput { summary: Message[], estimatedTokenCount, usage? }` 让 TurnManager 立刻更新 ContextState 的 token count 估算** | kimi-cli 已有用户主动 compaction 场景；signal 必须显式否则 abort 链会断。详见附录 ADR-X.87 | **v2 新增 → Phase 6B/D17 补 signal → 决策 #93 调整调用方** |
| 88 | **Subagent 事件：独立存储 + source 标记转发（取代嵌套包装）** | **去掉 `subagent.event` 嵌套包装 record；每个 agent 有自己的 wire.jsonl，扁平存储在 `sessions/<session_id>/subagents/<agent_id>/wire.jsonl`，父子关系通过 record 的 `parent_agent_id` 字段重建；父 wire 只记 `subagent_spawned` / `subagent_completed` / `subagent_failed` 三条生命周期 record；实时 UI 推送走 SoulRegistry 注入的 EventSink wrapper：(1) 写子 wire 持久化；(2) 加 `source: { id, kind: "subagent"\|"teammate"\|"remote", name? }` 转发到 session 共享 EventBus；`source` 仅存在于 EventBus 传输层，不污染 wire.jsonl 持久化层（子 wire 复用完全相同的 `WireRecord` 类型，不带 source）** | **避免递归 subagent 的无限嵌套问题（旧方案父 wire 会包含子 wire 全量事件）；事件自描述，UI 免查表即可决定渲染策略；与 CC（Claude Code）的 agent team 方案对齐；为未来 teammate / remote 扩展（同一条 UI 事件流容纳多种 source）预留一等公民位；相关章节：§3.6.1 / §4.8 / §6.5 / §8.2 / §9 / 附录 B / 附录 D.6.1** | **v2 新增 → 取代旧 subagent.event 方案** |
| 89 | **Notification / System Reminder / Memory Recall 直接走 ContextState durable 写入（撤销 `ephemeralInjections` 机制）** | **删除 `ConversationProjector.ephemeralInjections` 参数、`TurnManager.pendingNotifications` 字段、`NotificationManager.enqueuePendingNotification` 回调；notification / system reminder / memory recall 改为通过 `FullContextState.appendNotification` / `appendSystemReminder` / `appendMemoryRecall` 做 durable 写入，作为对话事件进 transcript；`ConversationProjector.project` 签名简化为 `project(snapshot, options?)`；和 CC 的 `<system-reminder>` 包裹对齐** | LLM 看过的内容必须永久留存——v2 初稿（#82 子设计）让通知 Turn N 看到、Turn N+1 看不到，会造成因果断裂。详见附录 ADR-X.89 和附录 F.5 | **v2 新增 → Phase 6E** |
| 90 | **Agent Team 通信层 = `TeamCommsProvider` 可插拔接口（取代硬编码 SQLite + 单一 `TeamMailRepo`）** | **三个窄接口：`TeamMailbox`（publish/poll/ack/cleanup + 可选 subscribe）/ `TeamRegistry`（register/list/markDead）/ `TeamHeartbeat`（update/listStale），由 `TeamCommsProvider` 组合；Phase 1 实现 `SqliteTeamComms`（默认）+ `MemoryTeamComms`（测试），Phase 2+ 扩展 File / Redis；`TeamDaemonDeps` 扩到 6 窄依赖；`SoulPlus` constructor 新增可选 `teamComms?`；Phase 1 强制加入消息优先级排序（`shutdown_request > approval_* > team_mail`）和定期清理（`cleanup(24h)`）** | CC 硬编码文件 inbox 是教训；单一 `TeamMailRepo` 违反 SRP；拆三个窄接口支持组合和 mock。详见附录 ADR-X.90 | **v2 新增 → Phase 6F（Team Comms 可插拔化）** |
| 91 | **Soul 措辞精化：从"纯函数"到"无状态函数"** | **核心定义场景（§0 / §五标题 / §5.0 铁律 1 / §5.1.1 定义）将"纯函数"改为"无状态函数"（stateless function）；§5.0 铁律 1 下方新增"澄清：'无状态'指什么、不指什么"段落，明确列出 Soul 的 5 类副作用（写对话状态 / 发 UI 事件 / 调 LLM / 执行工具 / 触发 compaction / lifecycle），承认 Soul 不满足 FP referential transparency；首要价值从"易测"调整为"无 turn 间隐式状态"；对比性场景（vs pi-mono / vs cc-remake）和 `checkRules` / `matchesRule`（真·纯函数）保留"纯函数"；已撤销 / ADR-X 历史段落不动** | 旧措辞"纯函数"会让读者套用 FP 教科书定义（无副作用、相同输入相同输出），与 Soul 实际具有的 5 类副作用和非确定性（LLM 流式、tool 结果、abort 时刻）冲突，造成"为什么入参 context 会被修改"等理解障碍；"无状态函数"准确表达"无 this / 无实例字段 / 无跨 turn 状态"的真实含义。详见 plan `subagent-plans/plan/p2-pure-function-terminology.md` | **v2 新增 → Phase 6G（措辞精化）** |
| 92 | **SoulPlus 字段按 facade 聚合（方案 C：6 facade）** | **把 §6.1 SoulPlus class 内部 25 个 private 字段按"语义边界 + D10 三层 DAG 1:1"聚合为 6 个 facade（含 runtime）+ sessionId：`lifecycle`（stateMachine + gate）/ `journal`（writer + contextState + sessionJournal + capability）/ `runtime`（对 Soul 的契约面，铁律 6）/ `services`（projector + approvalRuntime + orchestrator + memoryRuntime）/ `components`（router + handlers + turnManager + soulRegistry + skillManager + notificationManager + teamDaemon?）/ `infra`（eventBus + ownership + toolRegistry + permissionRules + permissionService + hookEngine）；facade 用 `interface` + plain object（无运行时开销）；子组件 deps 接口完全不变，保持窄接口原则，仅 SoulPlus 内部赋值时 `this.xxx → this.facade.xxx`；构造期 6 阶段（lifecycle → journal → infra → runtime → services → components）与 facade 字段 1:1 对齐；同时把 `LifecycleGateFacade` 全文改名为 `SoulLifecycleGate`（消除"facade"一词在两处使用的命名冲突，强调它是"暴露给 Soul 的 gate"）；`teamDaemon?` 保留 optional 属性；`runtime` 作为 6 个 facade 之一（不藏入其它 facade 内部），强调它是对 Soul 的契约面（铁律 6）；facade 之间不需循环引用保护（构造期 SoulPlus constructor 内一次性装配，TS 编译期保证字段使用前已赋值）** | 旧设计 25 个 private 字段平铺，仅靠 `// ===== xxx 层 =====` 注释表达 D10 层级，TypeScript 类型系统对此一无所知、首读者抓不到主线、新人 onboarding 第一反应是"为什么这么多字段"；按 facade 聚合后顶层只剩 6 个 facade 字段，与 D10 三层 DAG 1:1 映射，认知容量在心理学经验"7±2"工作记忆甜点；不改变实际组件实例数量、不动子组件构造方式、不动对 Soul 的 Runtime 契约（铁律 6 完整保留）。Soul 代码 0 行修改，子组件代码 0 行修改，仅 §6.1 + §6.2 + §6.12.3 三处文档更新。详见 plan `subagent-plans/plan/p1-soulplus-facade-aggregation.md` | **v2 新增 → Phase 6H（字段聚合）** |
| 93 | **Compaction 执行从 Soul 移到 TurnManager + 铁律 7（Soul 不持有业务流程编排权）** | **将 compaction 执行流程（lifecycle 切换 / summary 生成 / wire rotate / context reset）从 Soul 移到 TurnManager.executeCompaction；Soul 仅在 while 顶部 safe point 检测 token 超阈值（双触发：ratio 0.85 OR reserved 50K，使用 `tokenCountWithPending`）并通过 `TurnResult.reason: "needs_compaction"` 上报；`Runtime` 接口收窄为只含 `kosong` 字段；`compactionProvider` / `lifecycle` / `journal` 三个能力下沉到 `TurnManagerDeps`；`ContextState.resetToSummary` 从 `SoulContextState` 移到 `FullContextState`（Soul 写 ContextState 全部 append-only）；`TurnManager.startTurn` 改为 while 循环，处理 `needs_compaction` 时调 `executeCompaction` 然后重启 Soul 接续同一 turn_id（不重复 appendUserMessage——铁律：Soul 看不到 appendUserMessage）；`MAX_COMPACTIONS_PER_TURN`（SoulPlus 内部硬编码，默认 3）防 compaction 死循环；`session.compact` Wire method 由 TurnManager 直接处理，不写 turn_begin/turn_end，直接调 executeCompaction；Kosong 抛 `ContextOverflowError` 提供兜底处理路径，TurnManager 在 catch 内识别并统一调 executeCompaction；`TurnResult.reason` 4 元集 `"end_turn" \| "needs_compaction" \| "aborted" \| "error"`；`StopReason` 新增 `"compaction_requested"`；`CompactionOutput { summary: Message[], estimatedTokenCount, usage? }` 携带 token 估算让 TurnManager 立刻更新 ContextState 避免下一 step 显示 0%；`executeCompaction` 末尾新增 `postCompactionAugment` hook（默认 noop，用于 Phase 2 注入 background tasks 快照等）；compaction.begin/end EventSink 事件由 TurnManager emit；TurnManager 用 `turnAborts.signal` 作为 executeCompaction 的 signal；不拆 SoulRuntime / FullRuntime（Runtime 单一接口，Phase 1 仅 1 字段）；§9.x 表 4 Crash recovery 矩阵描述从"Soul 跑到 runCompaction 哪一行"改为"TurnManager 跑到 executeCompaction 哪一行"；同时新增**铁律 7**（§5.0）"Soul 不持有业务流程编排权"——禁止未来其它"通过 Runtime 接口拼装 SoulPlus 业务流"的偷渡** | v2 初稿让 Soul 通过 `runtime.lifecycle.transitionTo` + `runtime.compactionProvider.run` + `runtime.journal.rotate` + `context.resetToSummary` 四个窄接口拼装 compaction——表面上是"4 个独立能力组合"，本质上是 Soul 当装配工执行 SoulPlus 的内部业务流（"两个接口互为前提"违反铁律 6 真正的"窄能力暴露"语义、`resetToSummary` 是 reset 语义而 Soul 其它写方法都是 append-only 形成异类、`finally` 切回 lifecycle 是 Soul 越权、嵌入方需要给 Runtime 提供 `lifecycle.transitionTo`/`journal.rotate` no-op 实现泄漏 SoulPlus 内部机制）。决策 #85 真正合理的内核是"触发检测只能 Soul 做（只有 Soul 知道下一次 LLM 调用即将超限）"，**执行流程**完全可以拆出去——这正是 CC（Claude Code）的"agent loop 纯净 + 外层服务"模式。kimi-cli Python 版的痛点（compaction 期间 PreCompact/PostCompact hook 散在 Soul 里、background tasks 注入耦合、token count 估算耦合、reset 序列手工组合、step 计数混乱、retry 在 Soul 内、lifecycle 缺失）在新设计下全部消失或缓解。详见 plan `subagent-plans/plan/p1-compaction-move-out-of-soul.md` 和附录 ADR-X.93 | **v2 新增 → Phase 6I（compaction 拆分 + 铁律 7）** |
| 94 | **401 / connection retry 归 KosongAdapter（Phase 1 必做）** | **OAuth 401（token 过期）和瞬时网络错误（ECONNRESET / ETIMEDOUT / 5xx 等可恢复错误）的重试逻辑由 `KosongAdapter` 实现内部消化（含 OAuth refresh + tenacity-style 退避）；Soul / TurnManager 都不感知。Soul 的 catch 路径只关心两件事：是不是 abort、是不是其它真实错误；不再有"是 401 / connection error 就跳过 throw 重试"的判断散在 Soul 内** | kimi-cli Python 版 `_run_with_connection_recovery`（kimisoul.py:1063–1134）把 401 / connection retry 散在 Soul 内是反例——这部分本质上是 LLM provider adapter 的固有职责（请求失败的可恢复性判断只有 adapter 知道完整语义）。下沉到 KosongAdapter 后 Soul 的循环更纯净，且 ContextOverflowError 等不可恢复错误仍然抛回 TurnManager 走 compaction 兜底（决策 #93）。这是决策 #93 拆分 compaction 时延伸出的强相关需求 | **v2 新增 → Phase 6I（与 #93 联动）** |
| 95 | **JournalWriter 异步批量写入（双层架构 + force-flush kinds）** | **`JournalWriter.append` 改为"内存先行 + 异步追赶"双层架构：同步 push `pendingRecords` 内存缓冲（`buildMessages()` 立即可见）+ 入 disk batch 队列（后台定时 drain，默认 `drainIntervalMs=50ms`、`maxBatchRecords=64`、`maxBatchBytes=1MB`）；`fsyncMode` 默认 `"batched"`，`per-record` 作为"调用即落盘"模式给 SDK 嵌入方；**force-flush kinds = `{ approval_response, turn_end, subagent_completed, subagent_failed }`** 触发立即 drain 并等磁盘 fsync 才 resolve（永不丢）；`user_message` 不进 force-flush（紧跟 LLM 调用，drain 自然追上）；`assistant_message` / `tool_result` / `notification` / `team_mail` 等异步即可（dangling 由 §9.3 / §9.4.1 兜住）；新增 `JournalWriter.flush()` 接口，调用点：rotate 前 / graceful shutdown / session.destroy / 处理 replay JSON-RPC 前；新增 `pendingRecords` 只读视图给同进程读路径；drain 失败走 `onPersistError` hook + `journal.write_failed` telemetry 双通道，drain 失败**不回滚**已 push 的内存（依赖 broken 标记兜住）；1 session 1 JournalWriter 实例（与"一进程多 session"模型对齐，避免跨 session 故障传播）；测试用 `InMemoryContextState` 的 JournalWriter 是 no-op（不需要改）；铁律 4 措辞从"WAL 同步 flush"改为"内存可见 + WAL 入队"；新增 telemetry 指标 `journal.drain_size` / `journal.drain_latency_ms` / `journal.write_failed`** | v2 初稿"每条 record 同步 fsync 才 resolve"把 Python 版"recorder 异步消费"的优势抹掉（5 个并发 tool_result → 25ms 串行 fsync 等待，每 turn 累积 100ms+），是性能退化。CC 的 `enqueueWrite + scheduleDrain` 模式（100ms drain）证明"内存先行 + 异步批量"是 agent loop 的正确选型；但 CC 几乎所有 path `void enqueueWrite(...)` 不等磁盘，崩溃丢窗口里的全部数据——v2 通过 force-flush kinds 名单把"恢复路径依赖的边界证据"保护起来（参考 Python 1.30 修过的 `TurnEnd` 配对 bug：丢失会让恢复路径"诈死"）。drain 间隔 50ms（比 CC 100ms 更短）平衡丢失窗口和用户感知；铁律 4 的"写完立即能读到"在技术上只要求"内存可见"，磁盘可见可以异步追赶。详见 plan `subagent-plans/plan/p1-journal-async-batch.md` | **v2 新增 → Phase 6J（JournalWriter 异步批量）** |
| 96 | **Overflow → Compact → Retry 自动恢复（三层防御 L1+L2+L3）** | **Phase 1 必做三层防御**：L1 Tool Result Budget（`Tool.maxResultSizeChars` 字段：builtin 默认 50K / MCP 默认 100K / Infinity 表示不持久化；ToolCallOrchestrator afterToolCall 阶段持久化到 `$KIMI_HOME/sessions/<sid>/tool-results/<tool_use_id>.txt`，preview 替换为 `<persisted-output>` 块）；L2 Threshold-based AutoCompact（Soul while-top safe point 双阈值检测：`tokenCountWithPending >= max_context * 0.85` OR `max_context - tokenCountWithPending < 50K reserved`，return `needs_compaction`，TurnManager.executeCompaction 执行）；L3 Reactive Overflow Recovery（Kosong 在 chat() 内部检测显式 PTL/413（17+ provider 模式）+ silent overflow（`usage.input + cache_read > contextWindow`）→ 抛 `ContextOverflowError` → TurnManager.startTurn catch 内调 `executeCompaction(reason: "overflow")` 并 retry）；**MAX_COMPACTIONS_PER_TURN=3 熔断器与决策 #93 共享**（防 cc-remake 实测过的"每天 250K API 浪费"死循环）；超限 → emit `session.error(error_type: "context_overflow")` + `turn_end(reason: "error")`；`max_output_tokens` 截断不做恢复（Phase 2 评估，follow Python 不 escalate）；**增量 summary 必做**（CompactionOptions 加 `previousSummary` / `fileOperations` / `reason: "threshold"\|"overflow"\|"manual"`；ContextState 加 `getLastCompactionSummary()` / `getCumulativeFileOps()` 读方法）；SummaryMessage 字段扩展（text / reason / modelUsedForSummary / generatedAt / parentSummary / fileOperations）；SummaryMessage 落盘为 `summary_reset` wire record（属 ContextState 管理，LLM 能看到），LLM 输入侧由 ConversationProjector 包装为 `role: "user"` + `<system>...</system>` 文本（Python 实战路线，绕开 Anthropic / OpenAI 自定义 role 限制）；§3.5 `context_overflow` 描述修订（旧"调整 max_tokens 重试"措辞错误，max_tokens 是 output 上限）；§9.x 表 4 标注 hot path（本决策） vs cold path（§9 crash recovery）维度正交 | v2 §3.5 旧措辞"context overflow 在 Kosong 层自动调整 max_tokens 重试"是错的——max_tokens 控制 output 上限，无法解决 input overflow。cc-remake 5 层防御（Tool Result Budget / Snip / MicroCompact / Context Collapse / AutoCompact + Withhold + Reactive Recovery）的实战教训：BQ 数据 1279 sessions 连续 50+ 次 overflow 失败、每天 250K API 浪费——熔断器不可省。Python 版从未实现 Reactive Recovery（PTL 直接 raise turn 失败），是已知缺陷；但 Python 版的"双阈值"（ratio + reserved tail）和 `tokenCountWithPending`（含 pending tool result 估算）是 1.27 修过的血泪经验，必须默认开启。pi-mono 的增量 summary（`previousSummary` 参数 + UPDATE_SUMMARIZATION_PROMPT）是 v2 真正差异化点——长 session 多次 compact 不会逐步丢失老 summary 的关键信息。Tool Result Budget Phase 1 弃用 Python "truncate 丢弃"路线（Playwright DOM 500KB 教训），改用 cc-remake "持久化 + preview" 路线，LLM 想要原文可以 Read 重读。MCP 独立 budget（Python `MCP_MAX_OUTPUT_CHARS=100K` 教训）：text + 媒体共享预算。详见 plan `subagent-plans/plan/p0-overflow-compact-retry.md` | **v2 新增 → Phase 6J（Overflow 自动恢复）** |
| 97 | **Streaming Tool Execution 预留注入点（Phase 1 必做 3 行 hook + Phase 2 启用受控并发）** | **Phase 1 必做最小预留**（升级自原 plan 的"推荐合入"，因 Python kosong `on_tool_call` 已生产验证）：(1) `ChatParams` 加可选字段 `onToolCallReady?: (toolCall: ToolCall) => void`（Phase 1 KosongAdapter 实现可不响应；Phase 2 由 SoulPlus 内部的 `StreamingKosongWrapper` set）；(2) `ChatResponse` 加可选字段 `_prefetchedToolResults?: ReadonlyMap<string, ToolResult>`（下划线前缀表示内部约定字段，第三方 KosongAdapter 不应主动 set；Phase 1 永远 undefined）；(3) **Soul §5.1.7 伪代码 `for (const toolCall of response.toolCalls)` 内部加 3 行 prefetch 检查**（Phase 1 永远走 else 分支，行为完全等价于线性路径；Phase 2 启用后命中即跳过 tool.execute）；(4) `ToolCallOrchestrator` 内部新增 3 个可选方法签名 `executeStreaming?(toolCall, signal): void` / `drainPrefetched?(): ReadonlyMap<string, ToolResult>` / `discardStreaming?(reason: 'fallback'\|'aborted'): void`（Phase 1 全部 undefined，Phase 2 实现）；(5) §7.2 `abortTurn` 标准顺序加一步 `orchestrator.discardStreaming?.("aborted")`（位于 `cancelBySource` 之后、`controller.abort()` 之前），避免 streaming 中已 dispatch 的 toolCall 没配对 tool_result 导致下次 LLM 调用 400（CC `query.ts` L1015-L1029 实测过的坑）；(6) §3.6 事件表 `tool.call.delta` 注解为"Phase 2 streaming 启用后由 KosongAdapter wrapper emit"；(7) §3.6 / §4.8 关于 `tool.progress` 的"port-from"出处更正——**不是 port-from-Python**（Python `ToolReturnValue` 没 progress 字段），是借鉴 CC `getCompletedResults`；(8) `KosongAdapter.chat` 接口签名维持"一次返回 ChatResponse"，**不**引入 `chatStream`（避免两个 API 共存）；(9) `SoulConfig` 完全不改、Soul 6 条铁律 完全不改、嵌入示例 §5.1.9 / 测试 §5.2 完全不改；(10) **v2 偏离 Python kosong 的全并发路线，走 CC 的"受控并发"路线**（`tool.isConcurrencySafe(parsedInput)` 元数据决定能否并行；non-concurrent tool 独占执行）——理由见 §11.7.1 FAQ：Bash / Write / Edit 等强副作用 tool 全并发有 race 风险，对小模型不友好；Phase 2 不保留 CC 的"sibling Bash error 自动 abort"（v2 的 Bash 是普通 tool，独立 tool 失败的 is_error 已足够 LLM 决策）；(11) Phase 2 启用前补 benchmark（端到端延迟收益 < 30% 则重新评估） | Soul 是公共 API（嵌入方依赖其纯函数语义），如 Phase 1 完全不预留，Phase 2 加入 streaming 必然重写 Soul loop——会牵动伪代码 / 决策 / 嵌入示例 / 测试章节联动改；如 Phase 1 提前铺开 `chatStream` / `executeStreaming` 全部公共 API，会把 Phase 2 的不确定性（错误处理、并发模型、buffering 策略）过早固化。"`onToolCallReady` 回调 + `_prefetchedToolResults` 字段 + 3 行 Soul hook" 是真正的"零成本预留"——Phase 1 的 `prefetched` 永远 undefined，行为完全等价；Phase 2 启用时 Soul 代码零改动，所有改动集中在 SoulPlus 服务层。Python 版 kosong 的 `on_tool_call` 回调 + `asyncio.create_task` dispatch 已生产验证此模式（生产环境跑了相当长时间）——技术风险已被验证，从原 plan 的"推荐合入"升级为 Phase 1 必做合理。CC 的 `StreamingToolExecutor`（531 行单文件）+ Python kosong `step()` 都把 streaming 作为"注入点的能力"而不是 loop 的形态，强支持 v2 "Soul loop 结构不动，能力下沉到 KosongAdapter / ToolCallOrchestrator"的判断。详见 plan `subagent-plans/plan/p2-streaming-tool-execution-prep.md` | **v2 新增 → Phase 6J（Streaming 预留）** |
| 98 | **Tool UI 渲染契约（Phase 1 必做：6 个 display hook + 2 套 union + ApprovalDisplay 收编）** | **Phase 1 必做接口槽位 + Wire schema 字段一次到位**（避免 Phase 2 加成为 breaking change）：(1) §10.2 Tool 接口加 optional `display?: ToolDisplayHooks<Input, Output>` 字段，6 个纯函数 hook：`getUserFacingName` / `getActivityDescription` / `getInputDisplay` / `getResultDisplay` / `getProgressDescription` / `getCollapsedSummary`，全部 optional 不破坏既有 tool；(2) 新增 `ToolInputDisplay` discriminated union（11 个 kind：command / file_io / diff / search / url_fetch / agent_call / skill_call / todo_list / background_task / task_stop / generic + 兼容 file_write），同时充当 `ApprovalRequest.display`；(3) 新增 `ToolResultDisplay` discriminated union（12 个 kind：command_output / file_content / diff / search_results / url_content / agent_summary / background_task / todo_list / structured / text / error / generic）；(4) **`ApprovalDisplay` 收编为 `ToolInputDisplay` 的 alias**（§12.2 类型一致；附录 B `ApprovalDisplaySchema = ToolInputDisplaySchema`），同源同构，approval 与 transcript 共享 hint，旧 5 个 kind（command / diff / file_write / task_stop / generic）兼容保留；(5) §3.6 Wire 事件表 `tool.call` 加 `user_facing_name` / `input_display`，`tool.result` 加 `result_display` / `collapsed_summary`，`tool.progress` 加 `progress_description`；(6) 附录 B `tool_call_dispatched` schema 加 `user_facing_name` / `activity_description` / `input_display` 三字段，`tool_result` schema 加 `result_display` / `collapsed_summary` 两字段（落 wire.jsonl 让 plugin / MCP 崩溃后 replay 仍能还原 UI——"Wire First"原则的天然延伸）；(7) `tool.progress.progress_description` 仅 EventSink 推送**不落盘**（铁律 5）；(8) display 调用全部发生在 `ToolCallOrchestrator` 内（不在 Soul / Tool execute 内）：approval/display 阶段算 input_display + activity_description + user_facing_name，emit tool.result 前算 result_display + collapsed_summary，onUpdate 路径算 progress_description；(9) **EditTool / WriteTool 的 diff 由 SoulPlus 算（D4）**——tool 只声明 `kind: "file_io"` 占位，orchestrator 在 `enrichDisplayHintWithDiff` 升级为 `kind: "diff"` 并填 before/after，复用一份给 approval + result；(10) 默认 fallback `defaultGetXxx` 实现导出为公开 API（`@kimi-core/tool-display-defaults`，决策 #98 / D9），plugin 作者可轻量定制；(11) `ToolUpdate.kind` 加 `"custom"` escape hatch（D10）+ `custom_kind` / `custom_data` 字段，让 tool 上报非标 update（如 "image_generated"）；(12) **不支持返回 framework Component（D6）**——Tool 接口绝不返回 React.ReactNode / pi-tui Component / lit TemplateResult（避免污染 import boundary、保跨 client 可移植性）；(13) `getProgressDescription` 频率 tool 自决（return undefined 跳过 emit）；(14) `getUserFacingName` 接受 `Partial<Input>`，per-call 动态（D8，对应 BashTool 在 sandbox / sed 模式返回不同 name）；(15) Phase 1 内置 tool 的具体 display 实现可渐进补齐（仅少数 tool 演示通路：Bash / Read / Edit）；(16) MCP tool 适配层 Phase 1 走 generic fallback，Phase 3 完整接入时升级；(17) i18n 接口预留，Phase 3+ 系统性引入 | v2 §3.6.1 `tool.call.description` 注释里说"由 Tool 实现层的 `getActivityDescription()` 生成"——但 Tool 接口里**没有这个方法**，是悬空字段，违反"Wire First"契约；§10.2 Tool 接口收敛到极简四件套时把 UI 渲染钩子一起踢掉了，被遗漏的缺口；Plugin / MCP tool 没有 display 协议，replay 时 plugin 进程已经消失 UI 还原不出来。CC 的 13 个 render hook 思想可借鉴但**必须解耦 React/Ink**——v2 只取"语义 hint 层"，结构化 union；pi-mono 的"两阶段 + state + isPartial"思想可借鉴但**不能学返回 Component**；kimi-cli Python 的 `DisplayBlock`（开放扩展 + UnknownDisplayBlock fallback + BriefDisplayBlock 默认）已生产验证，TS 版升级为 Zod discriminated union，命名 / 字段对齐方便 Python SDK 跨语言一致。设计哲学：~10 个常用 kind + generic 兜底（kind 太少 client 必须 hardcode 解析、太多实现成本爆炸；严格控制增长——加新 kind 必须 ≥3 个 tool 共享）；ApprovalDisplay 收编避免 Phase 2 再改一遍。Phase 1 加"接口槽位 + Wire 字段 + 默认 fallback"成本约 1-2 周；具体内置 tool 的 display 实现可渐进补，不必 Phase 1 全部到位。详见 plan `subagent-plans/plan/p0-tool-ui-render-contract.md` | **v2 新增 → Phase 6K（Tool UI 渲染契约）** |
| 99 | **Skill 自主调用（SkillTool 协作工具族 + ContextState SystemReminder + `<kimi-skill-loaded>` 防套娃）** | **Phase 1 必做最小完整方案**让 Soul 在 turn 中自主调用 skill（v2 首次实现，Python 4 个月迭代未做）：(1) 新增 SkillTool（§15.9）属协作工具族（§10.3.1 表格新增一行），与 AgentTool / Team Mail tool 平级，host-side 注入 SkillManager + SkillInlineWriter + SubagentHost；input `{ skill, args? }`，output discriminated union `{ mode: "inline" \| "fork", ... }`；默认对 LLM 可见（D-A A1）——v2 核心问题就是 Soul 当前调不了 skill，默认隐藏等于没解决；嵌入屏蔽走 D11 host 不 new 路径；(2) §15.2 SkillDefinition 新增 3 字段：`whenToUse?`（拼接进 listing 引导 LLM）/ `disableModelInvocation?`（D-B B1 explicit opt-in，user-only skill）/ `safe?`（D-B B1 explicit opt-in，避免 CC SAFE_PROPERTIES allowlist 复杂度，builtin skill 出厂统一带 `safe: true`）；(3) §15.4 三种 invocation_trigger 路径分类：`user-slash`（既有 §15.4.2 不变，**不进 permission 层** D-I I1，保持 Python `/commit` 立即跑体验）/ `claude-proactive`（顶层 turn）/ `nested-skill`（query_depth>0）；(4) §15.10 Skill listing 注入走 ContextState SystemReminder durable 写入（D-C C1）+ 全量重发 hot-reload 策略（D-L 策略 1）+ `MAX_LISTING_DESC_CHARS=250` 预算控制（对齐 CC，3 级降级保留 Path 行 fail-safe）+ `${KIMI_HOME}` 路径模板（D-M）；listing 排除 `disableModelInvocation: true` 的 skill（D-F F1）；带 Path 字段（D-K K2 fail-safe，让 LLM 可 Read SKILL.md 兜底，对应 Python 路线）；(5) inline 注入走 `appendUserMessage(isMeta)`（D-H H1，对齐 CC newMessages 语义 + v2 §4.5.2 isMeta 惯例）+ `<kimi-skill-loaded name="X" args="Y">...</kimi-skill-loaded>` wrapper（防套娃 + replay 友好）；trailing footer + SkillTool description anti-loop guard 双保险；export/import/replay 必须保留 tag（吸取 Python notification tag 教训）；(6) inline 模式 TurnOverrides 软约束（D-D D1，硬权限走 fork）——当前 turn 的 SoulConfig.tools 已固定，不破坏决策 #50（TurnOverrides 不修改 ContextState）；(7) `MAX_SKILL_QUERY_DEPTH = 3`（D-E E1）防递归灾难；queryDepth 通过 SpawnRequest.skill_context.query_depth 沿 sub-agent 链 +1 传递；fork 模式 `subagent_type` 与 `skill_context` 正交（v2 不复用 AgentTool 的 subagent_type 体系，避免和 Python 一样把两个维度混淆）；(8) §15.6 SkillManager 新增 `detectAndPrepareByName(name, args, meta)` + `listInvocableSkills()`；(9) §15.11 SkillInlineWriter facade（host-side 窄接口，把 user-meta append + skill_invoked record 两步打包，与 D11 协作工具族一致，不引入新接口爆炸）；(10) §3.6 / 附录 B `skill_invoked` / `skill_completed` 加 `invocation_trigger` 必填 + `query_depth?` optional 字段（保持成对镜像）；(11) §11.3.1 PermissionRule 加 `Skill(<skill_name>)` 字段匹配；(12) §6.5 / §8.2 SpawnRequest 加可选 `skill_context: { query_depth, allowed_tools?, disallowed_tools? }`；(13) §17 PathConfig 加 `skillsRoots(workDir)` 方法，Read / Glob 工具 Phase 1 把 `${KIMI_HOME}/skills/` / `${KIMI_HOME}/plugins/` / `${PROJECT}/.kimi/skills/` 加入访问白名单（D-N N1，吸取 Python CHANGELOG 1.27.0 Glob 白名单教训）；(14) §15.9.5 SkillTool description 完整文本落地（D-O 引导文字方案）：BLOCKING REQUIREMENT + NEVER reply with `/skill:<name>` 强约束 + "When NOT to invoke" 拆分（询问 vs 运行）+ Anti-loop guard tag + Listing freshness 警告；(15) Hot-reload listing header "DISREGARD any earlier" 让 LLM 以最新为准（v2 独创，处理 plugin reload 后多份 listing 共存问题）；(16) §15.12 cross-reference §4.7 ConversationProjector 不需改动——skill listing 是 SystemReminder 的典型 use case，从 snapshot 自然读出；(17) Phase 2 优化项：increment publish delta + ToolSearch 集成 + sub-agent 看裁剪 listing + agent definition `disable-skill-tool` + telemetry 等 | v2 §15.4 现状唯一触发入口是 `handlePrompt` 字符串前缀检测，turn 已经在跑时 Soul 没有任何方式触发 skill；§4.7 ConversationProjector 撤销 ephemeralInjections 后，skill 列表注入只能走 ContextState durable 写入或 system prompt。**Python 4 个月迭代里 skill 系统改了 30+ 次但没人做 SkillTool**（CHANGELOG 0.69-1.27.0 全无 autonomous skill invocation 相关 commit）——v2 是首次实现，Python 用户每天遇到"修完 bug 后想自动 commit 但只能手动 /commit"的体验断点。CC SkillTool 在生产中验证过 inline + fork + queryDepth + system-reminder listing 一整套（5e+ session）但**强绑定 React/Ink**；v2 只取语义 hint 层，结构化 union。Python 教训：listing 带 Path 是 fail-safe 智慧（LLM 可 Read SKILL.md 兜底）/ `<notification>` tag 漏到 export 出过 bug（v2 提前规划 `<kimi-skill-loaded>` filter）/ subagent 看到 listing 但调不了的设计 bug（v2 装 SkillTool 自然修复）/ `--skills-dir` override 语义 1.27.0 反复改过的坑（v2 写死 override）/ Glob 白名单 1.27.0 才补的坑（v2 Phase 1 直接加 skillsRoots）/ OAuth 401 在 skill 长 prompt 下易过期（决策 #94 KosongAdapter 401 retry 已覆盖）。`safe: true` 显式 opt-in 比 CC SAFE_PROPERTIES 隐式 allowlist 更可审计；MAX_SKILL_QUERY_DEPTH=3 比 CC 不限深度更保守（防 LLM 自我迭代灾难）。详见 plan `subagent-plans/plan/p0-skill-autonomous-invocation.md` | **v2 新增 → Phase 6L（Skill 自主调用，先于 Python）** |
| 100 | **MCP 集成 Phase 1 接口预留（9 个接口 + ToolRegistry 异步路径 + ApprovalSource mcp 分支 + Wire 协议 mcp.* 占位 + PathConfig 5 个路径方法）** | **Phase 1 必做接口预留（约 8 人日），Phase 3 实现（约 45 人日）**：(1) §17A 新增"MCP 集成架构整章"——Phase 1 落 `McpClient` / `McpTransport` / `McpRegistry` / `McpToolAdapter` interface 定义 + `McpServerConfig` / `McpTransportConfig` / `McpPolicy` zod schema + `NoopMcpRegistry` 占位实现（决策 #100 / D-MCP-1 全部预留 9 个接口、D-MCP-2 interface + 默认实现、D-MCP-3 ToolRegistry 同步 register + 异步 registerBatch）；(2) §10.5 ToolRegistry 改造（破坏性）：保留同步 `register`，新增 `registerBatch(prefix, tools): Promise<void>` / `unregister(name)` / `unregisterByPrefix(prefix)` / `onChanged: (change) => void` —— builtin 启动期同步可读性最好，MCP 100 个 tool 用 batch 一次原子替换避免 100 次事件，server 断开时整组清理；(3) §3.5 Wire methods 新增 `mcp.*` 一组 10 个 method（list / connect / disconnect / refresh / listResources / readResource / listPrompts / getPrompt / startAuth / resetAuth），Phase 1 routing 阶段返回 NotImplemented；(4) §3.6 Wire events 新增 `mcp.connected` / `mcp.disconnected` / `mcp.error` / `mcp.tools_changed` / `mcp.resources_changed` / `mcp.auth_required` 6 个事件 + `status.update.mcp_status` 的 `McpRegistrySnapshot` schema；保留 `mcp.loading` 作 lifecycle 信号（决策 #100 / D-MCP-9：和 status.update.mcp_status 并存——loading 是粗粒度变化事件给 UI 显示进度条，mcp_status 是 detailed 状态给状态栏）；(5) §12.2 ApprovalSource union 加 `{ kind: "mcp"; server_id; reason: "elicitation" \| "auth" \| "tool_call" }` 分支（决策 #100 / D-MCP-4 当前粒度足够 cancelBySource 精细控制）；(6) §17.3 PathConfig 加 5 个路径派生方法：`mcpConfigPath()` / `mcpProjectConfigPath(workDir)` / `mcpAuthDir()` / `mcpAuthPath(serverId)` / `enterpriseMcpConfigPath()` / `pluginMcpConfigPath(pluginName)`；OAuth token 文件 mode 0600 / 目录 mode 0700 / 暂不加密（决策 #100 / D-MCP-7——文件权限挡 90% 误读，keychain 引入 native 依赖谨慎）；(7) §17A 5 层配置（enterprise > user > project > dynamic > plugin，决策 #100 / D-MCP-12 去掉 CC 的 cloud 那层）+ enterprise 平台路径（macOS `/Library/Application Support/Kimi/managed-mcp.json` / Linux `/etc/kimi/managed-mcp.json` / Windows `%ProgramData%\Kimi\managed-mcp.json`，决策 #100 / D-MCP-6）；(8) §17A.5 错误处理：被动健康检测（callTool 失败时检测，决策 #100 / D-MCP-8——主动 ping 增加 server 负担且无收益）+ stdio 不自动重连 / 远程才重连（决策 #100 / D-MCP-10——stdio 进程挂掉通常是 server bug，反复 spawn 浪费资源）+ 401 → refresh / failed / needs-auth 状态机；(9) §10.6 Tool Result Budget 协调：MCP 独立 100K 预算（vs builtin 50K，text + media 共享，决策 #100 / D-MCP-11）；用户可在 `McpServerConfig.toolMaxOutputChars` per-server 覆盖；走 §10.6 持久化 + preview 路径（吸取 Python Playwright 500KB DOM 教训）；(10) §17A.11 与 §10.7 Tool UI 渲染契约协调：McpToolAdapter 实现 Tool.display 字段，走保守 fallback（kind: "generic"）；MCP 协议未来扩展 `_meta` 时升级映射；(11) §17A.6 Elicitation 走 ApprovalRuntime（kind: "elicitation"，mode: form / url）；server 断开时 `cancelBySource({ kind: "mcp", server_id })` 批量清理；(12) §17A.7.2 Plugin 系统集成：plugin 加载阶段 `loadMcpJson(plugin.mcpConfigPath, { scope: "plugin", pluginSource })`，卸载时按 pluginSource 反向清理；(13) §17A.7.3 Crash recovery：MCP 连接是 transient state，崩溃后**重新建立**（不复用，wire.jsonl 仅审计），不引入新 dangling 类型；elicitation 中崩溃走已有 §12.4 approval recovery 路径；(14) §17A.7.4 HookEngine 事件名单加 `OnMcpElicitation` 占位（Phase 3 真实接通）；(15) Phase 3 实现 stdio + streamable-http 两种 transport 覆盖 90%+ server，**不做** sse-ide / ws / claudeai-proxy / sampling / XAA / step-up auth 等（YAGNI 路径明确）；(16) §17A.8 内置 `ListMcpResourcesTool` / `ReadMcpResourceTool` Phase 3 才实现（决策 #100 / D-MCP-5——没有连接的 server 这两个 tool 没意义）；(17) §10.4 命名空间补充 `mcp__<serverId>__<normalizedToolName>` normalization 规则（保留 unicode，与 CC `recursivelySanitizeUnicode` 对齐）；(18) §20.1 必做清单加"MCP 集成接口预留（约 8 人日）"，§20.2 不做清单更新为"MCP server 真实连接 / Transport 实现 / OAuth / Resource 工具 / 自动重连等具体实现 Phase 3 完成" | v2 文档现状仅 5 件 MCP 相关定义（命名空间约定 / mcp.loading 事件字段 / status.update.mcp_status 字段名 / Plugin 注入承诺 / ToolRegistry 冲突优先级），完全没有 McpClient / McpTransport / McpRegistry 接口、transport 协议、OAuth 流程、ToolList 拉取时机、Elicitation 协议、Resource / Prompt 系统、自动重连、配置文件位置、企业策略、ApprovalSource mcp 分支、`mcp.loading` producer 等。如果 Phase 1 不预留接口，Phase 3 接 MCP 时被迫修改 9 个核心子系统的契约（ToolRegistry 同步→异步 / ApprovalSource 加 mcp 分支 / Wire 协议加 10+ method / PermissionRule 加 normalization / Tool 接口加 metadata / Plugin 加 injectMcp 钩子 / Hook 加 OnMcpElicitation / PathConfig 加 5 个路径方法 / ApprovalDisplay 加 elicitation kind），决策 #1（Wire 协议跨语言不变）以外的几乎所有内部契约都被破坏一次。CC 的 MCP 实现 ~13K 行（services/mcp/）已生产验证（含 OAuth + PKCE + step-up + XAA + elicitation + 6 层配置 + 8 种 transport），v2 取其精华去其复杂——只做 stdio + http 两种 transport（覆盖 90%+ server），只做基础 OAuth 2.0 + PKCE，不做 XAA / claudeai-proxy / sampling / sse-ide。kimi-cli Python 实战教训直接吸取：MCP tool 必须用 `mcp__server__tool` 前缀（v2 决策 #63 已选对）/ 100K 输出预算（Python `MCP_MAX_OUTPUT_CHARS`，Playwright 500KB DOM 撑爆教训）/ text + media 共享 budget / OAuth 401 散在 stdio handler 易过期（决策 #94 KosongAdapter 401 retry 已覆盖通用路径）/ stdio 不自动重连（Python 已踩，反复 spawn 死掉的 server bug 进程浪费资源）/ 没有 elicitation / 没有 resource 工具是 Python 的设计 gap（v2 Phase 3 补上）。pi-mono 完全没有 MCP 实现，参考价值 = 0。Phase 1 接口预留 8 人日 vs Phase 3 大重构 9 个子系统契约，明显划算。详见 plan `subagent-plans/plan/p0-mcp-integration-architecture.md` 和 §17A | **v2 新增 → Phase 6M（MCP 接口预留）** |
| 101 | **CompactionProvider tail user_message 契约** | **`CompactionProvider.run` 实现方必须保证：如果入参 `messages` 末尾包含一条未配对的 user_message（没有后续 assistant response），它必须以独立 message 形式出现在返回的 `output.summary` 数组末尾，不得被合并 / 改写 / 仅以摘要文本形式提及。同时 `TurnManager.executeCompaction` 在 `compactionProvider.run` 返回后做兜底校验——违反契约时 emit warning 并自动把 tail user_message 推回 summary 末尾，避免一份错误的 summary 直接 fail 整个 turn** | **避免 P0 bug：用户在大上下文末尾发短 prompt → 第 0 step 触发 compaction → user_message 被混进摘要文本块 → LLM 看不到独立的"待回应用户消息" → turn 0 步结束，用户 prompt 无响应。CC 的 `buildPostCompactMessages` 显式串接 `messagesToKeep`、pi-mono `keepRecentTokens=20K` 始终保 tail、Python `SimpleCompaction.max_preserved_messages=2` hardcode 保留最后 2 条都是对这个隐式合约的实现确认；v2 把它显式化为接口契约 + TurnManager 兜底自愈，避免 third-party CompactionProvider 实现遗漏。详见 plan `subagent-plans/plan/arch-roi-A-control-flow.md` 问题 1.2 + §6.4 / §6.12.2 注释** | **v2 新增 → arch-roi-A 修复批次 1** |
| 102 | **cancelBySource 同步语义边界** | **`ApprovalRuntime.cancelBySource(source: ApprovalSource): void` 同步 void 的承诺范围**：必须立即生效——in-memory waiter 立即 reject 成 cancelled、cancel event 立即 emit 到 EventSink；**不**承诺 synthetic cancelled response 落 wire.jsonl（走 SessionJournal fire-and-forget 异步追赶，与决策 #95 一致）、agent team 跨进程撤销（mailbox publish ApprovalCancel envelope 异步、远端 member daemon 自己 poll 处理）。崩溃窗口靠 `recoverPendingOnStartup` + request_id 去重兜住——最终一致 | review agent 担心"同步 void 与 SQLite 异步操作矛盾"，本质是承诺范围未明确。明确边界后：(1) §7.2 abort 标准顺序（cancelBySource → discardStreaming → controller.abort → await turnPromise）能成立——cancelBySource 不阻塞 controller.abort 的接力；(2) third-party ApprovalRuntime 实现者不会误把 SQLite await 写进 cancelBySource 路径；(3) Python `cancel_by_source`（`approval_runtime/runtime.py:149`）同样是同步函数，跨语言一致。设计本身已成立，不改代码，只显式化文档。详见 plan `subagent-plans/plan/arch-roi-A-control-flow.md` 问题 1.5 + §12.2 / §7.2 注释 | **v2 新增 → arch-roi-A 修复批次 1** |
| 103 | **NotificationRecord envelope_id + enqueueNotification 必须 await** | **(1)** `NotificationRecord.data` 新增 `envelope_id?: string` 字段——仅当通知由 team mail envelope 转入时填写（= `MailEnvelope.envelope_id`），本地产生的通知不填。用于 §9.4.1 启动恢复阶段的 envelope-level 幂等去重（扫描 SQL `status='delivered'` 的 envelope_id，去 wire index 查；查不到则重新 emit）。**(2)** `NotificationManager.emit` 的 async 签名显式标注为 `async (...): Promise<void>`，`TeamDaemonDeps.enqueueNotification` 签名已声明为 `(...) => Promise<void>`，TS 编译器强制 caller await。**(3)** §8.3.3 `TeamDaemon.handle` 的 `enqueueNotification` 调用处明确标注"**必须 await**"——保证"先 side-effect（durable 写入）后 ack"的 at-least-once 语义 | 防止"SQL 已 ack 但 ContextState 写入未发起"的通知丢失窗口。如果 `enqueueNotification` 签名声明为 `(...) => void`，TeamDaemon 不 await，崩溃时通知丢失。Python kimi-cli 的 3 状态机（`pending → claimed → acked`）提供了更精确的恢复模型，但 v2 用 `envelope_id` 字段 + at-least-once + type system 强制 await 的轻量方案已足够覆盖 Phase 1 需求。详见 plan `subagent-plans/plan/arch-roi-B-events.md` 问题 1.4 | **v2 新增 → arch-roi-B 修复批次 2** |
| 104 | **跨平台写入策略** | **§9.6 新增跨平台写入策略**：(1) 新增 `atomicWrite` 工具函数（tmp + fsync + rename），参考 Python kimi-cli `atomic_json_write` + CC `file.ts`；(2) `state.json` 用 `atomicWrite`；(3) compaction rollback 在 Windows 上先 `unlink` 新文件再 `rename`；(4) `wire.jsonl` append-only 不需 atomic；(5) SQLite WAL 自带跨平台锁；(6) `tool-results/` 的 `flag: 'wx'` 跨平台一致 | v2 隐含 POSIX rename-atomic 假设。Windows 上 `rename` 不保证 atomic 覆盖（Node.js `fs.rename` 底层走 `MoveFileEx`）。Python kimi-cli 1.27.0 已踩过"crash 导致 metadata 损坏"的坑并用 `atomic_json_write` 修复。CC 也有显式 tmp+rename 模式（`file.ts:434`）。v2 统一采用 `atomicWrite` 工具函数，Phase 1 成本极低（0.5 人日）。详见 plan `subagent-plans/plan/arch-roi-C-recovery.md` 问题 P3-POSIX | **v2 新增 → arch-roi-C 修复批次 2** |
| 105 | **统一启动恢复顺序** | **§9.7 新增统一启动恢复顺序**：`SoulPlus.create` 恢复阶段严格按 6 步执行——(1) compaction rollback → (2) replay wire.jsonl 重建 ContextState + SessionJournal（含 dangling tool_call / turn_end repair） → (3) ApprovalRuntime.recoverPendingOnStartup → (4) SkillManager 无状态启动 → (5) MCP 连接重建 → (6) TeamDaemon 恢复 mailbox polling。不引入 RecoveryCoordinator 抽象 | v2 §9 / §9.4.1 / §12.4 / §15.10 / §17A.1 / §6.4 共 6 处恢复策略各自定义"什么是 dangling"，但顺序依赖未显式写明。例如 compaction rollback 必须在 ContextState replay 之前（否则读到被 rollback 掉的 wire.jsonl），ApprovalRuntime 恢复依赖 ContextState 已重建的 turn_id 信息。CC 把恢复集中到 `deserializeMessagesWithInterruptDetection` 单一 pipeline，Python 在 `app.py` L219-221 串行写 3 个 recover 调用——两者都是"隐式顺序"。v2 选择显式化顺序契约 + 在 SoulPlus.create 内 hardcode 调用顺序（参考 Python 模式但加 docstring 标注）。详见 plan `subagent-plans/plan/arch-roi-C-recovery.md` 问题 2.2 | **v2 新增 → arch-roi-C 修复批次 2** |
| 106 | **EventSink seq 语义规范** | **§6.13.6 新增 seq 语义规范**：(1) seq 是 per-SessionEventBus 全局单调递增，不是 per-source；(2) subagent EventSink wrapper 转发事件到父 EventBus 时重新分配 seq；(3) client 用 `after_seq` 拉取事件时返回所有 source 的事件，不做 server 端 source 过滤；(4) seq 只保证因果一致（同一 Soul 内事件递增），不保证跨 Soul 实时一致；(5) Node.js 单线程保证 `++seqCounter` 原子 | v2 文档在两个互不一致的地方说 seq：铁律 4 说 EventSink.emit 返回 void（fire-and-forget），§6.13.6 说 `++this.seqCounter` 但没明确 seq 是全局还是 per-source。多个 subagent 并发 emit 时，client 拿到的 seq 序列是"多 source 交错"的全局序列——但 v2 之前没写明这一点。CC / pi-mono / Python 都没有 seq 概念（分别用 AsyncGenerator pull / callback / BroadcastQueue），只有 v2 引入了 seq——因此必须在 ADR 里写死语义。详见 plan `subagent-plans/plan/arch-roi-B-events.md` 问题 1.3 | **v2 新增 → arch-roi-B 修复批次 2** |
| 107 | **磁盘管理与清理策略** | **§9.8 新增磁盘管理与清理策略**：(1) wire.N.jsonl 归档保留 30 天，超过自动删除（`cleanupPeriodDays` 可配，默认 30）；(2) tool-results/ 文件在 compaction 时 GC（检查归档 wire 引用，无引用删除）；(3) subagent wire 目录完成后保留 7 天；(4) 启动后延迟 10 分钟清理 + 每小时后台检查 + `proper-lockfile` 跨进程互斥 | v2 全文搜索 "cleanup" / "rotation" / "GC" / "prune" = 0 处提及磁盘空间管理。wire.jsonl 永远 append，compaction 后 rename 不删除，tool-results/ 无清理策略，subagent wire 无清理。活跃用户 1 年累计 5-10GB。CC 的 `cleanup.ts`（604 行）用 `cleanupPeriodDays=30` + lockfile 跨进程互斥经生产验证。Python kimi-cli 只删空 session（`_delete_empty_session`），无尺寸/时间管理。pi-mono 完全没有清理。v2 直接采用 CC 的设计模型。详见 plan `subagent-plans/plan/arch-roi-C-recovery.md` 问题 7.5 | **v2 新增 → arch-roi-C 修复批次 2** |
| 108 | **Health Check / Self-Introspection API** | **§3.5 新增 3 个管理通道方法 + §17.8 新增 Self-Introspection API 章节**：(1) `session.dump`——导出 session 完整状态快照（lifecycle / context summary / journal stats / usage / subagents / team / current turn），debug 一键导出；(2) `session.healthcheck`——返回 session 健康度 + 检查项列表（journal_drain / lifecycle / broken / subagent_health），嵌入方监控用；(3) `core.metrics`（session_id="__process__"）——进程级指标快照（heap / rss / sessions / active_turns / uptime），Phase 2 加 HTTP `/health` + `/metrics` endpoint | v2 没有任何自检 API。生产环境出问题只能让用户上传 wire.jsonl + state.json，没有一键 dump。CC 有 `/doctor` + `/heapdump` + `/debug` + `/cost` + `/status` 5 个自检命令。Python kimi-cli 无 healthcheck。pi-mono 无。实现成本极低（1 天），ROI 极高——用户报 bug 时诊断时间从小时到分钟。Phase 1 只做骨架（基本字段），Phase 2 丰富（event_loop_lag / gc_count / open_fds）。详见 plan `subagent-plans/plan/arch-roi-E-infra.md` 问题 7.4 | **v2 新增 → arch-roi-E 修复批次 2** |
| 109 | **TurnManager 全拆分（4 个子组件 + 瘦身版 Turn Coordinator）** | **§6.4 拆分为 5 个子节**：§6.4.1 CompactionOrchestrator（6 deps，纯服务）/ §6.4.2 WakeQueueScheduler（0 deps，纯内存队列）/ §6.4.3 PermissionClosureBuilder（2 deps，纯函数）/ §6.4.4 TurnLifecycleTracker（0 deps，turn handle 管理）/ §6.4.5 TurnManager（瘦身版，13 deps 含 4 子组件引用，实际 mock 9 个外部 deps）。§6.1 services facade 加 compactionOrchestrator + permissionClosureBuilder，components facade 加 wakeScheduler + turnLifecycle。§6.2 启动顺序更新。§7.2 abort 标准顺序改调 lifecycle.cancelTurn。§8.3.3 TeamDaemon 的 enqueueWake 通过 TurnManager 窄 callback 透传。1 条 ADR（ADR-X.109）涵盖全部拆分 | 拆分前 TurnManager 持有 16 deps + 5 内部状态，是 SoulPlus 中最大的 god object（单测需 mock 80-120 行 setup）。Compaction 编排（lifecycle + journal + context）和 permission 闭包构造（orchestrator + rules）是完全无关的领域，却共享同一个 class——修改放大效应严重。CC 已把 compaction 拆到 `services/compact/` 独立目录（11 文件）、permission 拆到 `useCanUseTool.tsx` 独立 hook；pi-mono 把 compaction 拆到 `core/compaction/`、wake 队列拆到 `PendingMessageQueue` 独立类。v2 对齐这两个项目的拆分模式。拆分后每个子组件可独立测试（mock ≤ 6），TurnManager 的 compaction 和 permission 测试不再互相影响。详见 plan `subagent-plans/plan/p1-turnmanager-split.md` | **v2 新增 → TurnManager 全拆分** |
| 110 | **EventSink Backpressure 与 listener 契约** | **§6.13.6 新增 "Backpressure 与 listener 契约" 小节**：(1) listener 不应阻塞（< 1ms 内返回）；(2) eventLog 分类缓冲——状态事件 ring buffer 2000 条不丢、过程事件 ring buffer 8000 条溢出淘汰最旧；(3) lag 检测 `onLag(missedCount)` 回调；(4) subscriber 上限 10 个，超出返回 error。保证断线重连时状态事件完整，过程事件尽力而为 | arch-roi-B-events.md 问题 7.7：v2 的 eventLog 只有一个大数组 + shift 淘汰，无法区分"状态事件不能丢"和"过程事件可以丢"。断线重连时 content.delta 洪水会把 turn.end / tool.call 等关键事件挤出 eventLog。CC 没有 backpressure（async generator pull 模式天然有）；v2 的 push 模式需要显式契约 | **v2 新增 → arch-roi-B 修复** |
| 111 | **Cost Tracking 跨 provider** | **§6.12.5 新增 Cost Tracking 小节**：(1) CostCalculator 接口 + CostBreakdown 类型；(2) DefaultCostCalculator 内置 pricing 表，正则匹配 model name；(3) TurnManager.onTurnEnd 调 costCalculator.calculate，写入 turn_end 的 usage.cost_usd；(4) ContextState 维护 cumulativeCost；(5) Phase 1 不做 per-user 配额 / billing integration。附录 D 新增 CostCalculator / CostBreakdown 类型 | arch-roi-E-infra.md 问题 7.2：v2 的 TokenUsage 只有 input/output token 计数，没有 cost。CC 有 `/cost` 命令；Python kimi-cli 有 `_cost_tracker`。用户关心的是"这个 session 花了多少钱"而不是"用了多少 token"。CostCalculator 接口让未匹配模型返回 null（不猜），比 CC 的硬编码 pricing 更灵活 | **v2 新增 → arch-roi-E 修复** |
| 112 | **Soul 嵌入性坦诚降级 + Minimum Host 参考** | **§5.1.9 修改**：删除"10-15 行嵌入"误导性声明，改为实际估算（50-80 行核心代码 + 辅助类型）；明确嵌入价值是"可测试 + 可替换 host"而非"零成本接入"；新增 Minimum Embeddable Host 参考伪代码（~60 行，含 compaction 处理说明） | ar
| 113 | **SessionMeta 真相源化** | **新增 wire `session_meta_changed` patch record（按消费方分群的合并风格，区别于现有 5 个 ContextState config record 的独立风格）+ services facade 新增组件 `SessionMetaService`（统一 sessionMeta 内存视图与写入收口）+ wire 事件 `session_meta.changed`（patch + source）+ 三类字段分治（wire-truth title/tags/description/archived/color → 落 wire；derived last_model/turn_count/last_updated → 订阅 EventBus 聚合；runtime-only last_exit_code → 仅 state.json，与决策 #75 协同）+ §3.5 新增 `session.getMeta` / `session.setTags` 两个事务 method、`session.rename` 走 SessionMetaService + §3.6 新增 `session_meta.changed` event + §4.4 state.json 职责重新表述（"SessionMetaService 维护的内存视图的异步快照"，单一写者 + debounced 200ms flush）+ §6.13.7 新增 SessionMetaService 完整设计（接口骨架 / 写流程三步 / 派生字段订阅 / subagent 冒泡 / 同步事务路径）+ §9.7 新增 step 7 SessionMeta 重建子阶段（clean exit 信任 state.json / dirty exit replay wire 修正）。详见 ADR-X.113。** | **修复 `session.rename` 不落 wire 导致重启即丢的缺陷；统一 state.json 派生字段写入收口（解决多写者并发问题）；解锁 UI 实时感知元数据变化与 SoulPlus 内部消费者读取能力；不破坏现有 6 facade DAG 与 ContextState config 模型；不重构现有 5 个 config record（model_changed 等）；subagent 冒泡复用 §6.5 SoulRegistry wrapper 既有路径；同步事务路径与 setModel 共用 TransactionalHandlerRegistry；启动恢复折中策略（clean 快路径 + dirty replay）平衡性能与一致性。** | **v2 新增** |ch-roi-D-embedding.md 问题 2.3：§5.1.9 原文暗示"10-15 行就能嵌入 Soul"，但实际需要实现 SoulContextState（11+ 方法）、KosongAdapter（含 retry + overflow 检测）、EventSink、至少一个 Tool——远超 10 行。坦诚降级避免误导第三方嵌入方 | **v2 新增 → arch-roi-D 修复** |

---

## 附录 A：Wire 消息结构体 Zod Schema（示例）

```typescript
import { z } from "zod";

export const WireMessageSchema = z.object({
  id: z.string().regex(/^(req|res|evt)_/),
  time: z.number().int().positive(),
  session_id: z.string(),
  type: z.enum(["request", "response", "event"]),
  from: z.string(),
  to: z.string(),
  method: z.string().optional(),
  request_id: z.string().optional(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
  turn_id: z.string().optional(),
  agent_type: z.enum(["main", "sub", "independent"]).optional(),
  seq: z.number().int().nonnegative().optional(),
}).refine(
  (msg) => {
    if (msg.type === "request" || msg.type === "event") return !!msg.method;
    if (msg.type === "response") return !!msg.request_id;
    return false;
  },
  { message: "request/event must have method; response must have request_id" },
);

export type WireMessage = z.infer<typeof WireMessageSchema>;
```

### 附录 A.x：MCP Wire Events Schemas（Phase 1 必做接口预留）

决策 #100 / 详见 §17A。Phase 1 schema 简单即可（占位 + 关键字段），完整字段定义在 Phase 3 `RealMcpRegistry` 实现时按 §3.6 表格补齐；Phase 1 routing 阶段 `mcp.*` method 返回 NotImplemented，但 Wire event schema 必须落地以保证 client 能 parse。

```typescript
import { z } from "zod";

// 1. mcp.connected — server 连接成功
export const McpConnectedEventSchema = z.object({
  type: z.literal("mcp.connected"),
  server_id: z.string(),
  capabilities: z.array(z.string()).optional(),  // Phase 3 完善：tools / resources / prompts / elicitation
  tool_count: z.number().int().nonnegative().optional(),
});

// 2. mcp.disconnected — server 主动 / 被动断开
export const McpDisconnectedEventSchema = z.object({
  type: z.literal("mcp.disconnected"),
  server_id: z.string(),
  reason: z.enum(["user", "error", "shutdown", "timeout"]).optional(),
});

// 3. mcp.error — 连接失败 / 认证失败 / tool call 失败
export const McpErrorEventSchema = z.object({
  type: z.literal("mcp.error"),
  server_id: z.string(),
  error: z.string(),                              // 人类可读错误描述
  retry_in_ms: z.number().int().nonnegative().optional(),
});

// 4. mcp.tools_changed — server 推 list_changed 或重连后 ToolList 变化
export const McpToolsChangedEventSchema = z.object({
  type: z.literal("mcp.tools_changed"),
  server_id: z.string(),
  added: z.array(z.string()).default([]),
  removed: z.array(z.string()).default([]),
});

// 5. mcp.auth_required — server 401，等用户走 OAuth
export const McpAuthRequiredEventSchema = z.object({
  type: z.literal("mcp.auth_required"),
  server_id: z.string(),
  auth_url: z.string().url(),
});

// 6. mcp.resources_changed — server 推 resources/list_changed（Phase 3）
export const McpResourcesChangedEventSchema = z.object({
  type: z.literal("mcp.resources_changed"),
  server_id: z.string(),
});

// McpRegistrySnapshot — `mcp.list` 返回值 + `status.update.mcp_status` 字段
// Phase 1 schema 简单：servers 数组 + 每项 status / tool_count；Phase 3 完善 capabilities / last_error / oauth_status 等
export const McpRegistrySnapshotSchema = z.object({
  servers: z.array(z.object({
    server_id: z.string(),
    status: z.enum(["loading", "connected", "disconnected", "error", "auth_required"]),
    tool_count: z.number().int().nonnegative().optional(),
    last_error: z.string().optional(),
  })),
});

export type McpConnectedEvent = z.infer<typeof McpConnectedEventSchema>;
export type McpDisconnectedEvent = z.infer<typeof McpDisconnectedEventSchema>;
export type McpErrorEvent = z.infer<typeof McpErrorEventSchema>;
export type McpToolsChangedEvent = z.infer<typeof McpToolsChangedEventSchema>;
export type McpAuthRequiredEvent = z.infer<typeof McpAuthRequiredEventSchema>;
export type McpResourcesChangedEvent = z.infer<typeof McpResourcesChangedEventSchema>;
export type McpRegistrySnapshot = z.infer<typeof McpRegistrySnapshotSchema>;
```

> Phase 3 实现时再补：`capabilities` 完整 enum、`auth_url` 携带 PKCE state、`tool_count` 拆分为 `tools_count` / `resources_count` / `prompts_count`、`last_error.code` 标准化等。

---

## 附录 B：WireRecord（wire.jsonl 行级 schema）

```typescript
// wire.jsonl 每一行都是一个 WireRecord
// D2 ownership 约定：
// - 会改变 buildMessages() 结果的状态类 durable record 由 ContextState 写入
// - 审计 / lifecycle / 协作类管理 record 由 SessionJournal 写入
// - compaction 边界 record 由 TurnManager.executeCompaction → journalCapability.rotate 写入（决策 #93）
export const WireRecordSchema = z.discriminatedUnion("type", [
  // SessionJournal：turn 生命周期审计 record，不改变 buildMessages()
  z.object({
    type: z.literal("turn_begin"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    agent_type: z.enum(["main", "sub", "independent"]),
    // 真实 user turn 才写入 user 原始输入；input_kind="system_trigger" 的 turn
    // （teammate 消息 auto-wake、compaction、notification drain 等）不写 user_message，
    // 因此 user_input 对 system_trigger 侧必须允许缺省。对齐 §5.1.7 / §6.4 对
    // system_trigger 不追加 synthetic user_message 的约束。
    user_input: z.string().optional(),
    input_kind: z.enum(["user", "system_trigger"]),
    trigger_source: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn_end"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    agent_type: z.enum(["main", "sub", "independent"]),
    success: z.boolean(),
    reason: z.enum(["done", "cancelled", "error"]),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_tokens: z.number().optional(),
      cache_write_tokens: z.number().optional(),
      cost_usd: z.number().optional(),
    }).optional(),
  }),
  // ContextState：对话状态 record，会改变 buildMessages()
  z.object({
    type: z.literal("user_message"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal("assistant_message"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    text: z.string().nullable(),
    think: z.string().nullable(),
    tool_calls: z.array(z.object({
      id: z.string(),
      name: z.string(),
      args: z.unknown(),                   // 对齐附录 D.2 / §10 的 args 命名
    })),
    model: z.string(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_tokens: z.number().optional(),
    }).optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    tool_call_id: z.string(),
    output: z.unknown(),
    is_error: z.boolean().optional(),
    // 决策 #98 / Tool UI 渲染契约：result_display + collapsed_summary 落 wire.jsonl，
    // plugin / MCP 进程崩溃后 client 重连仍能 replay 渲染。
    result_display: ToolResultDisplaySchema.optional(),
    collapsed_summary: z.string().optional(),
  }),
  // TurnManager.executeCompaction → journalCapability.rotate：compaction 边界 record（决策 #93）
  z.object({
    type: z.literal("compaction"),
    seq: z.number(),
    time: z.number(),
    summary: z.string(),                // LLM 生成的结构化摘要
    compacted_range: z.object({
      from_turn: z.number(),
      to_turn: z.number(),
      message_count: z.number(),
    }),
    pre_compact_tokens: z.number(),
    post_compact_tokens: z.number(),
    trigger: z.enum(["auto", "manual"]),
    archive_file: z.string().optional(), // "wire.1.jsonl"（轮转时有）
  }),
  // ContextState：config 类 record，会改变后续投影的 system prompt / model / tools 等
  z.object({
    type: z.literal("system_prompt_changed"),
    seq: z.number(),
    time: z.number(),
    new_prompt: z.string(),
  }),
  z.object({
    type: z.literal("model_changed"),
    seq: z.number(),
    time: z.number(),
    old_model: z.string(),
    new_model: z.string(),
  }),
  z.object({
    type: z.literal("thinking_changed"),
    seq: z.number(),
    time: z.number(),
    level: z.string(),
  }),
  z.object({
    type: z.literal("plan_mode_changed"),
    seq: z.number(),
    time: z.number(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("tools_changed"),
    seq: z.number(),
    time: z.number(),
    operation: z.enum(["register", "remove", "set_active"]),
    tools: z.array(z.string()),
  }),
  // ContextState：system_reminder 是 LLM 能看到的 durable 对话事件，走
  // FullContextState.appendSystemReminder（见 §4.5.2），Projector 投影时组装为
  // <system-reminder> 包裹的系统消息（和 CC 对齐）。Phase 6E 后不再走 SessionJournal，
  // consumed_at_turn 字段也不再使用（reminder 不再有"被 consume"的语义，它永久留在 transcript 里）。
  z.object({
    type: z.literal("system_reminder"),
    seq: z.number(),
    time: z.number(),
    content: z.string(),
    // 历史字段，Phase 6E 后弃用。保留以便读取旧 wire 文件时不会因为 schema mismatch 报错
    consumed_at_turn: z.number().optional(),
  }),
  // ContextState：notification 是 LLM 能看到的 durable 对话事件，走
  // FullContextState.appendNotification（见 §4.5.2）。Projector 投影时组装为系统消息。
  z.object({
    type: z.literal("notification"),
    seq: z.number(),
    time: z.number(),
    data: z.object({
      id: z.string(),
      category: z.enum(["task", "agent", "system"]),
      type: z.string(),
      source_kind: z.string(),
      source_id: z.string(),
      title: z.string(),
      body: z.string(),
      severity: z.enum(["info", "success", "warning", "error"]),
      payload: z.record(z.unknown()).optional(),
      targets: z.array(z.enum(["llm", "wire", "shell"])),
      dedupe_key: z.string().optional(),
      delivered_at: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal("team_mail"),
    seq: z.number(),
    time: z.number(),
    data: z.object({
      mail_id: z.string(),
      reply_to: z.string().optional(),
      from_agent: z.string(),
      to_agent: z.string(),
      content: z.string(),
      summary: z.string().optional(),
    }),
  }),
  // ===== Subagent 生命周期三件套（父 wire 只记引用，子事件独立存在 subagents/<agent_id>/wire.jsonl）=====
  // 决策 #88：旧的 subagent_event 嵌套包装方案已废弃；父 wire 只记 spawned / completed / failed 三条
  // 生命周期 record，实时 UI 推送走 EventSink wrapper 加 source 标记转发到共享 EventBus（见 §4.8 / §6.5）。
  z.object({
    type: z.literal("subagent_spawned"),
    seq: z.number(),
    time: z.number(),
    data: z.object({
      agent_id: z.string(),                        // 子 agent 的唯一 id，对应 subagents/<agent_id>/ 目录
      agent_name: z.string().optional(),           // 人类可读名（UI badge 展示用）
      parent_tool_call_id: z.string(),             // 发起 spawn 的 tool_call id
      parent_agent_id: z.string().optional(),      // 递归 subagent 时：谁创建了我（主 agent 不填）
      run_in_background: z.boolean(),              // foreground（父 await）vs background（发 notification）
    }),
  }),
  z.object({
    type: z.literal("subagent_completed"),
    seq: z.number(),
    time: z.number(),
    data: z.object({
      agent_id: z.string(),
      parent_tool_call_id: z.string(),
      result_summary: z.string(),                  // 回传给父 agent 的聚合文本
      usage: z.object({                            // 子 agent 累计 token 用量（对齐 TokenUsage）
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        cache_read: z.number().int().nonnegative().optional(),
        cache_write: z.number().int().nonnegative().optional(),
      }).optional(),
    }),
  }),
  z.object({
    type: z.literal("subagent_failed"),
    seq: z.number(),
    time: z.number(),
    data: z.object({
      agent_id: z.string(),
      parent_tool_call_id: z.string(),
      error: z.string(),                           // 人类可读失败原因
    }),
  }),
  z.object({
    type: z.literal("ownership_changed"),
    seq: z.number(),
    time: z.number(),
    old_owner: z.string().nullable(),
    new_owner: z.string(),
  }),
  // SessionJournal：skill 执行审计 record（决策 #99 新增 invocation_trigger / query_depth）
  z.object({
    type: z.literal("skill_invoked"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    agent_type: z.enum(["main", "sub", "independent"]).optional(), // 由对应 turn_begin 推断,缺省时回退到 main
    data: z.object({
      skill_name: z.string(),
      execution_mode: z.enum(["inline", "fork"]),
      original_input: z.string(),
      // 决策 #99：三种触发口径分类（见 §15.4.1）
      invocation_trigger: z.enum(["user-slash", "claude-proactive", "nested-skill"]),
      query_depth: z.number().int().nonnegative().optional(),  // 仅 nested-skill 时 > 0
      sub_agent_id: z.string().optional(),  // 仅 fork 模式写入，用于和对应的 subagent 流水线关联（对齐 §15.7）
    }),
  }),
  z.object({
    type: z.literal("skill_completed"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    agent_type: z.enum(["main", "sub", "independent"]).optional(), // 由对应 turn_begin 推断,缺省时回退到 main
    data: z.object({
      skill_name: z.string(),
      execution_mode: z.enum(["inline", "fork"]),
      success: z.boolean(),
      error: z.string().optional(),
      // 决策 #99：镜像 skill_invoked 同步字段（保持成对）
      invocation_trigger: z.enum(["user-slash", "claude-proactive", "nested-skill"]),
      query_depth: z.number().int().nonnegative().optional(),
      sub_agent_id: z.string().optional(),
    }),
  }),
  // ContextState：逻辑编辑 / rewind 会改变后续 buildMessages()
  z.object({
    type: z.literal("context_edit"),  // 预留能力，确保 append-only 下的逻辑编辑
    seq: z.number(),
    time: z.number(),
    operation: z.enum(["edit_message", "delete_message", "rewind", "insert_message", "replace_message"]),
    target_seq: z.number().optional(),    // edit/delete/replace 的目标消息 seq
    to_turn: z.number().optional(),       // rewind 的目标 turn
    after_seq: z.number().optional(),     // insert 的插入位置
    new_content: z.string().optional(),   // edit/replace/insert 的新内容
    new_role: z.enum(["user", "assistant", "system"]).optional(),  // replace/insert 时可选改角色
    cascade: z.boolean().optional(),      // delete 时是否级联删除整个 turn
  }),
  // SessionJournal：approval / permission 审计 record，不进入 projector
  // ===== 以下 5 种 record 由 §11 / §12 / §10.7 引入,参考 §12.2 / §11.3 =====
  z.object({
    type: z.literal("approval_request"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    step: z.number(),
    data: z.object({
      request_id: z.string(),              // ApprovalRuntime 分配的唯一 id
      tool_call_id: z.string(),            // 关联 AssistantMessage.tool_calls[].id
      tool_name: z.string(),
      action: z.string(),                  // 具体操作的简短标识(例如 "run_command")
      display: ApprovalDisplaySchema,      // 展示给用户的内容,见辅助类型
      source: ApprovalSourceSchema,        // 请求来源(main / subagent / skill ...)
    }),
  }),
  z.object({
    type: z.literal("approval_response"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    step: z.number(),
    data: z.object({
      request_id: z.string(),              // 对应 approval_request.data.request_id
      response: z.enum(["approved", "rejected", "cancelled"]),
      feedback: z.string().optional(),     // 用户附带的反馈或拒绝理由
      synthetic: z.boolean().optional(),   // 崩溃恢复时由系统写入的 synthetic cancelled
    }),
  }),
  z.object({
    type: z.literal("tool_call_dispatched"),  // §12.4 崩溃恢复表格引用
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    step: z.number(),
    data: z.object({
      tool_call_id: z.string(),
      tool_name: z.string(),
      args: z.unknown(),                              // tool 参数原样落盘(对齐附录 D.2 / §10 的 args 命名)
      assistant_message_id: z.string(),               // 关联到产生 tool_call 的 assistant message
      // 决策 #98 / Tool UI 渲染契约：display hint 落盘，replay 友好
      activity_description: z.string().optional(),    // tool.call.description（getActivityDescription 输出）
      user_facing_name: z.string().optional(),        // tool.call.user_facing_name（getUserFacingName 输出）
      input_display: ToolInputDisplaySchema.optional(), // tool.call.input_display（getInputDisplay 输出 + orchestrator diff enrichment）
    }),
  }),
  z.object({
    type: z.literal("permission_mode_changed"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string().optional(),        // 非 turn 内触发时(启动时)可空
    data: z.object({
      from: z.string(),                    // "ask" | "auto" | "bypass"
      to: z.string(),
      reason: z.string(),                  // 变更理由(命令、UI 动作等)
    }),
  }),
  z.object({
    type: z.literal("tool_denied"),
    seq: z.number(),
    time: z.number(),
    turn_id: z.string(),
    step: z.number(),
    data: z.object({
      tool_call_id: z.string(),
      tool_name: z.string(),
      rule_id: z.string(),                 // 触发 deny 的 PermissionRule.id
      reason: z.string(),                  // 人类可读的拒绝原因
    }),
  }),
  // SessionJournal：session 元数据变更 record（决策 #113 / SessionMetaService）。
  // 由 SessionMetaService 消费，不进 LLM messages（不归 ContextState 管）；
  // 与现有 5 个 ContextState config record（model_changed / system_prompt_changed 等）
  // 同源不同流：config record 异质多 consumer 已 stable，保留独立；sessionMeta
  // 字段同质 + 单一 consumer + 高频扩展，合并为单一 patch record。详见 §6.13.7 / ADR-X.113。
  z.object({
    type: z.literal("session_meta_changed"),
    seq: z.number(),
    time: z.number(),
    // patch 字段语义为 partial update：未填字段保持原值；replay 按 seq 顺序合并。
    // tags 是全量替换（不是 add/remove patch），避免 atomic operation 的复杂性。
    patch: z.object({
      title: z.string().optional(),
      tags: z.array(z.string()).optional(),
      description: z.string().optional(),    // Phase 2+
      archived: z.boolean().optional(),      // Phase 2+
      color: z.string().optional(),          // Phase 2+
    }),
    // 变更来源（与 ContextState 系列 *.changed 事件的语义对齐，便于审计）：
    //   - "user"   : 用户显式触发（session.rename / session.setTags 等）
    //   - "auto"   : 系统自动生成（首次 turn 后 auto-generate title 等）
    //   - "system" : 迁移 / 启动恢复 / 内部修复
    source: z.enum(["user", "auto", "system"]),
    reason: z.string().optional(),           // 可选自由文本说明
  }),
]);

export type WireRecord = z.infer<typeof WireRecordSchema>;

// ===== 辅助类型:ToolInputDisplay / ToolResultDisplay / ApprovalDisplay / ApprovalSource =====
// ToolInputDisplay / ToolResultDisplay 由决策 #98 引入（Tool UI 渲染契约，§10.7）。
// ApprovalDisplay 在决策 #98 后收编为 ToolInputDisplay 的别名（同源同构）。
// 这些类型供 approval_request.data.display / tool_call_dispatched.data.input_display /
// tool_result.result_display 共享使用。

// 决策 #98：Tool 入参渲染 hint。同时充当 ApprovalDisplay。
export const ToolInputDisplaySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),            // Bash 命令（旧 ApprovalDisplay.command 的超集）
    command: z.string(),
    cwd: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal("file_io"),            // Read / Write / Edit 占位（orchestrator 可升级为 diff）
    operation: z.enum(["read", "write", "edit"]),
    path: z.string(),
    range: z.object({ start: z.number(), end: z.number() }).optional(),
  }),
  z.object({
    kind: z.literal("diff"),               // Edit / patch（orchestrator 升级 file_io 后产出）
    path: z.string(),
    before: z.string(),
    after: z.string(),
  }),
  z.object({
    kind: z.literal("file_write"),         // Write 完整写入预览（旧 ApprovalDisplay.file_write 兼容）
    path: z.string(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal("search"),             // Grep / Glob 等
    query: z.string(),
    scope: z.string().optional(),
    flags: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("url_fetch"),          // WebFetch
    url: z.string(),
    method: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent_call"),         // AgentTool subagent 调用
    agent_name: z.string(),
    prompt: z.string(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("skill_call"),         // SkillTool 调用（决策 #99 / Skill 自主调用）
    skill_name: z.string(),
    arguments: z.string().optional(),
  }),
  z.object({
    kind: z.literal("todo_list"),          // 对齐 Python TodoDisplayBlock
    items: z.array(z.object({
      title: z.string(),
      status: z.enum(["pending", "in_progress", "done"]),
    })),
  }),
  z.object({
    kind: z.literal("background_task"),    // 对齐 Python BackgroundTaskDisplayBlock
    task_id: z.string(),
    kind: z.string(),
    status: z.string(),
    description: z.string(),
  }),
  z.object({
    kind: z.literal("task_stop"),          // Task 中止审批（§12.2 / §8.3 兼容）
    task_id: z.string(),
    task_description: z.string(),
  }),
  z.object({
    kind: z.literal("generic"),            // 其余 tool 通用 / 长尾未识别 fallback
    summary: z.string(),
    detail: z.unknown().optional(),
    // 旧 ApprovalDisplay.generic 的 title/body 兼容字段（实现可同时支持读写）
    title: z.string().optional(),
    body: z.string().optional(),
  }),
]);

export type ToolInputDisplay = z.infer<typeof ToolInputDisplaySchema>;

// 决策 #98 / Tool UI 渲染契约：ApprovalDisplay 收编为 ToolInputDisplay 的别名
export const ApprovalDisplaySchema = ToolInputDisplaySchema;
export type ApprovalDisplay = ToolInputDisplay;

// 决策 #98：Tool 结果渲染 hint
export const ToolResultDisplaySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command_output"),
    stdout: z.string(),
    stderr: z.string().optional(),
    exit_code: z.number(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("file_content"),
    path: z.string(),
    content: z.string(),
    range: z.object({ start: z.number(), end: z.number() }).optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("diff"),
    path: z.string(),
    before: z.string(),
    after: z.string(),
    hunks: z.array(z.object({
      old_start: z.number(),
      new_start: z.number(),
      old_lines: z.number(),
      new_lines: z.number(),
    })).optional(),
  }),
  z.object({
    kind: z.literal("search_results"),
    query: z.string(),
    matches: z.array(z.object({
      file: z.string(),
      line: z.number(),
      text: z.string(),
      context_before: z.array(z.string()).optional(),
      context_after: z.array(z.string()).optional(),
    })),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("url_content"),
    url: z.string(),
    status: z.number(),
    content_type: z.string().optional(),
    preview: z.string(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("agent_summary"),
    agent_name: z.string(),
    steps: z.number(),
    token_usage: z.object({ input: z.number(), output: z.number() }).optional(),
    final_message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("background_task"),
    task_id: z.string(),
    status: z.string(),
    description: z.string(),
  }),
  z.object({
    kind: z.literal("todo_list"),
    items: z.array(z.object({
      title: z.string(),
      status: z.enum(["pending", "in_progress", "done"]),
    })),
  }),
  z.object({
    kind: z.literal("structured"),
    data: z.unknown(),
    schema_hint: z.string().optional(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("error"),
    message: z.string(),
    recoverable: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("generic"),
    summary: z.string(),
    detail: z.unknown().optional(),
  }),
]);

export type ToolResultDisplay = z.infer<typeof ToolResultDisplaySchema>;

// ApprovalSource 使用 discriminated union,对齐 §12.2 / §11.7 / §6.4 四处用法:
//   - "soul"     : main / subagent 内部 beforeToolCall 闭包发起的审批(§11.7)
//   - "subagent" : foreground subagent 显式委托(§12.2)
//   - "turn"     : TurnManager 级别(例如 compaction 审批)按 turn 取消(§6.4 / §12.5 cancelBySource)
//   - "session"  : session shutdown 时按整个 session 批量取消(§12.5 cancelBySource)
export const ApprovalSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("soul"),
    agent_id: z.string(),                  // "main" / "sub:<id>"
  }),
  z.object({
    kind: z.literal("subagent"),
    agent_id: z.string(),                  // 子 agent 身份
  }),
  z.object({
    kind: z.literal("turn"),
    turn_id: z.string(),                   // 关联的 turn id(按 turn 批量取消时使用)
  }),
  z.object({
    kind: z.literal("session"),
    session_id: z.string(),                // session shutdown 时按整个 session 批量取消
  }),
]);

export type ApprovalSource = z.infer<typeof ApprovalSourceSchema>;
```

---

## 附录 C：v1 → v2 变更 cheat sheet

本附录收录完整的 v1 → v2 以及 v2 初稿 → v2 终稿的变更对照。速读用 C.1 / C.2 的 markdown 表格，查细节用 C.3 的 diff 全景图。

### C.1 v1 → v2 变更对照表（关键结构性变更）

| 领域 | v1 | v2 |
|---|---|---|
| **Session 存储** | 三文件：`context.jsonl` + `wire.jsonl` + `state.json` | **两文件**：`wire.jsonl`（append-only，session 对话状态与会话审计记录的唯一持久化真相源） + `state.json`（只做 title/session list 的派生缓存） |
| **Soul 定位** | `ManagedSession` 内部持有 Soul 实例，隐式封装 | **显式命名 Soul / SoulPlus**：Soul 是纯状态机，SoulPlus 是多 Soul 实例的注册表 + 请求路由器 |
| **Wire 信封字段** | `{id, session_id?, type, method, request_id, data, error, seq}` | 极繁主义扩展：**加 `time` / `from` / `to` / `turn_id` / `agent_type`**；`session_id` 从可选变必选 |
| **多 agent loop 并发** | 文字描述"Node 事件循环天然支持" | **双模型**：task subagent = 同进程 Soul 实例；agent team member = 独立进程 SoulPlus |
| **Agent Team 通信** | 未设计 | **SQLite 消息总线**（team_mails 表）+ TeamMail Wire 事件 + mail_id/reply_to 关联 |
| **消息注入时机** | 未设计 | **三类**：auto-wake（idle 启动 turn）、passive（等用户下次消息）、immediate（当前 turn 内） |
| **Notification** | 未持久化 | **落盘 + targets 分发**（llm/wire/shell），`llm` target 直接通过 `ContextState.appendNotification` 做 durable 写入（Phase 6E 定稿；v2 初稿曾走 read-side 一次性注入，见决策 #89） |
| **Context 编辑** | 未明确 | 通过 **append 事件 + 内存重放** 完成（保持 append-only），不直接改文件 |
| **Crash recovery** | 有 `repairDanglingToolCalls` 等兜底 | **被动 journal repair**（resume 时从 wire.jsonl 补 synthetic `tool_result` 等 record 回补 dangling 状态）取代 forge 风格的主动修复；极端场景"炸了就炸了" |
| **Agent 类型** | 未明确区分 | 显式字段 `agent_type: main / sub / independent` |
| **UI 友好性** | 未专门设计 | 事件增加 `description`、`usage`、`error_type`、`agent_name` 等 UI 展示字段 |
| **路径配置** | 硬编码 `~/.kimi` | **单一 `KIMI_HOME` 环境变量** + PathConfig 服务，完全实例隔离 |
| **Skill 系统** | 未设计 | **SkillManager + inline/fork 执行 + TurnOverrides（不修改 ContextState）** |
| **Plugin 系统** | 未设计 | **plugin.json 清单 + 注入 Tools/Skills/Agents/MCP/Hooks** |
| **Hook 可扩展** | 硬编码类型 | **HookExecutor 接口 + HOOK_EXECUTOR_REGISTRY 注册表** |
| **SoulPlus 架构** | 单一 class | **三层 DAG**（D10）：共享资源层（`SessionLifecycleStateMachine` / `SoulLifecycleGate` / `JournalWriter` / `WiredContextState` / `SessionJournal`）→ 服务层（`Runtime` / `ConversationProjector` / `ApprovalRuntime` / `ToolCallOrchestrator` / `MemoryRuntime` 占位）→ 行为组件层（`RequestRouter` / `TurnManager` / `SoulRegistry` / `SkillManager` / `NotificationManager` / `TeamDaemon`） |
| **wire.jsonl 版本管理** | 无版本号 | **metadata header（protocol_version）+ skip+warn 未知类型 + semver 规则** |
| **Transport 层** | 只列名字无接口 | **显式 Transport 接口（callback 风格）+ TransportServer + WireCodec 分层** |
| **Permission 系统** | 仅 approval 双向 RPC | **SoulPlus 内部消化：PermissionRule 规则引擎 + 3 种 PermissionMode + `beforeToolCall` 单一 approval gate（Soul 零 permission 词汇）** |
| **Tool 系统** | 未设计 | **ToolRegistry + `__` 双下划线命名空间 + ToolDefinition 接口** |
| **ContextState 身份** | 未明确 | **`SoulContextState` / `FullContextState` 双接口；状态类 durable 写走 ContextState，管理类 record 写走 SessionJournal，底层共享 JournalWriter** |

v1 已经拍板的决策全部继承（EventSink、ManagedSession（v2 已更名为 SoulPlus）、非阻塞 prompt、Hook 双通道、扁平事件、delta 模式、五通道路由、Transport 可插拔、Wire First）。

### C.2 v2 初稿 → v2 终稿变更对照表（Phase 1-4 后的重划）

v2 初稿在 Phase 1-4 的多轮审议中又发生了一次 Soul / SoulPlus 边界重划，核心变化集中在 permission / tool / context state 三块。下面的差异不是"v1 → v2"而是"v2 初稿 → v2 终稿"：

| 领域 | v2 初稿 | v2 终稿（Phase 1-4 后） |
|---|---|---|
| **Soul 形态** | class + 实例状态 + `this.runTurn(...)` | 无 this 的 async function `runSoulTurn(...)`，无 class 无 `this`，import whitelist 由 tsconfig + ESLint 强制 |
| **Soul 对 permission 的感知** | Soul 内置"7 层权限检查链"，Tool 还要实现 `checkPermissions` / `selfCheck` | Soul 零 permission 词汇（铁律 2），7 层检查链整段删除，规则匹配退化为 SoulPlus 内部一个纯函数 `checkRules`，Tool 接口里所有 permission 方法全部删除 |
| **权限的唯一 gate** | 7 层检查链分散在 Soul 和 Tool 双方 | `SoulConfig.beforeToolCall` 单一 approval gate，SoulPlus 把规则 baked 进闭包后透传给 Soul，Soul 只管 await |
| **Tool 接口** | `{name, description, inputSchema, execute, checkPermissions, selfCheck, validateInput, canUseTool, description() fn, prompt() fn}` | 极简四件套：`{name, description, inputSchema, execute(id, args, signal, onUpdate?)}`；外部依赖通过 constructor 注入，不走 `execute` 的 `ctx` 参数 |
| **Runtime 接口** | 含 `permissionChecker` 字段 + 各种闲杂能力 | 窄接口（决策 #93 后 Phase 1 终稿）：`{kosong}` 一个字段；compactionProvider / lifecycle / journal 已下沉到 TurnManagerDeps（不属于 Soul 视图）；不含任何 permission / approval 字段 |
| **Soul ↔ SoulPlus 通信** | 一根混合通道（ContextState 或 EventSink 二选一不清晰） | 双通道：**ContextState**（async 写状态，await WAL fsync）+ **EventSink**（fire-and-forget UI / 遥测），语义不互相污染 |
| **ContextState 接口** | 单一 `ContextState` 接口，Soul 可见 SoulPlus 独有写法 | 一分为二：`SoulContextState`（Soul 看到的窄视图）+ `FullContextState extends SoulContextState`；状态类 durable 写走 ContextState，管理类 record 写走 SessionJournal |
| **Durable 写入边界** | 默认 `ContextState` 是所有 wire record 的唯一入口 | 新增 `SessionJournal` 作为管理类 record 的窄写门；`JournalWriter` 是唯一物理 ordering point |
| **对话读侧投影** | `buildMessages()` 逻辑散落在 ContextState / Soul / 恢复路径 | 新增最小化 `ConversationProjector`：`ContextSnapshot -> provider-neutral Message[]`，`buildMessages()` 内部委托给 projector；不再有任何 turn-scope 的 "ephemeralInjections" |
| **Notification / Reminder 注入机制** | 旧方案：`SessionJournal.appendNotification` 窄门审计 + `TurnManager.pendingNotifications` 缓冲 + `ConversationProjector.ephemeralInjections` 读侧注入；通知/提醒只在下一 turn 被 Soul 看到一次后就从 transcript 中消失 | **新方案**：notification / system reminder / memory recall 直接走 `ContextState.appendNotification` / `appendSystemReminder` 做 durable 写入，作为对话事件进 transcript，和 `user_message` / `assistant_message` 并列；Projector 每次从 snapshot 重新组装它们为 LLM message。消除"Turn N LLM 看到 notification 并做了引用 → Turn N+1 看不到"的因果断裂 |
| **TurnOverrides** | 单一对象同时供 Soul 和 TurnManager 消费 | 一分为二：`FullTurnOverrides`（TurnManager/SkillManager 内部）vs `SoulTurnOverrides`（Soul 看到的，仅 `model/effort/activeTools`，且 activeTools 在 Soul 侧只做 LLM visibility filter），权限相关 override 由 TurnManager 转成 turn-scope rule baked 进 `beforeToolCall` 闭包 |
| **Approval 系统** | 嵌在 §11 Permission 章节里的一个子节 | 独立出 §12 章节，`ApprovalRuntime` 接口完整定义（`request / resolve / cancelBySource / recoverPendingOnStartup`），崩溃恢复路径明确 |
| **Compaction 控制权** | SoulPlus 从外面侵入 Soul 循环 | **触发检测在 Soul，执行流程在 TurnManager**（决策 #93 / 铁律 7）：Soul 在 `runSoulTurn` while 顶部 safe point 检测 token 超阈值，通过 `TurnResult.reason: "needs_compaction"` 上报；TurnManager.startTurn 改为 while 循环，遇到 `needs_compaction` 调 `executeCompaction`（lifecycle 切换 / summary 生成 / wire rotate / context reset 五步）然后重启 Soul 接续同一 turn_id；Soul 类型上完全看不到 lifecycle / journal / compactionProvider 概念，Runtime 收窄为只含 `kosong` |
| **Streaming 进度** | 写 wire.jsonl 以便崩溃恢复 | 走 EventSink 不进 wire.jsonl；崩溃恢复只需最终 tool_result / assistant_message |
| **Subagent 事件传播** | 父 wire 通过 `subagent.event` record 嵌套包装子事件（递归 subagent 会无限嵌套） | 独立存储 + source 标记转发：每个 agent 有自己的 `subagents/<agent_id>/wire.jsonl`（扁平、`parent_agent_id` 字段重建父子关系）；父 wire 只记 `subagent_spawned/completed/failed` 三条生命周期引用；实时 UI 推送由 SoulRegistry 注入的 EventSink wrapper 加 `source: { id, kind, name }` 转发到共享 EventBus；`source` 仅存在于传输层，不污染 wire 持久化层 |
| **Agent Team 通信层** | 硬编码 SQLite + 单一 `TeamMailRepo` 接口（消息/注册/心跳三职责混合），TeamDaemon 直接绑定 SQLite schema | **`TeamCommsProvider` 可插拔接口**：拆分成三个窄接口 `TeamMailbox`（消息通道）/ `TeamRegistry`（成员注册表）/ `TeamHeartbeat`（心跳），由 `TeamCommsProvider` 组合；SQLite 实现下沉为 Phase 1 默认 provider（schema 不变，只是被封装进 `SqliteTeamComms`）；Memory provider 作为 Phase 1 测试实现；File / Redis 作为 Phase 2+/3+ 扩展；Phase 1 强制加入消息优先级处理（`shutdown_request > approval_* > team_mail`）和定期清理（`mailbox.cleanup(24h)`）以避免 CC 文件 inbox 的去重/膨胀教训 |

这些变化对应新增决策 **#78-#94**（其中 #91 措辞精化、#92 SoulPlus facade 聚合、#93 compaction 移出 Soul + 铁律 7、#94 401/connection retry 归 Kosong 是 Phase 6G/H/I 的后续修订），并在附录 **ADR-X**（双通道通信的架构选型）里有详细推导。

### C.3 diff 全景图（按子系统维度）

下面的 diff 代码块按子系统维度列出更细粒度的变更（含 C.1 / C.2 已覆盖的条目，以 diff 形式呈现便于单子系统速查）。

```diff
  Kimi Core TS 设计
  
  Wire 协议
  - id, session_id?, type, method?, request_id?, data?, error?, seq?
  + id, time, session_id, type, method?, request_id?, data?, error?, turn_id?, agent_type?, from, to, seq?
    (session_id 从可选改必选；加 time/from/to/turn_id/agent_type)
  + 新增事件字段：turn.begin+input_kind/trigger_source, turn.end+usage,
    tool.call+description, session.error+error_type/retry_after_ms,
    subagent.spawned+agent_name（取代旧 subagent.event+agent_name）
  + 新增事件类型：team_mail（soul-to-soul 通信）、notification（落盘）
  + Subagent 事件模型（决策 #88）：去掉 subagent.event 嵌套包装；
    父 wire 只记 subagent_spawned/completed/failed 三条生命周期引用；
    子事件独立落盘到 subagents/<agent_id>/wire.jsonl；
    实时 UI 由 SoulRegistry 注入的 EventSink wrapper 加 source 标记转发到共享 EventBus
  
  存储模型
  - context.jsonl + wire.jsonl + state.json  (3 文件)
  + wire.jsonl + state.json                  (2 文件)
    (context 合并进 wire，append-only，内存 replay 构建 ContextState)
  + SQLite team_comms.db                     (agent team 通信总线)
  
  Session 封装
  - ManagedSession (持有 Soul class 和 Runtime)
  + SoulPlus (多 Soul 注册表 + 请求路由器 + auto-wake) + runSoulTurn 函数 (纯状态机)
    (命名变更 + 角色明确 + 多 Soul 实例并发 + wakeQueue 机制)
  
  多 Agent 架构
  - (无明确区分)
  + 双模型：task subagent (同进程 Soul) / agent team (多进程 SoulPlus + SQLite)
  + mail_id + reply_to 消息关联
  + auto-wake / passive / immediate 三种注入时机
  + Leader daemon 100ms 轮询 SQLite
  + AgentBackendBridge 可插拔后端（SQLite 统一总线，不区分 Kimi/CC/Codex）
  + BACKEND_REGISTRY 工厂模式（当前只实现 KimiCliBridge）
  
  路径配置
  - (硬编码 ~/.kimi)
  + 单一 KIMI_HOME 环境变量，PathConfig 服务派生所有路径
  + 完全实例隔离（不同 KIMI_HOME = 零数据交叉）
  + 零硬编码路径（代码中不允许 ~/.kimi 字面量）
  
  Skill 系统
  - (未设计)
  + SkillManager（SoulPlus 层面，Soul 不知道 Skill 存在）
  + inline/fork 两种执行模式
  + TurnOverrides 参数传递（不修改 ContextState，避免 setModel 冲突）
  + 模板变量（$ARGUMENTS, ${KIMI_SKILL_DIR}）
  + skill.invoked / skill.completed Wire 事件

  Plugin 系统
  - (未设计)
  + plugin.json 清单 + 注入 Tools/Skills/Agents/MCP/Hooks
  + local dir / git URL 安装
  + Plugin tool 子进程执行 + host values 注入

  Hook 可扩展
  - (硬编码类型)
  + HookExecutor 接口 + HOOK_EXECUTOR_REGISTRY 注册表
  + 第一阶段 Command + Wire，未来可加 HTTP/Prompt/Agent

  SoulPlus 架构
  - (单一 class)
  + 三层 DAG（D10，决策 #54 重构，取代旧"6 子组件 facade"）
    * 共享资源层：SessionLifecycleStateMachine / SoulLifecycleGate / JournalWriter / WiredContextState / SessionJournal
    * 服务层：Runtime / ConversationProjector / ApprovalRuntime / ToolCallOrchestrator / MemoryRuntime（占位）
    * 行为组件层：RequestRouter / TurnManager / SoulRegistry / SkillManager / NotificationManager / TeamDaemon
  + 组件只依赖下层窄接口，绝不反向依赖
  + ApprovalRuntime / ToolCallOrchestrator 明确为服务层节点而非第 7/8 个 sub-component
  + 避免 god object（cc AppState 450+ 字段教训）

  wire.jsonl 版本管理
  - (无版本号)
  + metadata header 第一行（protocol_version + created_at + kimi_version）
  + 未知 record type → skip + warn（不 crash）
  + semver 规则（minor=兼容，major=不兼容）
  
  Transport 层
  - (只列名字无接口)
  + 显式 Transport 接口（callback 风格：connect/send/close + onMessage/onClose）
  + TransportServer 接口（多 client）
  + WireCodec 分离序列化（Transport 只管 string 帧）
  + 所有场景走 Transport（含 stdio，消除 cc 的代码重复）
  + closed 是终态，重连=新实例

  Permission 系统
  - (仅 approval 双向 RPC)
  + SoulPlus 内部消化：PermissionRule 规则引擎 + 3 种 PermissionMode
  + 规则匹配退化为 SoulPlus 内部纯函数 checkRules（deny > ask > allow > default）
  + TurnManager 构造 beforeToolCall 闭包，把规则 baked 进闭包
  + 规则来源：builtin / plugin / user / project / turn-override
    (Phase 1 只开 builtin + user + turn-override 三层)
  + PermissionRule 格式：ToolName(args_pattern)
  + TurnOverrides 权限 override 转成 turn-scope rule baked 进闭包（不能绕过 deny）
  + 双层防护：LLM 可见性过滤 + beforeToolCall 闭包

  旧 v2 Permission 设计删除（相对 v2 初稿）
  - 7 层权限检查链（deny > ask > tool.selfCheck > mode bypass > dynamic > allow > default）
  - tool.checkPermissions / tool.selfCheck / tool.validateInput 方法
  - tool.canUseTool 参数
  - Runtime.permissionChecker 字段
  - SoulRegistry.createSoul 里给每个 Soul 注入独立 PermissionChecker 的代码
  + 全部作废；beforeToolCall 是唯一 approval gate（决策 #79 / #81）
  + per-turn 隔离由"每次 runSoulTurn 拿到独立闭包"天然保证

  Approval 系统
  - (嵌在 §11 内，仅 2 方法 waitForApproval / resolveApproval)
  + 独立出 §12 章节
  + ApprovalRuntime 完整接口：request / resolve / cancelBySource / recoverPendingOnStartup
  + 4 种 display 类型：command / diff / file_write / generic
  + 崩溃恢复：启动时扫描 pending approval，写回 synthetic cancelled response
  + 嵌入方可替换：在自己的 beforeToolCall 里实现任何审批逻辑

  Tool 系统
  - (未设计)
  + ToolRegistry 注册表 + 极简 Tool 接口
  + 命名空间 `__` 双下划线（内置短名 / mcp__s__t / plugin__n__t）
  + 冲突处理：优先级 + warning
  + 接口四件套：name / description / inputSchema / execute(id, args, signal, onUpdate?)
  + 外部依赖（shell executor / 文件系统 / HTTP client）通过 constructor 注入，不走 ctx 参数
  + 流式进度走 onUpdate → EventSink（tool.progress），不写 wire.jsonl

  Soul 形态
  - (class + 实例状态 + this.runTurn)
  + 纯 async function runSoulTurn(...)（决策 #78）
  + 无 class / 无 this / 无实例状态
  + import whitelist 由 tsconfig paths + ESLint no-restricted-imports 双重强制
  + 铁律 2：Soul 零 permission 词汇（ESLint 检查 identifier / 字符串字面量 / 注释）

  Soul ↔ SoulPlus 通信
  - (单一 Runtime 门面)
  + 双通道：ContextState（async 写状态）+ EventSink（sync void，fire-and-forget）
  + 一根通道无法同时满足"写状态要同步反馈"和"UI 事件要 fire-and-forget"两个刚需（见 ADR-X）
  + EventSink.emit 返回类型 = void，类型上堵死误用 await

  ContextState
  - (身份不明确)
  + 持有 JournalWriter 引用（替代原 WireStore 引用），写入同时更新内存+写盘
  + 一分为二：SoulContextState（Soul 看到的窄视图）+ FullContextState extends SoulContextState
    (SoulPlus 独有 appendUserMessage；管理类 record 改走 SessionJournal)
  + 生产 WiredContextState / 测试 InMemoryContextState
  + 写方法全部 async 返回 Promise<void>（决策 #76）
  + runSoulTurn 签名自动收窄 FullContextState → SoulContextState（决策 #82）

  Runtime 接口
  - (含 permissionChecker / 各种闲杂能力)
  + 窄接口（决策 #93 后 Phase 1 终稿）：{kosong}
  + compactionProvider / lifecycle / journal 已下沉到 TurnManagerDeps（不属于 Soul 视图，铁律 7）
  + 不含任何 permission / approval / tools 字段（tools 按 turn 从 SoulConfig 传入）
  + SoulLifecycleGate.transitionTo 等 in-flight 写入排空后原子切换（决策 #86）
  + JournalCapability.rotate 做原子文件轮转（决策 #32 / #67）
  + CompactionProvider.run 接受 options 返回 CompactionOutput（自动 + 用户主动两种场景，决策 #87 / #93）
  + KosongAdapter 内部消化 401 / connection retry（决策 #94）

  TurnOverrides
  - (单一对象)
  + 一分为二：FullTurnOverrides（TurnManager/SkillManager 内部）vs SoulTurnOverrides（Soul 看到）
  + SoulTurnOverrides 仅含 model/effort/activeTools；activeTools 在 Soul 侧只做 LLM visibility filter
  + 权限相关 override 由 TurnManager baked 进 beforeToolCall 闭包（决策 #83）

  Compaction 控制权
  - (SoulPlus 从外面侵入 Soul 循环)
  + 触发检测在 Soul 的 runSoulTurn while 顶部 safe point（决策 #85 保留部分）
  + 执行流程在 TurnManager.executeCompaction（决策 #93 / 铁律 7 移出）
  + Soul 通过 TurnResult.reason: "needs_compaction" 上报；TurnManager while 循环
    收到信号后调 executeCompaction 然后重启 Soul 接续同一 turn_id
  + Runtime 收窄为只含 kosong（compactionProvider / lifecycle / journal 下沉到 TurnManagerDeps）
  
  Agent 类型
  - (无明确区分)
  + agent_type: main / sub / independent
  
  Notification
  - (不持久化)
  + 落盘 NotificationRecord + targets 分发 (llm/wire/shell)
  + "llm" target 走 ContextState.appendNotification durable 写入，作为对话事件进 transcript
    （Phase 6E 定稿；v2 初稿曾通过 ephemeralInjections 做一次性注入，已撤销，见决策 #89）
  
  Crash recovery
  - repairDanglingToolCalls (v1 主动修复路径，已放弃)
  + + 明确策略：write-ahead + 被动 journal repair + 不重发 approval
    (不做 promise 持久化；重启一律回 idle，不自动续跑旧 turn)
  + subagent resume：标记 lost + filterUnresolvedToolUses
  + agent team resume：SQLite pending 消息处理 + team_members 状态检查
  
  延后能力
  - (未列明)
  + 消息级 Edit / 命令 rewind / Flow workflow / Sandbox / hot reload
    (v2 预留 schema 但第一阶段不实现)
  + agent_color（延后到 UI 开发阶段）
```

---

## 附录 D：核心数据类型定义

本附录集中定义 v2 全文引用但散落在各章节的核心纯数据类型。这些类型构成 Soul / SoulPlus / Runtime / Tool / Wire 等模块之间的数据契约,所有 TypeScript 签名都应当能对齐本附录定义。

本附录只定义**纯数据类型**(含 discriminated union / 辅助类型 / 常量 union),不包含任何带行为的接口或 class——后者分别住在 §4.5(ContextState)、§5.1.3(Soul 签名)、§6.1(SoulPlus)、§10(Tool)、§11(Permission)、§12(Approval)、§13(Hook)等章节。

### D.1 Message 族

Message 族是 Soul 与 LLM 之间的中立抽象(不绑定某个 LLM provider),也是 `buildMessages()` 的输出元素。引用章节:§4.5.2 / §5.1.7 / §18.2.1。

```typescript
// 基类:所有消息都带 role 字段
interface Message {
  role: "system" | "user" | "assistant" | "tool";
}

// User message:用户输入,可带附件(图片/文件)
interface UserMessage extends Message {
  role: "user";
  content: string | UserContent[];
}

type UserContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; data: string; media_type: string } };

// Assistant message:LLM 返回,可能带多个 content block + tool_calls
interface AssistantMessage extends Message {
  role: "assistant";
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];        // 本轮要发起的工具调用
  stop_reason?: StopReason;       // LLM 停止原因
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string };

// System message:system prompt(只有一条,且必定在 messages 首位)
interface SystemMessage extends Message {
  role: "system";
  content: string;
}

// Tool message:工具执行结果,通过 tool_call_id 关联到某次 AssistantMessage.tool_calls
interface ToolMessage extends Message {
  role: "tool";
  tool_call_id: string;
  content: string | ToolResultContent[];
  is_error?: boolean;             // 工具 is_error,LLM 看得到
}
```

### D.2 Tool 相关

Tool 调用与结果的数据类型,Soul 驱动工具执行时使用。引用章节:§10 / §5.1.7 / §11.7 / 附录 E。

> **Tool interface 字段一览**（完整定义见 §10.2，本节列附录补充字段，避免与 §10.2 重复）：
> - `name` / `description` / `inputSchema` / `execute`：核心 4 字段
> - `maxResultSizeChars?: number`：单条 result 字符上限（决策 #96 / Tool Result Budget；详见 §10.6）
> - `isConcurrencySafe?: (input: Input) => boolean`：是否允许与其他 concurrency-safe tool 并发执行（默认 false 即串行）。Phase 1 必做接口预留；Phase 2 ToolCallOrchestrator 启用受控并发时查询此字段。参考 cc-remake `isConcurrencySafe`，对齐 "v2 偏离 Python 全并发，走受控并发" 的设计（§11.7.1 FAQ）。
> - `display?: ToolDisplayHooks<Input, Output>`：6 个 UI 渲染 hint hook（决策 #98，详见 §10.7）

```typescript
// 一次工具调用的请求(由 LLM 产生)
interface ToolCall {
  id: string;                     // LLM 分配的调用 id
  name: string;                   // tool 名字,匹配 ToolRegistry
  args: unknown;                  // 调用参数,需要用 Tool.inputSchema 校验
                                  // (全文统一用 args;附录 B 的 tool_call_dispatched.data.args
                                  //  和 assistant_message.tool_calls[].args 对齐此命名)
}

// 工具执行结果
// 泛型 Output 默认 unknown，具体 tool 可指定精确类型（如 Tool<BashInput, BashOutput>）
interface ToolResult<Output = unknown> {
  isError?: boolean;              // 语义错误标记(tool 自己判定)
  content: string | ToolResultContent[];   // 给 LLM 看的内容
  output?: Output;                // 结构化输出(给 hook / UI 读)
}

// Tool content block(允许返回文本 + 图片)
type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; data: string; media_type: string } };

// Tool 执行过程中的增量更新(stream stdout / progress),走 EventSink,不落 wire
// 决策 #98 / D10：扩展 "custom" escape hatch，让 tool 上报非标 update 类型（如 image_generated）
interface ToolUpdate {
  kind: "stdout" | "stderr" | "progress" | "status" | "custom";
  text?: string;                  // stdout / stderr / status 文本
  percent?: number;               // progress 进度(0..100)
  custom_kind?: string;           // kind === "custom" 时的子类型标识（如 "image_generated"）
  custom_data?: unknown;          // kind === "custom" 时的自定义数据载荷
}

// ===== 决策 #98 / Tool UI 渲染契约 =====
// 完整规格见 §10.7。这里给出附录 D 层级的纯类型定义，附录 B 的 Zod schema 与之对齐。

// Tool 接口的 6 个 display hook（全部 optional）
interface ToolDisplayHooks<Input, Output> {
  getUserFacingName?(input: Partial<Input> | undefined): string;
  getActivityDescription?(input: Partial<Input> | undefined): string;
  getInputDisplay?(input: Input): ToolInputDisplay;
  getResultDisplay?(input: Input, result: ToolResult<Output>): ToolResultDisplay;
  getProgressDescription?(input: Input, update: ToolUpdate): string | undefined;
  getCollapsedSummary?(input: Input, result: ToolResult<Output>): string;
}

// 入参的结构化渲染 hint（→ tool.call.input_display）
// 同时充当 ApprovalRequest.display（§12.2 ApprovalDisplay = ToolInputDisplay alias）
type ToolInputDisplay =
  | { kind: "command";       command: string; cwd?: string; description?: string }
  | { kind: "file_io";       operation: "read" | "write" | "edit"; path: string;
                             range?: { start: number; end: number } }
  | { kind: "diff";          path: string; before: string; after: string }
  | { kind: "search";        query: string; scope?: string; flags?: string[] }
  | { kind: "url_fetch";     url: string; method?: string }
  | { kind: "agent_call";    agent_name: string; prompt: string; tags?: string[] }
  | { kind: "skill_call";    skill_name: string; arguments?: string }
  | { kind: "todo_list";     items: Array<{ title: string;
                                            status: "pending" | "in_progress" | "done" }> }
  | { kind: "background_task"; task_id: string; kind: string; status: string; description: string }
  | { kind: "task_stop";     task_id: string; task_description: string }
  | { kind: "generic";       summary: string; detail?: unknown };

// 结果的结构化渲染 hint（→ tool.result.result_display）
type ToolResultDisplay =
  | { kind: "command_output";  stdout: string; stderr?: string; exit_code: number;
                               truncated?: boolean }
  | { kind: "file_content";    path: string; content: string;
                               range?: { start: number; end: number };
                               truncated?: boolean }
  | { kind: "diff";            path: string; before: string; after: string;
                               hunks?: Array<{ old_start: number; new_start: number;
                                               old_lines: number; new_lines: number }> }
  | { kind: "search_results";  query: string;
                               matches: Array<{ file: string; line: number; text: string;
                                                context_before?: string[];
                                                context_after?: string[] }>;
                               truncated?: boolean }
  | { kind: "url_content";     url: string; status: number; content_type?: string;
                               preview: string; truncated?: boolean }
  | { kind: "agent_summary";   agent_name: string; steps: number;
                               token_usage?: { input: number; output: number };
                               final_message?: string }
  | { kind: "background_task"; task_id: string; status: string; description: string }
  | { kind: "todo_list";       items: Array<{ title: string;
                                              status: "pending" | "in_progress" | "done" }> }
  | { kind: "structured";      data: unknown; schema_hint?: string }
  | { kind: "text";            text: string; truncated?: boolean }
  | { kind: "error";           message: string; recoverable?: boolean }
  | { kind: "generic";         summary: string; detail?: unknown };
```

### D.3 User 输入

用户通过 `session.prompt` 提交的原始输入。引用章节:§5.1.3 / §6.1 / 决策 #10。

```typescript
// prompt 请求的载荷
interface UserInput {
  text: string;                   // 主文本(对 skill 识别前缀的入口)
  attachments?: Attachment[];     // 可选附件
}

// 附件(图片 / 文件 / URL),Phase 1 只识别 image
interface Attachment {
  kind: "image" | "file" | "url";
  path?: string;                  // file / image 的磁盘路径
  data?: string;                  // 内联 base64(image)或 URL 字符串
  metadata?: Record<string, unknown>;
}
```

### D.4 基础类型

Soul 循环收尾、token 记账、compaction 摘要的基础类型。引用章节:§5.1.7 / §4.5 / §6.4 / §6.12.2 / 附录 B。

```typescript
// LLM 的停止原因(和 Kosong 层对齐),用于 Soul 判断是否继续 step 循环
// 决策 #93 新增 "compaction_requested"——TurnResult.reason === "needs_compaction" 时填这个值
type StopReason =
  | "end_turn"               // 正常结束,无 tool_calls
  | "max_tokens"             // 达到 output token 上限
  | "stop_sequence"          // 命中停止序列
  | "tool_use"               // 有 tool_calls,需要继续 step
  | "aborted"                // AbortSignal 触发
  | "error"                  // kosong / provider 抛错
  | "compaction_requested"   // Soul 在 safe point 检测到需要 compaction（决策 #93）
  | "unknown";

// Turn 退出原因——驱动 TurnManager 的下一步动作（决策 #93 新增）
// 把"下一步动作的决定权"显式上移到 TurnManager。Soul 只回答"我为什么停了"。
type TurnExitReason =
  | "end_turn"          // 正常结束，没有 tool_calls，turn 走完
  | "needs_compaction"  // Soul 在 safe point 检测到需要压缩，请求 TurnManager 执行
  | "aborted"           // 收到 AbortSignal，需要写 turn_end(reason: "cancelled")
  | "error";            // 内部异常，需要写 turn_end(reason: "error")

// Soul 单次调用的返回值——TurnManager 根据 reason 决定下一步动作
interface TurnResult {
  reason: TurnExitReason;
  stopReason: StopReason;       // LLM 层面的 stop_reason；保留作为审计字段
  steps: number;                // 单次 runSoulTurn 内的 step 计数（cumulative 由 TurnManager 累加）
  usage: TokenUsage;            // 单次 runSoulTurn 内的 token 消耗（同上）
}

// Token 消耗记账,字段名需和附录 B turn_end 里的 usage 对齐
// (注:wire.jsonl 的 input_tokens / output_tokens / cache_read_tokens 使用下划线;
//  这里提供紧凑版以便 Soul/Kosong 层内部传递)
interface TokenUsage {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

// Compaction 产出的结构化摘要,作为 compacted 区间的单条 user message 回灌 messages
// （历史定义；决策 #93 后实际由 CompactionOutput 包装，见 §6.12.2）
//
// 注意 LLM 输入侧的"role 包装"约定（决策 #96 / Python 1.x 实战）：
// SummaryMessage 在 ContextState → projector → Message[] 路径上以 `role: "user"` +
// `<system>...</system>` 文本包裹的形式出现，不使用自定义 `role: "summary"`——
// 自定义 role 在 Anthropic / OpenAI / Kimi API 层会被拒绝。包装由 ConversationProjector 统一处理。
//
// 落盘时（wire.jsonl）作为 `summary_reset` 类型的 ContextState durable 写入（属于 LLM 能看到的 record，
// 走 ContextState 而不是 SessionJournal）；text 字段是 LLM 生成的摘要正文，其余字段是元数据。
interface SummaryMessage {
  // 旧字段（保留兼容）
  content: string;                // LLM 总结出的摘要正文（== text，保留旧名做迁移过渡）
  original_turn_count?: number;   // 被压缩的原始 turn 数
  original_token_count?: number;  // 压缩前的 token 总数

  // ─── 决策 #96 新增：增量 summary 必需的元数据 ───
  text?: string;                  // 同 content，新代码用这个字段名
  reason?: "threshold" | "overflow" | "manual";  // 触发原因（telemetry / debug）
  modelUsedForSummary?: string;   // 生成 summary 用的 model id
  generatedAt?: string;           // ISO timestamp
  parentSummary?: string;         // 上次 summary 的引用文本（增量链；为 undefined 表示首次 compaction）
  fileOperations?: {              // 跨 compaction 累积的 file working set（pi-mono CompactionDetails）
    readFiles: string[];
    modifiedFiles: string[];
  };
}
```

### D.5 Config 与 Notification

Runtime 配置变更事件、通知载荷。引用章节:§4.5 / §6.1 / §13 / §3.6。

```typescript
// ContextState.applyConfigChange(...) 接收的配置变更事件,discriminated union
// 字段命名与附录 B 的 WireRecordSchema 严格一致(落盘时直接 projection 为对应 wire record)
type ConfigChangeEvent =
  | { type: "model_changed"; old_model: string; new_model: string }
  | { type: "system_prompt_changed"; new_prompt: string }
  | { type: "tools_changed"; operation: "register" | "remove" | "set_active"; tools: string[] }
  | { type: "thinking_changed"; level: string }
  | { type: "plan_mode_changed"; enabled: boolean };

// Notification 载荷(持久化 + 分发的统一信封)
// 对应附录 B 的 NotificationRecord.data,targets 控制分发目的地
interface NotificationData {
  id: string;                     // 通知唯一 id(附录 B 里的 data.id)
  category: "task" | "agent" | "system";
  type: string;                   // 具体子类型(例如 "task.completed" / "team.mail")
  source_kind: string;            // 来源组件 kind(例如 "soul" / "team_daemon" / "hook")
  source_id: string;              // 来源实例 id
  title: string;                  // 简短标题(shell hook / UI 用)
  body: string;                   // 详细内容(LLM system_reminder / UI 正文)
  severity: "info" | "success" | "warning" | "error";
  payload?: Record<string, unknown>;
  // 三路分发目标(canonical 值集,与附录 B NotificationRecord.data.targets 一致):
  //   - "llm"   : 通过 ContextState.appendNotification 做 durable 写入,
  //               作为 NotificationRecord 进 transcript;Projector 每次 project(snapshot)
  //               时把它组装为系统消息进 LLM 输入(Phase 6E 后与决策 #89 对齐)
  //   - "wire"  : 通过 EventBus 广播到 wire,前端 UI / SDK 订阅者可见
  //   - "shell" : 触发 shell hook(例如桌面通知 / 声音提醒)
  targets: ("llm" | "wire" | "shell")[];
  dedupe_key?: string;
  delivered_at?: number;
  envelope_id?: string;           // 决策 #103：仅当通知由 team mail envelope 转入时填写
                                  // (= MailEnvelope.envelope_id)；本地产生的通知不填。
                                  // 用于 §9.4.1 envelope-level 幂等去重。
}

// System reminder 载荷
// 对应附录 B 的 SystemReminderRecord.content,走 ContextState.appendSystemReminder
// 做 durable 写入,Projector 投影时组装为 <system-reminder> 包裹的系统消息(和 CC 对齐)
interface SystemReminderData {
  content: string;
  // 来源标记(可选,便于 UI / 调试区分 reminder 是谁触发的)
  source_kind?: string;
  source_id?: string;
}

// SessionMeta 变更事件（决策 #113 / SessionMetaService）。
// 对应附录 B 的 session_meta_changed record；由 SessionMetaService 在 wire-truth 字段
// 变更后通过 EventBus emit 到 wire（事件名为 "session_meta.changed"）。derived 字段
// （last_model / turn_count / last_updated）的变化**不**触发本事件——它们由
// model.changed / turn.end 等已有事件覆盖，避免重复推送的噪音。详见 §6.13.7。
//
// 注意：本事件与现有 ConfigChangeEvent（model_changed / system_prompt_changed 等）
// 是**并列**关系而非合并——后者影响 LLM 行为且 schema 异质，前者仅影响 UI / 内部
// 消费者读取且 schema 同质。决策 #113 / D10 明确不合并。
type SessionMetaChangedEvent = {
  patch: {
    title?: string;
    tags?: string[];
    description?: string;
    archived?: boolean;
    color?: string;
  };
  source: "user" | "auto" | "system";       // 与 wire record 的 source 字段对齐
};
```

### D.6 LLM Tool 定义

提交给 LLM 的 tool schema(Anthropic / OpenAI 形态的中立抽象)。引用章节:§10 / §5.1.7 / §18.2.1。

```typescript
// Soul 每 step 送给 Kosong 的 tool 定义(和 Anthropic API 对齐)
interface LLMToolDefinition {
  name: string;                   // tool 名字,需和 ToolRegistry 中的 key 一致
  description: string;            // 给 LLM 看的工具说明
  input_schema: unknown;          // JSONSchema / Zod schema 的 plain object 形态
}
```

### D.6.1 EventSource（EventBus 传输层事件身份标记）

EventBus 广播层给事件打上的"身份标记"，让共享同一条 UI 事件流的 client 能分辨事件属于哪个 agent。引用章节:§4.8 / §6.5 / §8.2 / 决策 #88。

**边界重申**：`EventSource` 只存在于 **EventBus 传输层**（共享 UI 事件广播），不进入 **持久化层**（`WireRecord` 不含 source 字段，子 agent 的身份通过 `subagents/<agent_id>/` 目录路径表达）。这是"独立存储 + source 标记转发"设计的核心约束。

```typescript
interface EventSource {
  id: string;                                      // 唯一实例标识（主 agent 缺省省略；subagent 用 agent_id；teammate 用 member session_id）
  kind: "subagent" | "teammate" | "remote";        // 可扩展枚举：subagent=同进程子 agent，teammate=独立进程 team member，remote=跨进程 bridge 转发
  name?: string;                                   // 人类可读名（UI badge 展示用）
}

// EventBus 传输层的事件信封：SoulEvent + 可选 source
// 主 agent emit 的事件不带 source；SoulRegistry / TeamDaemon 转发子 agent / teammate 事件时注入 source。
type BusEvent = SoulEvent & { source?: EventSource };
```

**UI 渲染策略**（参考实现约定）：

- `source` 缺省 → 主 agent → 正常渲染
- `source.kind === "subagent"` → 带 badge / 折叠组 / 缩进展示，按 `source.id` 分组
- `source.kind === "teammate"` → teammate 头像 + 名字
- `source.kind === "remote"` → 外部 bridge 转发（例如 Claude Code / Codex teammate），按 `source.name` 渲染

### D.7 其他小类型

从 §4.5.4 / §6.13.4 / §8.3.2 / §15.6 / §13 等章节引用,但原位未给出正式定义的若干小类型。统一在此补齐。

```typescript
// §4.5.4 ContextState 在非 active 状态下拒绝写入时抛出
interface JournalGatedError extends Error {
  state: "compacting" | "completing";
  recordType: string;             // 被拒绝写入的 record type,便于定位
}

// §15.6 SkillManager.detectAndPrepare 返回结构
interface SkillPrepareResult {
  expandedPrompt: string;         // 模板展开后的 prompt 字符串
  overrides: FullTurnOverrides;   // 全版本 turn overrides(§11.6)
  skillName: string;              // 触发的 skill 名字
  executionMode: "inline" | "fork";  // inline=当前 turn,fork=新 subagent
}

// §15.6 SkillManager.list 返回的元数据
interface SkillInfo {
  name: string;                   // skill 名字(slash command 前缀)
  description: string;            // 用户可见的简短说明
  whenToUse?: string;             // 触发提示
  allowedTools?: string[];        // 允许的工具集合
}

// §6.13.4 SessionManager.listSessions 返回的 session 概要
interface SessionInfo {
  sessionId: string;
  createdAt: number;
  lastActive: number;
  title?: string;                 // 用户给的会话标题
  messageCount: number;
  turnCount: number;
}

// §8.3.2 JournalWriter.append 接收的请求信封
interface WriteRequest {
  type: string;                   // record type(对齐附录 B)
  data: unknown;                  // 具体 record payload
  turn_id?: string;               // 全局统一为字符串("turn_${counter}"),对齐 §6.4 / 附录 B
  step?: number;
  agent_id?: string;              // subagent / teammate 场景
}

// §13 Hook 系统的配置条目(discriminated union 按 type 分发到 executor)
// 注:本结构只承载 hook 的"元数据 + 动作描述",不持有 HookExecutor 实例
// (避免 HookConfig ↔ HookExecutor 的循环引用;HookEngine 在调度时按 hook.type
//  查 HOOK_EXECUTOR_REGISTRY 再拿到对应的 executor)。参考 §13.5 / §13.6 / §13.7。
//
// Phase 1 只支持 command / wire 两种;http / prompt / agent 为未来扩展。
type HookConfig =
  | (HookConfigBase & { type: "command"; command: string; timeoutMs?: number; env?: Record<string, string> })
  | (HookConfigBase & { type: "wire"; method: string; timeoutMs?: number });

// 所有 HookConfig 变体共享的 base 字段
interface HookConfigBase {
  event: HookEventType;
  matcher?: HookMatcher;          // 细粒度匹配器(例如 PreToolUse 匹配 tool name)
  description?: string;           // 用户自填说明,便于 CLI / UI 展示
  disabled?: boolean;
}

// Hook 事件枚举,对应 §13.2 / §13.7 的调度点,统一 PascalCase
type HookEventType =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "OnToolFailure"                // tool 执行抛异常时触发(区别于 PostToolUse 的正常返回)
  | "Stop"
  | "SubagentStop"
  | "Notification"
  | "PreCompact"
  | "PostCompact";

// Hook 被触发时传给 executor 的入参(discriminated union 按 event 分发)
// 所有变体共享 base 字段 {event, context};不同 event 携带自己的 payload 字段
interface HookInputBase {
  event: HookEventType;
  context: {
    sessionId: string;
    turnId?: string;              // 全局统一为字符串("turn_${counter}"),对齐 §6.4 / 附录 B
    stepNumber?: number;
    agentId?: string;
  };
}

type HookInput =
  | (HookInputBase & { event: "SessionStart" | "SessionEnd" })
  | (HookInputBase & { event: "UserPromptSubmit"; userInput: UserInput })
  | (HookInputBase & { event: "PreToolUse"; toolCall: ToolCall; args: unknown })
  | (HookInputBase & { event: "PostToolUse"; toolCall: ToolCall; args: unknown; result: ToolResult })
  | (HookInputBase & { event: "OnToolFailure"; toolCall: ToolCall; args: unknown; error: string })
  | (HookInputBase & { event: "Stop" | "SubagentStop" })
  | (HookInputBase & { event: "Notification"; notification: NotificationData })
  | (HookInputBase & { event: "PreCompact" | "PostCompact" });

// 单个 executor 的返回结果
// (§13.5 已展示同一形态;本附录给出规范定义,实现时以此为准)
interface HookResult {
  ok: boolean;
  reason?: string;
  blockAction?: boolean;          // true = 阻断当前 event 对应的动作(例如 PreToolUse 阻断 tool 执行)
  additionalContext?: string;     // 需要注入给 LLM 的补充上下文(由 HookEngine 转成 system_reminder 走 ContextState.appendSystemReminder durable 写入)
  updatedInput?: Record<string, unknown>;  // 对 input 的修改(例如 UserPromptSubmit 改写 prompt)
}

// HookEngine 聚合多个 executor 的结果,返回单一决定
// 语义与 §13.7 一致:blockAction 有一个 true 就阻断;additionalContext 累积;updatedInput 后者覆盖前者
interface AggregatedHookResult {
  blockAction: boolean;           // 至少一个 executor 返回 blockAction=true
  additionalContext?: string;     // 所有 executor 的 additionalContext 拼接
  updatedInput?: Record<string, unknown>;  // 最后一个非空 updatedInput 胜出
  errors?: string[];              // 非致命的 executor 错误(记录但不阻断)
}

// HookMatcher(仅声明,具体语义见 §13)
type HookMatcher = { toolName?: string | RegExp };
```

**HookExecutor 接口定义不在本附录**:它是带行为的 class 契约,住在 §13.5。HookExecutor 的 `execute(hook: HookConfig, input: HookInput, signal: AbortSignal): Promise<HookResult>` 接收本附录定义的 `HookConfig` / `HookInput`,返回本附录定义的 `HookResult`,构成三方闭环。

### D.8 Team 通信层（TeamCommsProvider 可插拔接口）

Agent Team 通信层的纯数据类型 + 接口签名。引用章节：§8.3.2 / §8.3.3 / §6.8 / §9.4.1 / 决策 #90。

**设计边界**：下列类型分两类——(1) 纯数据类型（`MailEnvelope` / `MailEntry` / `TeamInfo` / `MemberInfo` / `StaleMember`）属于本附录定义范围；(2) 带行为的接口（`TeamMailbox` / `TeamRegistry` / `TeamHeartbeat` / `TeamCommsProvider`）本应放在 §8.3.2，附录这里**以只读方式重列一份**方便交叉引用——实际 canonical 定义以 §8.3.2 为准。

```typescript
// ===== 纯数据类型 =====

// 邮箱信封：transport 层在 mailbox 之间传递的最小单元
interface MailEnvelope {
  envelope_id: string;   // 必需，transport 层去重键（全局唯一）
  type: string;          // snake_case，和 WireRecord.type 值域一致
                         //   "team_mail" / "approval_request" / "approval_response" / "shutdown_request"
  from: string;          // 发送方 session_id
  to: string;            // 接收方 session_id
  timestamp: number;     // 发送时间（ms 自 epoch）
  data: unknown;         // 业务载荷（形状和 WireRecord.data 对齐）
}

// 从 mailbox.poll 读出的条目：envelope + provider 内部元数据
// v2 初稿里叫 TeamMailRow，Phase 6F（决策 #90）重命名为 MailEntry
interface MailEntry {
  row_id: string;        // provider 的内部主键
                         //   - SQLite: team_mails.id（转字符串）
                         //   - Memory / File: queue index / uuid
  envelope: MailEnvelope;
  status: "pending" | "delivered";
  created_at: number;
}

// Team 元信息（TeamRegistry.registerTeam 入参 / TeamRegistry.listMembers 间接返回）
interface TeamInfo {
  team_id: string;
  team_name: string;
  leader_session_id: string;
  created_at: number;
}

// Member 元信息
interface MemberInfo {
  team_id: string;
  session_id: string;
  agent_name: string;
  description?: string;
  is_active: boolean;
  joined_at: number;
  pid?: number;
}

// Heartbeat 扫描结果
interface StaleMember {
  session_id: string;
  last_heartbeat: number;
  stale_since_ms: number;
}

// ===== 接口签名（canonical 定义见 §8.3.2） =====

// 消息通道
interface TeamMailbox {
  publish(envelope: MailEnvelope): Promise<void>;
  poll(teamId: string, selfSessionId: string): Promise<MailEntry[]>;
  ack(rowId: string): Promise<void>;
  cleanup(teamId: string, olderThanMs: number): Promise<number>;
  // 可选：事件驱动订阅（Phase 2+ 由具体 provider 实现）
  subscribe?(
    teamId: string,
    selfSessionId: string,
    onEnvelope: (entry: MailEntry) => void,
  ): () => void;
}

// 成员注册表
interface TeamRegistry {
  registerTeam(info: TeamInfo): Promise<void>;
  registerMember(info: MemberInfo): Promise<void>;
  listMembers(teamId: string): Promise<MemberInfo[]>;
  markMemberDead(teamId: string, sessionId: string): Promise<void>;
  deregisterTeam(teamId: string): Promise<void>;
}

// 心跳通道
interface TeamHeartbeat {
  updateHeartbeat(sessionId: string): Promise<void>;
  listStaleMembers(teamId: string, thresholdMs: number): Promise<StaleMember[]>;
}

// 组合：三个窄接口的聚合
interface TeamCommsProvider {
  readonly mailbox: TeamMailbox;
  readonly registry: TeamRegistry;
  readonly heartbeat: TeamHeartbeat;
  init(): Promise<void>;
  close(): Promise<void>;
}

// 工厂函数类型：不同 provider 有不同的 config 类型
type TeamCommsFactory<Config> = (config: Config) => TeamCommsProvider;
```

**Phase 1 两个必实现的 provider**：
- `createSqliteTeamComms({ dbPath })` —— 默认生产实现
- `createMemoryTeamComms()` —— 测试实现

**Phase 2+ 扩展**：`createFileTeamComms` / `createRedisTeamComms` 作为同一接口的另一组实现，接口不变。

### D.9 MCP 集成层（决策 #100 / Phase 1 接口预留）

完整设计见 §17A，附录 D 这里给出全部纯类型定义；Phase 1 必须落到 `packages/core/mcp/types.ts`。

```typescript
// ─── 配置层 ───
type McpConfigScope = "enterprise" | "user" | "project" | "dynamic" | "plugin";

type McpTransportConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http";  url: string; headers?: Record<string, string>; oauth?: McpOAuthConfig }
  | { type: "sse";   url: string; headers?: Record<string, string>; oauth?: McpOAuthConfig };

interface McpOAuthConfig {
  clientId?: string;
  callbackPort?: number;
  authServerMetadataUrl?: string;
}

interface McpServerConfig {
  serverId: string;
  name: string;
  transport: McpTransportConfig;
  scope: McpConfigScope;
  pluginSource?: string;
  capabilities?: {
    elicitation?: boolean;
    sampling?: boolean;
    roots?: boolean;
  };
  toolCallTimeoutMs?: number;
  toolMaxOutputChars?: number;     // 决策 #100 / D-MCP-11：覆盖默认 100K
  enabled?: boolean;
}

interface McpPolicy {
  denied?: McpServerEntry[];
  allowed?: McpServerEntry[];
}
type McpServerEntry =
  | { kind: "name"; pattern: string }
  | { kind: "url"; pattern: string }
  | { kind: "command"; pattern: string };

// ─── Client / Tool / Result 类型 ───
type McpClientState =
  | "disconnected" | "connecting" | "connected"
  | "needs-auth" | "failed" | "disabled";

interface McpServerCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  elicitation?: boolean;
  sampling?: boolean;
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;            // JSONSchema
  meta?: Record<string, unknown>;
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; description?: string };

interface McpToolResult {
  isError: boolean;
  content: McpContent[];
  structuredContent?: unknown;
}

interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;                   // text resource
  blob?: string;                   // base64 binary
}

interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface McpPromptContent {
  description?: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: McpContent[] }>;
}

interface McpNotification {
  method: string;
  params?: unknown;
}

interface McpElicitationRequest {
  requestId: string;
  params: {
    message: string;
    mode: "form" | "url";
    schema?: unknown;              // form 模式 JSONSchema
    url?: string;                  // url 模式
  };
}

interface McpElicitationResponse {
  action: "accept" | "reject" | "cancel";
  values?: Record<string, unknown>;  // form 模式用户填的值
}

// ─── Registry snapshot（status.update.mcp_status 数据源）───
interface McpRegistrySnapshot {
  loading: boolean;
  total: number;
  connected: number;
  toolCount: number;
  servers: Array<{
    serverId: string;
    name: string;
    state: McpClientState;
    toolNames: string[];
    error?: string;
  }>;
}
```

**Phase 1 必做接口签名**（McpClient / McpTransport / McpRegistry 完整 interface）见 §17A.2，这里仅给纯数据类型；行为接口住在 §17A，与 §10（Tool）/§12（Approval）/§16（Plugin）等"行为接口"章节惯例一致。

### D.10 Cost Tracking（决策 #111）

Cost tracking 的纯数据类型。行为接口（CostCalculator）见 §6.12.5。

```typescript
/** 单次 LLM 调用的费用明细。 */
interface CostBreakdown {
  input_cost_usd: number;
  output_cost_usd: number;
  cache_read_cost_usd: number;    // prompt cache 命中部分的费用
  cache_write_cost_usd: number;   // prompt cache 写入部分的费用
  total_cost_usd: number;         // 总费用 = input + output + cache_read + cache_write
}

/** Pricing 表的单条记录。DefaultCostCalculator 内置主流模型的 pricing 表。 */
interface ModelPricing {
  model_pattern: string;          // 正则模式，如 "claude-opus-4*" / "gpt-4o*" / "moonshot-v1*"
  input_per_1k: number;           // 每 1000 input tokens 的美元费用
  output_per_1k: number;          // 每 1000 output tokens 的美元费用
  cache_read_per_1k?: number;     // 每 1000 cache read tokens 的美元费用（可选）
  cache_write_per_1k?: number;    // 每 1000 cache write tokens 的美元费用（可选）
}

/** CostCalculator 接口。注意：行为接口，但因为非常简单，附录 D 一并收录。 */
interface CostCalculator {
  /**
   * 计算一次 LLM 调用的费用。
   * 未匹配模型返回 null（不猜，明确标 unknown）。
   */
  calculate(model: string, usage: TokenUsage): CostBreakdown | null;
}
```

---

## 附录 E:Phase 1 内置 Tool 的 Input/Output Schema

本附录为 §20.1 列出的 Phase 1 必做 tool(`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` / `Task`)给出 Zod 形态的 Input schema 和 Output schema。参考来源:cc-remake 的 `src/tools/*/`(FileReadTool, FileWriteTool, FileEditTool, BashTool, GrepTool, GlobTool, AgentTool)。

**命名约定**:kimi-core v2 内部类型用 `path`(没有 `file_path`)、`pattern` 等简洁命名;写入 LLM 的字段名对齐到 kosong 层的 ToolDefinition。cc-remake 的原生 schema 用的是 `file_path`——迁移时在 Tool.inputSchema 和 Anthropic ToolDefinition 之间做一次字段映射即可。

**Output schema 语义**:每个 tool 的 `content`(给 LLM 看)和 `output`(结构化)按附录 D.2 的 `ToolResult` 结构分离;本附录的 Output schema 描述的是 `output` 字段的 shape。

### E.1 Read

从文件系统读取文本文件(含 offset/limit 支持,避免一次读入超大文件)。

```typescript
import { z } from "zod";

export const ReadInputSchema = z.object({
  path: z.string().describe("要读取的绝对路径"),
  offset: z.number().int().nonnegative().optional()
    .describe("起始行号(0-based),用于分页读取大文件"),
  limit: z.number().int().positive().optional()
    .describe("最多读取多少行,配合 offset 使用"),
});

export const ReadOutputSchema = z.object({
  content: z.string().describe("读取到的文件内容"),
  lineCount: z.number().int().nonnegative()
    .describe("实际读取的行数"),
});
```

### E.2 Write

写文件(覆盖式),不存在则创建,父目录必须已存在。

```typescript
export const WriteInputSchema = z.object({
  path: z.string().describe("要写入的绝对路径"),
  content: z.string().describe("文件内容"),
});

export const WriteOutputSchema = z.object({
  bytesWritten: z.number().int().nonnegative()
    .describe("实际写入的字节数"),
});
```

### E.3 Edit

对已有文件做精确字符串替换(默认只替换首次出现,`replace_all: true` 时全量替换)。

```typescript
export const EditInputSchema = z.object({
  path: z.string().describe("要修改的绝对路径"),
  old_string: z.string().describe("要被替换的原始字符串"),
  new_string: z.string().describe("替换后的新字符串"),
  replace_all: z.boolean().optional().default(false)
    .describe("是否替换所有出现,默认只替换首次"),
});

export const EditOutputSchema = z.object({
  replacementCount: z.number().int().nonnegative()
    .describe("实际发生替换的次数"),
});
```

### E.4 Bash

执行 shell 命令(单次、非交互),支持自定义 cwd 与超时。

```typescript
export const BashInputSchema = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  cwd: z.string().optional()
    .describe("工作目录绝对路径,默认使用 session 的 cwd"),
  timeout: z.number().int().positive().optional()
    .describe("超时毫秒数,默认 120000ms"),
  description: z.string().optional()
    .describe("命令的简短中文说明(5-10 字),主要给 UI 展示"),
});

export const BashOutputSchema = z.object({
  exitCode: z.number().int().describe("进程退出码"),
  stdout: z.string().describe("标准输出"),
  stderr: z.string().describe("标准错误"),
});
```

### E.5 Grep

基于 ripgrep 的内容搜索,支持 glob 过滤、文件类型、上下文、多行等。schema 完整对齐 cc-remake 的 GrepTool.inputSchema。

```typescript
export const GrepInputSchema = z.object({
  pattern: z.string()
    .describe("正则表达式模式"),
  path: z.string().optional()
    .describe("搜索目录或文件,默认当前工作目录"),
  glob: z.string().optional()
    .describe("glob 文件名过滤,例如 \"*.ts\" 或 \"**/*.{js,tsx}\""),
  type: z.string().optional()
    .describe("文件类型过滤,例如 js / py / rust / go(对应 rg --type)"),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional()
    .describe("输出模式:content=命中行,files_with_matches=命中文件,count=计数"),
  "-i": z.boolean().optional()
    .describe("大小写不敏感"),
  "-n": z.boolean().optional()
    .describe("显示行号(仅 content 模式)"),
  "-A": z.number().int().nonnegative().optional()
    .describe("命中后展开 N 行(仅 content 模式)"),
  "-B": z.number().int().nonnegative().optional()
    .describe("命中前展开 N 行(仅 content 模式)"),
  "-C": z.number().int().nonnegative().optional()
    .describe("命中前后各展开 N 行,等价于 context"),
  head_limit: z.number().int().nonnegative().optional()
    .describe("限制输出条目数,默认 250,传 0 表示无限制"),
  multiline: z.boolean().optional()
    .describe("启用多行模式,允许 . 匹配换行"),
});

export const GrepOutputSchema = z.object({
  mode: z.enum(["content", "files_with_matches", "count"]),
  numFiles: z.number().int().nonnegative(),
  filenames: z.array(z.string()),
  content: z.string().optional()
    .describe("content 模式下的命中内容"),
  numLines: z.number().int().nonnegative().optional()
    .describe("content 模式下的总命中行数"),
  numMatches: z.number().int().nonnegative().optional()
    .describe("count 模式下的总命中次数"),
  appliedLimit: z.number().int().nonnegative().optional()
    .describe("实际截断时的 limit,用于提示还有更多结果可分页"),
});
```

### E.6 Glob

按 glob 模式查找文件路径(不读内容)。

```typescript
export const GlobInputSchema = z.object({
  pattern: z.string().describe("glob 模式,例如 \"**/*.ts\""),
  path: z.string().optional()
    .describe("搜索起始目录,默认当前工作目录"),
});

export const GlobOutputSchema = z.object({
  paths: z.array(z.string())
    .describe("按修改时间降序排列的匹配文件路径列表"),
});
```

### E.7 Task

创建同进程 task subagent 并运行。和 cc-remake 的 AgentTool 对齐。subagent 完成后,Task tool 会把聚合后的文本回传。

```typescript
export const TaskInputSchema = z.object({
  description: z.string()
    .describe("简短任务描述(3-5 个词),用于 UI 展示"),
  subagent_type: z.string()
    .describe("subagent 类型,对应注册表中的 agent 定义"),
  prompt: z.string()
    .describe("发给 subagent 的完整任务 prompt"),
});

export const TaskOutputSchema = z.object({
  result: z.string().describe("subagent 聚合后的最终文本输出"),
  usage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative().optional(),
    cache_write: z.number().int().nonnegative().optional(),
  }).describe("subagent 累计 token 用量(对齐 TokenUsage)"),
});
```

---

## 附录 ADR-X：关键决策 ADR 集合

本附录收录 v2 演进过程中需要完整 ADR 论证的关键决策。原双通道通信的架构选型（ADR-X.1~X.7）是本附录的核心 ADR；ADR-X.78 及之后是决策表 §二十一 里 #78-#100 的完整论证（决策表里的"理由"列只保留一句话概括 + 链接回这里）。其中 ADR-X.95~X.100 由 batch1/2/3 后新增（Phase 1 必做项细化）。

### ADR-X.1 背景

kimi-cli v2 需要决定 Soul 和 SoulPlus 之间的通信模式。这是一个**影响深远**的底层选型——它决定了 Soul 的接口形态、崩溃恢复语义、事件流构造方式、listener 的扩展方式。一旦选定，后续所有组件都会围绕这个决策建立约束。

参考前人做法，候选方案有两种：

- **单通道 yield**：cc-remake 的 async generator 模式，Soul 作为生成器产出所有 message 和事件，SoulPlus 作为消费者统一处理
- **双通道 ContextState + EventSink**：v2 最终选择的方案，Soul 通过两个正交接口与外界通信——ContextState 负责状态变更、EventSink 负责 UI/遥测事件

记录这个 ADR 的目的是**防止**未来有人因为"单通道看起来更优雅、代码更少"而提议合并双通道。本 ADR 给出**不合并的硬理由**，并列出几个看起来能行但实际上行不通的"假解决方案"，帮助后续维护者快速排除错误方向。

### ADR-X.2 候选方案

#### 方案 A：单通道 yield（cc-remake 模式）

Soul 是 async generator：

```typescript
async function* runSoulTurn(
  input: UserInput,
  deps: SoulDeps,
  signal: AbortSignal,
): AsyncGenerator<SoulEvent, TurnResult, void> {
  yield { type: "step.begin", index: 0 };
  const response = await kosong.chat(messages, ...);
  yield { type: "assistant_message", msg: response.message };
  // ...
}
```

SoulPlus 是消费者：

```typescript
for await (const event of runSoulTurn(input, deps, signal)) {
  // 处理 persistence、UI 广播、遥测……
}
```

所有事件和状态变更都从一根管子产出，一个 listener（SoulPlus 的 for-await 循环）统一处理。

#### 方案 B：双通道 ContextState + EventSink（v2 选择）

Soul 接收两个正交的接口参数：

```typescript
async function runSoulTurn(
  input: UserInput,
  ctx: {
    context: SoulContextState; // 状态类 durable 写接口，同步 await 写状态
    sink: EventSink; // fire-and-forget UI/遥测广播
    runtime: Runtime;
    signal: AbortSignal;
  },
): Promise<TurnResult> {
  // ...
}
```

- 状态变更通过 `await context.appendX(...)`——**同步 await**，保证写完立即可读
- UI/遥测事件通过 `sink.emit(...)`——**fire-and-forget**，不 await，listener 异步处理
- 两根接口职责完全隔离：**ContextState / SessionJournal 负责 durable 写入**，**EventSink 是事件广播**

### ADR-X.3 为什么选双通道（核心理由）

#### 理由 1：同步读写的刚性需求

Soul 的 step 循环里有这样的模式：

```typescript
const messages1 = context.buildMessages();
const response = await kosong.chat(messages1, ...);
await context.appendAssistantMessage(response.message);
// ↑ 这里必须 await 完成，写入 wire.jsonl + 更新内存
const messages2 = context.buildMessages();
// ↑ 必须包含刚刚 append 的 assistant message
```

如果走单通道 yield：

```typescript
yield { type: "assistant_message", msg: response.message };
// ↑ generator 挂起，控制权交给消费者
// 消费者处理 message，然后继续 for-await 循环，让 generator 恢复
const messages2 = /* 从哪里来？ */;
```

问题是：**Soul 在 yield 之后恢复时，怎么知道 messages2 是什么？** 两个选项都坏：

- **选项 a**：Soul 自己也维护一份 message history，yield 只是"通知外部"——这就有**两份真相**（Soul 的本地 history 和外部的 `wire.jsonl`），"唯一持久化真相源"的承诺立刻破产
- **选项 b**：Soul 每次都调外部提供的 `getMessages()` 函数——这等价于提供了一个"读接口"，本质上**回到了双通道**（只是换了个马甲）

两个选项都不是真正的"单通道"——都需要 Soul 有某种方式"读回来"。所谓的"单通道"是表象，**双通道只是把这个事实显式化**。

#### 理由 2：UI 事件流的 fire-and-forget 需求

Streaming 场景：

- LLM 流式输出每个 token 触发 `content.delta` 事件
- Tool 执行期间 stdout/stderr 不断触发 `tool.progress` 事件
- 这些事件的频率可能达到**几十到上百每秒**

单通道 yield 下每次 yield 都意味着"控制权交出去"——即使消费者处理很快也有调度开销。更糟的是：消费者处理本身可能是 async（例如写日志），generator 就会被 listener 拖慢。所有 listener 串行化在一根管子上，**最慢的 listener 决定了 Soul 的产出速度**。

双通道下 `EventSink.emit` 是同步 `void`，listener 异步处理时 Soul 不等，产出速度不受 listener 影响。

#### 理由 3：崩溃恢复语义的简化

`wire.jsonl` 是 session 对话状态与会话审计记录的唯一持久化真相源。Replay 只需要顺序读 wire.jsonl 记录、逐条 apply 到内存——不需要区分"哪些是状态变更"和"哪些是 UI 事件"，因为 UI 事件根本不进 wire.jsonl。

单通道下如果某个 listener 决定把一部分 UI 事件也落盘（例如为了调试），就会出现"两种 record 类型 / replay 时要不要应用 UI 事件 / 顺序错乱怎么办"等复杂语义。双通道天然把两类事件放在不同通道，崩溃恢复逻辑保持线性简单。

#### 理由 4：listener 故障隔离

EventSink listener 失败（抛异常）不应该影响 Soul 继续执行——它只是“给别人看的东西”。单通道 yield 下消费者处理某个 yield 时抛异常，generator 会被传播这个异常，Soul 直接中断。双通道下 EventSink 可以 swallow 异常只记日志，Soul 的主线不受干扰。

### ADR-X.4 被拒绝的“假解决方案”

这一节列出几个看起来能“合并双通道”但实际上都不行的提议。这些提议很容易想到，所以必须显式记录拒绝理由，防止后续讨论反复。

#### 拒绝方案 1：EventSink 挂 PersistenceListener 写 wire.jsonl

**提议**："既然写状态可以通过 ContextState，为什么不让 EventSink 的 listener 也能写 wire.jsonl？挂一个 `PersistenceListener` 消费所有 emit 的事件，写到 wire.jsonl，代码更统一。"

**拒绝理由**：

- wire.jsonl 会出现**两个写入者**（ContextState 的 JournalWriter + EventSink 的 PersistenceListener），引入"两个真相源漂移"的 bug 类别
- 写顺序不可控——listener 是异步执行的，`emit` 返回 `void` 不保证写完
- Soul 的 `buildMessages` 读到的内存状态和 listener 写到的 wire.jsonl 可能不一致
- 这是 **§5.0 铁律第 5 条**明文禁止的

#### 拒绝方案 2：ContextState 方法改成 sync

**提议**："既然 `SoulContextState` 有 sync 读方法（`buildMessages` / `tokenCountWithPending`），写方法也做成 sync，完全不 await 就不用操心异步了。"

**拒绝理由**：

- 写 wire.jsonl 必然涉及磁盘 fsync，不可能同步
- 如果"写"只更新内存、fsync 异步进行，就有"内存写完但 WAL 未落盘"的窗口——崩溃时丢状态
- WAL 的本质就是"**先落盘再更新内存**"——这个顺序和同步语义是 WAL 系统的底层约定，违反它等于放弃了 write-ahead 的全部意义

#### 拒绝方案 3：所有事件通过 yield 产出，listener 层面做同步/异步分派

**提议**："Soul 用 generator，listener 同步 `await` 写 WAL，UI listener fire-and-forget——这样依然是一根管子出来。"

**拒绝理由**：

- 这本质上是**双通道的伪装版本**——listener 的"同步 await"和"fire-and-forget"两种模式就是双通道的两种写入/广播模式，只是从参数位置搬到了 listener 分派层
- 而且因为 generator 必须等所有 listener 处理完才能恢复（否则顺序不保），同步 listener 会**拖慢**所有 UI listener 的分派，反而比纯双通道更慢
- 代码复杂度更高——需要 listener 分派逻辑 + generator 的锁步语义——没有收益

### ADR-X.5 代价与取舍

双通道方案并非零代价，必须诚实列出：

- **两个接口类型**（ContextState + EventSink）增加了类型系统的表面复杂度
- Soul 开发者需要记住"什么走 ContextState、什么走 EventSink"的划分规则（状态 vs 事件，同步 vs 异步）
- 测试 Soul 时需要 mock 两个接口，不是一个

但这些代价都是**可接受**的：

- 接口分离对应的是"状态"和"事件"两个不同的概念，类型上分开反而更清晰
- 划分规则简单——"会影响下一次 `buildMessages` 结果的走 ContextState，其它走 EventSink"
- 测试时 mock 两个接口比 mock 一个巨大的 generator 消费者更容易写

相比"单通道伪装下的真双通道 + 复杂 listener 分派"，**显式的双通道反而更简单**。

### ADR-X.6 决策

- **v2 最终采用双通道方案**（方案 B）
- **禁止**任何"合并双通道"的提议被接受——除非本 ADR 被正式 supersede
- **禁止** EventSink listener 写 wire.jsonl（§5.0 铁律第 5 条）
- **禁止** ContextState 写方法改成 sync（fsync 刚性 + write-ahead 语义）
- Soul 只能通过 `context.*` 写状态和读状态、通过 `sink.*` 发事件——这是边界的**硬约束**，由 `SoulContextState` / `EventSink` 类型签名和 import whitelist 共同保证

### ADR-X.7 参考

- **cc-remake**：`src/query.ts` 是 async generator 实现（方案 A 的代表）
- **pi-mono**：`packages/agent/src/agent-loop.ts` 是纯函数实现（用 callback 注入而非 yield）
- **v2 §5.0**：7 条铁律（第 7 条由决策 #93 在 Phase 6I 新增），第 5 条明确禁止 EventSink 写 wire.jsonl
- **v2 §4.5 / §4.8**：ContextState 和 EventSink 的接口定义
- **v2 §5.1**：`runSoulTurn` 的完整伪代码，演示双通道的实际用法
- **v2 决策 #78**：Soul/SoulPlus 边界——双通道是其中一部分

---

### ADR-X.78 Soul/SoulPlus 边界（决策 #78 详细论证）

**决策摘要**：Soul = 纯 async function `runSoulTurn`（无 class/this）+ import whitelist（tsconfig path + ESLint `no-restricted-imports`）+ 双通道通信（ContextState 写状态 / EventSink 发事件）。

**详细理由**：

- 参考 pi-mono `runAgentLoop` 纯函数和 cc-remake `query()` async generator——"无状态"从类型签名即可看出，不依赖约定
- Import whitelist 防止代码演化悄悄破坏边界：即使有人出于"顺手"在 Soul 目录下 `import ../soulplus/...`，TypeScript 编译阶段就会报错
- 双通道（ContextState + EventSink）是刚需：
  - **写状态要同步反馈**：Soul 写入后必须能在下一次 `buildMessages` 读到，同步 `await` 是必然
  - **UI 事件要 fire-and-forget**：streaming progress 每秒数十到上百次，同步 await 会拖慢 Soul
  - 两个刚需无法用单通道同时满足，详见 ADR-X.1~X.7（双通道通信的架构选型）
- "无状态函数 + 无 this" 带来的附加收益：
  - 测试零 mock 污染（每个 turn 起新的 pure 调用）
  - per-turn 隔离天然成立（闭包即值）
  - concurrent subagent 不存在共享状态，Node 事件循环天然支持

**相关章节**：§5.0 / §5.1 / §6.12 / §4.5 / §4.8 / ADR-X.1~X.7

---

### ADR-X.79 Tool 执行模型 Model A + 方案 Z（决策 #79 详细论证）

**决策摘要**：while 循环在 Soul 内部（`runSoulTurn` 一次调用跑完整个 turn），不由 SoulPlus 外面逐步调；approval 通过 `beforeToolCall` / `afterToolCall` callback 注入 Soul，Soul 完全不知道 permission/approval 的存在。

**详细理由**：

- **Model A 的行业证据**：
  - cc-remake 的 `query()` 是 async generator，一次调用跑完整个 turn
  - kimi-cli Python 的 `_agent_loop` 在 AsyncIterator 里 yield，一次调用跑完
  - 两个参照实现都采用"while 循环在 loop 函数内部"的 Model A
- **为什么 Model B（外部逐步调）不行**：
  - Approval 本质是 "tool 执行内嵌的 await"——把循环外置后，外部每 step 都要重新 enter/exit soul 状态，复杂度爆炸
  - 即使 Model B 走 generator / resumable 接口，恢复现场时仍然要把 "LLM 消息 + tool 状态 + permission 结果" 全部序列化，等价于做一个 mini VM
  - 最终会退化回 Model A，只是增加了一层伪装
- **为什么选方案 Z（callback 注入）而非方案 Y（Runtime 门面封装）**：
  - 方案 Y 让 Runtime 长出 `requestApproval`、`checkPermission` 等方法，Soul 调 `runtime.approve(...)`——Soul 就"知道" permission 存在了，违反零 permission 词汇的铁律 2
  - 方案 Z 把 approval 封装进 `beforeToolCall` 闭包，Soul 只看到 `await beforeToolCall(name, args, signal)` 返回允许/拒绝/修改——不知道里面是规则匹配还是 UI 弹框
  - pi-mono `agent-loop.ts` 零 permission 字样的实证说明方案 Z 可行

**相关章节**：§5.1.7 / §11.1 / §12.1

---

### ADR-X.81 beforeToolCall 唯一 approval gate（决策 #81 详细论证）

**决策摘要**：`beforeToolCall` 是唯一 approval gate，被允许做耗时操作（读文件、算 diff、查 registry、发 ApprovalRequest 并等响应）；tool 的 execute 不接收 `ctx.requestApproval` 能力；危险模式（shell 命令替换 `$(...)` / eval / 交互式命令）一律在 beforeToolCall 的静态分析阶段硬 deny。

**详细理由**：

- **调研结论**：cc-remake / kimi-cli Python / pi-mono 都没有真正意义的"二次 approval"
  - cc-remake 的 `tool.call` 参数里有个 `canUseTool`（命名为 `_canUseTool`），实际代码路径里从未被调用——是历史遗留死代码
  - kimi-cli Python 的 tool 都在 approval 后直接 execute，execute 里不再 request
  - pi-mono 的 tool 接口根本没有 approval 相关参数
- **真问题不是"二次 approval 需求"，而是"approval UI display 依赖 tool 内部业务计算"**：
  - 例如 FileReplace 要在 approval UI 里展示 diff，diff 需要读原文件 + 算补丁 + 格式化
  - 旧设计把这些计算放在 tool.execute 的前半段，导致"approval 发生在 execute 中间"
  - 新解：把 display 计算搬进 beforeToolCall（它本来就允许耗时操作），execute 纯粹"干活"
- **"不留二次 approval 口子"是纪律红线**：
  - 一旦有"二次 approval"，审批点会分散到各个 tool，safety review 要扫描每个 tool——不可持续
  - 统一到 beforeToolCall 后，所有审批逻辑集中在一处，review 成本 O(1)
- **危险模式硬 deny 的必要性**：
  - Shell 命令替换 `$(...)`、eval、交互式命令都是"审批了也没用"——用户看不到真实执行的命令
  - 这类模式必须在静态分析阶段就拒绝，不让 LLM 以为"用户会同意"

**相关章节**：§11.9 / §12.2 / §12.3

---

### ADR-X.82 ContextState 一分为二（决策 #82 详细论证）

**决策摘要**：`SoulContextState`（Soul 能读能写的窄视图：`buildMessages / tokenCountWithPending / drainX / appendAssistantMessage / appendToolResult / addUserMessages / applyConfigChange / resetToSummary`，**状态类** record 写入）+ `FullContextState extends SoulContextState`（SoulPlus 独占写方法：`appendUserMessage` + Phase 6E 后新增的 `appendNotification` / `appendSystemReminder`）。

⚠️ **Phase 6E 部分撤销**：原决策里"`notification` / `system_reminder` 归 SessionJournal + `pendingNotifications` turn-scope 缓冲 + `ConversationProjector.ephemeralInjections` 临时注入"的子设计已被决策 #89 撤销，详见附录 F.5。

**详细理由**：

- **边界靠类型保证不靠纪律**：
  - `WiredContextState` 实现 FullContextState，调 runSoulTurn 时 TypeScript 自动收窄为 SoulContextState 传给 Soul
  - Soul 看不到 `appendUserMessage`，编译器强制
- **D2 把"改 buildMessages 的写入"和"只写审计的 journal 写入"彻底分开**：
  - 纯审计 / 生命周期 / 协作类 record（`turn_begin` / `turn_end` / `skill_invoked` / `approval_request` / `approval_response` / `team_mail` / `tool_call_dispatched` / `permission_mode_changed` / `tool_denied`）不走 ContextState，改走并列窄门 `SessionJournal`
  - 两侧共用同一个底层 `JournalWriter`（`JournalWriter` 仍是唯一物理写入点），保证写入顺序和 seq 分配正确
- **为什么不在 ContextState 里多加一个 `auditOnly: true` 参数**：
  - 参数式分流让"一个方法两种语义"，类型签名看不出来
  - 静态分析无法检查"审计 record 有没有被误塞进 buildMessages"
  - 类型分离让两侧各自有独立的签名和方法名

**相关章节**：§4.5.2 / §4.5.5 / §5.1.2 / §6.6 / ADR-X

---

### ADR-X.83 TurnOverrides 一分为二 + SoulConfig.tools 按 turn 传入（决策 #83 详细论证）

**决策摘要**：`FullTurnOverrides`（TurnManager/SkillManager 内部用，含 `model/effort/activeTools/disallowedTools`）vs `SoulTurnOverrides`（Soul 看到，仅 `model/effort/activeTools`，且 activeTools 在 Soul 侧只做 LLM visibility filter）；TurnManager 调 runSoulTurn 前把权限相关 override（activeTools=allow / disallowedTools=deny）转成 turn-scope PermissionRule baked 进 beforeToolCall 闭包；`SoulConfig.tools` 按 turn 传入不从 Runtime 取（subagent 可每 turn 传不同子集）。

**详细理由**：

- **Soul 零 permission 词汇的必然推论**：
  - 权限信息必须在 Soul 之外处理，否则 Soul 里就会出现 `disallowedTools` 这种字段
  - Baked 进闭包是最干净的做法——Soul 看到的就是一个不知道里面有什么的 callback
- **activeTools 在 Soul 侧只做 visibility filter 的语义**：
  - LLM 可见性过滤纯粹是"不给 LLM 看到这个 tool"，是建议性的
  - 真正的安全边界是 beforeToolCall 闭包——即使 LLM 通过 hallucination 调了不该调的 tool，闭包会 deny
  - 双层防护：LLM 可见性过滤 + beforeToolCall 闭包（见决策 #71）
- **为什么 `SoulConfig.tools` 按 turn 传入而非从 Runtime 取**：
  - Subagent 限制工具集是一等公民——父 agent 调 Task tool 时可以指定"只给子 agent `file_read` / `glob` 两个工具"
  - 如果 tools 存在 Runtime 里，subagent 要么共享父 runtime（无法限制）要么 fork 新 runtime（开销大）
  - 按 turn 传入让 subagent 共享 Runtime 的稳定能力（kosong / journal / lifecycle），每 turn 独立指定 tools 子集
  - Runtime 作为稳定能力容器不适合频繁换 tool 列表

**相关章节**：§5.1.4 / §11.6 / §11.7 / §6.12.2

---

### ADR-X.85 Compaction 由 Soul 驱动（决策 #85 详细论证）

> ⚠️ **本 ADR 已被决策 #93 部分撤销（Phase 6I）**：执行流程已从 Soul 移到 TurnManager.executeCompaction（铁律 7）。本节保留作为历史决策档案：决策 #85 真正合理的内核——"触发检测只能 Soul 做（只有 Soul 知道下一次 LLM 调用即将超限）"——保留；执行流程的"Soul 驱动"部分被撤销。详见决策 #93 与新增的铁律 7。

**决策摘要**：Compaction 的触发检测（token 超阈值判断）和执行流程（生成 summary → rotate 文件 → reset context）都在 Soul 的 while 循环内；SoulPlus 只提供两个窄能力：`runtime.lifecycle.transitionTo("compacting"|"active")` 切 lifecycle gate、`runtime.journal.rotate(boundaryRecord)` 物理轮转；Soul 按 `transitionTo compacting → compactionProvider.run → journal.rotate → context.resetToSummary → transitionTo active` 顺序驱动。

**详细理由**：

- **只有 Soul 知道"下一次 LLM 调用快要超限了"**：
  - Compaction 触发依赖对"当前 messages + 即将加入的 user/tool messages"的 token 计算
  - 这个计算紧挨着 step 循环，只有 Soul 能做
  - 让 SoulPlus 从外面检测意味着 SoulPlus 要 reach into Soul 的状态——破坏边界
- **执行流程由 Soul 驱动让 Soul 能决定策略**：
  - 何时 compact（在哪个 step 边界触发）
  - 用什么 summary prompt（可能根据当前对话类型选不同模板）
  - Compaction 失败的 fallback（继续硬塞超限 request 还是直接报错）
- **SoulPlus 通过两个窄接口提供"我负责物理边界"的能力**：
  - `lifecycle.transitionTo("compacting")` 切 lifecycle gate，阻止 compaction 期间的其它写入
  - `journal.rotate(boundaryRecord)` 原子 rename 旧 wire.jsonl → wire.N.jsonl + 创建新 wire.jsonl 以 boundaryRecord 开头
  - 两个接口都是"命令式"，Soul 调用它们但不"持有"它们——不侵入 Soul 的循环控制权

**相关章节**：§5.1.7 / §6.12.2

---

### ADR-X.87 CompactionProvider 接受参数 + signal（决策 #87 详细论证）

**决策摘要**：`CompactionProvider.run(messages, signal, options?)` 的 options 不是摆设：支持用户主动触发 compaction 时传递自定义参数（如 `{targetTokens?: number, userInstructions?: string}`）；`signal: AbortSignal` 是 D17 Abort Propagation Contract 的一部分——compaction 必须贯穿 turn 级 root scope，能响应 `TurnManager.abortTurn(...)` 的级联中断（由 `rootController.abort()` 触发 `AbortError`）；参数顺序按 TypeScript 惯例把必选 signal 排在可选 options 之前（见 §6.12.2 接口定义）；Phase 1 必须支持两个场景：自动 compaction（Soul 检测到 token 超阈值，options 缺省走默认值）和用户主动 compaction（由 `session.compact` Wire method 触发的 system-triggered turn，options 可含 targetTokens 或 userInstructions）。

**详细理由**：

- **kimi-cli 原有设计就支持用户主动 compaction，有真实使用场景**：
  - "浓缩为 1k token"（用户觉得当前对话太冗长）
  - "只保留和 X 相关的内容"（用户聚焦到某个话题）
  - 这些场景需要 `targetTokens` 和 `userInstructions` 参数
- **把能力一开始 encode 进接口比事后改签名更好**：
  - 事后加参数会影响所有 provider 实现和调用点
  - 接口里带可选 options 对默认场景零成本（缺省走默认值），对扩展场景一等公民
- **signal 参数必须显式**：
  - Compaction 涉及 LLM 调用，可能耗时数十秒
  - 如果不接受 signal，用户按 Ctrl+C 时 compaction 会继续跑完才中断——体验极差
  - 更严重的是 abort 链会在 compaction 处断开——TurnManager abortTurn 后仍有 LLM 请求在跑
  - D17 要求所有 turn 内的 async 操作都挂在 root scope 的 signal 上
- **参数顺序**：
  - TypeScript 惯例是必选参数前置，可选参数后置
  - `run(messages, signal, options?)` 比 `run(messages, options?, signal)` 清晰

**相关章节**：§6.12.2 / §7 / §9.x / §5.1.7

---

### ADR-X.89 Notification / System Reminder / Memory Recall 走 ContextState durable 写入（决策 #89 详细论证）

**决策摘要**：删除 `ConversationProjector.ephemeralInjections` 参数、删除 `TurnManager.pendingNotifications` 字段、删除 `NotificationManager.enqueuePendingNotification` 回调；notification / system reminder / memory recall 改为通过 `FullContextState.appendNotification` / `appendSystemReminder` / `appendMemoryRecall`（Phase 2）做 durable 写入，作为 `NotificationRecord` / `SystemReminderRecord` / `MemoryRecalledRecord` 进 ContextState 管理的 transcript；`ConversationProjector.project` 签名从 `project(snapshot, ephemeralInjections, options)` 简化为 `project(snapshot, options?)`；projector 遇到 NotificationRecord 组装为系统消息、遇到 SystemReminderRecord 组装为 `<system-reminder>` 包裹消息（和 CC 对齐）；SessionJournal 不再管 notification / reminder，只管纯审计/生命周期类 record。

**详细理由**：

- **核心原则：LLM 看过的内容必须永久留存**（上下文是 append-only 的事实记录）
- **v2 初稿为什么错了**：
  - 决策 #82 的通知子设计让 notification 只在当前 turn 的一次性注入里存在
  - Turn N+1 就看不到了——会造成 assistant "我基于 Task X 的结果..."（来自 Turn N）在 Turn N+1 的上下文里完全找不到任何关于 Task X 的事实
  - 这会触发 LLM 的幻觉（"我之前说了什么？"）或"Task X 是什么？"的追问
  - 本质上违反了"上下文是 append-only 的事实记录"原则
- **CC 的对齐**：
  - CC 的 notification / system reminder / memory recall 都是 durable 写入
  - CC 的 `<system-reminder>` 包裹消息是一等公民，每次 LLM 调用都带上
  - v2 与之对齐——不在这个 ground truth 问题上做奇葩设计
- **代价与收益**：
  - 代价：通知/提醒不能被"按 turn 擦除"
  - 收益：因果链完整，assistant 的后续引用永远有据可查
  - 代价是可接受的——"上下文干净"的短期诉求远不如"因果链完整"的长期价值
- **影响**：
  - TurnManager 删除 pendingNotifications
  - NotificationManager 直接写 ContextState
  - SessionJournal 去掉 appendNotification
  - Projector 变成纯粹的 snapshot → Message[] 投影
  - 决策 #82 的对应子设计被标注为已撤销（详见附录 F.5）

**相关章节**：§0 / §3 / §4.3 / §4.5.1 / §4.5.2 / §4.6 / §4.7 / §5.1.7 / §6.4 / §6.6 / §8.3.4 / §9.x / 附录 B / 附录 D / 附录 F.5

---

### ADR-X.90 Agent Team 通信层 = TeamCommsProvider 可插拔接口（决策 #90 详细论证）

**决策摘要**：把 Team 通信层重构成可插拔传输抽象：拆分为三个窄接口 `TeamMailbox`（publish/poll/ack/cleanup + 可选 subscribe）/ `TeamRegistry`（registerTeam/registerMember/listMembers/markMemberDead/deregisterTeam）/ `TeamHeartbeat`（updateHeartbeat/listStaleMembers），由 `TeamCommsProvider` 组合（`{ mailbox, registry, heartbeat, init, close }`）。Phase 1 实现 `SqliteTeamComms`（默认生产）+ `MemoryTeamComms`（测试）；Phase 2 加 `FileTeamComms`（降级，无 native binding 环境）；Phase 3 加 `RedisTeamComms`（跨机器 team）。SQLite schema 本身不变，只是被封装进 `SqliteTeamComms` provider，TeamDaemon 和上层业务看不到。`TeamMailRepo` 删除、`TeamMailRow` 重命名为 `MailEntry`、`MailEnvelope` 加 `from/to/timestamp` 字段对齐 transport 语义。`TeamDaemonDeps` 从 5 窄依赖扩到 6 窄依赖（新增 `mailbox`/`heartbeat`，移除 `teamMailRepo`）；`SoulPlus` constructor 新增可选参数 `teamComms?: TeamCommsProvider`——单 session / 无 team 场景可缺省，TeamDaemon 不启用。原 `TeamMailRepo.commitDelivered` 封装的"先 append journal 后 UPDATE status"顺序保证从 repo 内部拉回到 `TeamDaemon.handle` 方法里，provider 只管自己的存储不越界管 journal。Phase 1 强制加入两项额外纪律：(1) 消息优先级 —— poll 结果经 `sortByPriority()` 按 `shutdown_request > approval_request > approval_response > team_mail` 排序后 dispatch；(2) 定期清理 —— TeamDaemon 每小时调用一次 `mailbox.cleanup(teamId, 24 * 3600 * 1000)` 清理老的 delivered 消息。

**详细理由**：

- **CC 的教训**：
  - CC 的执行层（TeammateExecutor）有抽象，但消息通道完全硬编码（文件 inbox + `proper-lockfile`）
  - 想换 Redis / SQLite 要改全局几十处
  - 这是 v2 必须避免的陷阱
- **为什么拆三个窄接口**：
  - v2 初稿的 `TeamMailRepo` 是单一接口，混合了消息/注册/心跳三个职责，违反单一职责原则
  - 三个窄接口拆开后：
    1. 组合自由度更高，未来可混搭（如 SQLite mailbox + Redis heartbeat）
    2. 测试只 mock 需要的那一个
    3. 每个接口都能独立换实现
    4. provider 边界不越界管 journal
- **为什么保留 SQLite 作为默认**（经过技术权衡）：
  - 并发：WAL 模式允许多 reader + 1 writer 并发，文件 inbox 要靠 flock
  - 查询：索引让 `SELECT WHERE status='pending'` 接近 O(log n)，文件 inbox 要线性扫目录
  - 清理：`DELETE WHERE timestamp < ?` 一条 SQL，文件 inbox 要遍历删
  - 去重：UNIQUE 约束天然保证，文件 inbox 要靠命名 + 检查
  - 事务：BEGIN/COMMIT 保证原子性，文件 inbox 要靠 rename + fsync
  - 各方面都优于文件 inbox
- **Memory 实现让测试不依赖 better-sqlite3 native binding**：
  - CI 环境可能没有 native build toolchain
  - 单元测试不需要真 SQLite
- **消息优先级和定期清理是 CC 的两个明确教训**：
  - CC 按 FIFO 处理导致紧急消息（shutdown）被堵在普通消息后面
  - CC inbox 只标记 read 不删除，文件无限膨胀
  - Phase 1 就必须有这两个纪律
- **可选 `subscribe()` 为 Phase 2+ push 模式预留**：
  - 不强制所有 provider 实现
  - 支持 push 的 provider 可以把轮询频率降到兜底级别（如 10s 一次）
  - 不支持的 provider（如 File / 纯 Memory）继续靠自适应轮询

**相关章节**：§0 / §6.1 / §6.8 / §8.3 / §8.3.1 / §8.3.2 / §8.3.3 / §8.3.6 / §9.4.1 / §20 / 附录 D.8

### ADR-X.95 JournalWriter 异步批量写入（决策 #95 详细论证）

**决策摘要**：`JournalWriter.append` 改为"内存先行 + 异步追赶"双层架构——同步 push `pendingRecords` 内存缓冲（`buildMessages()` 立即可见），异步入 `diskWriteQueue` 由后台 `drainIntervalMs=50ms` 定时 drain 落盘；force-flush kinds（`approval_response` / `turn_end` / `subagent_completed` / `subagent_failed`）触发立即 drain 并等磁盘 fsync 完成才 resolve，永不丢失；其他 record 接受最坏 ≤ drainIntervalMs 的丢失窗口（崩溃恢复按 §9.x 矩阵补 synthetic record 兜住）。

**详细理由**：旧"每条 fsync"模式让 Soul 写状态时阻塞磁盘 IO（典型耗时 1-5ms × 每个 step 多次写入），影响 turn 端到端延迟；CC 路线（性能优先 100ms drain）和 pi-mono 路线（每条 `appendFileSync` 同步）之间，v2 选 50ms 折中，对用户感知接近无损（force-flush kinds 完整保护用户决策类 record），又显著降低 Soul 阻塞。铁律 4 的"写完立即能读到"在技术上只要求"内存可见"，磁盘可见可异步追赶。详见 plan `subagent-plans/plan/p1-journal-async-batch.md`。

**相关章节**：§4.5.3 / §4.5.4 / §9.x

### ADR-X.96 Overflow → Compact → Retry 自动恢复（决策 #96 详细论证）

**决策摘要**：Phase 1 必做三层防御——L1 Tool Result Budget（`Tool.maxResultSizeChars` 字段：builtin 默认 50K / MCP wrapper 100K，超阈值持久化磁盘 + replace `<persisted-output>` preview）；L2 阈值触发 `executeCompaction(reason: "auto")`（与 #93 `needs_compaction` 路径合流）；L3 反应式 `executeCompaction(reason: "overflow")`（KosongAdapter 检测 input overflow 抛 `ContextOverflowError`，TurnManager 兜底 compact + retry）+ `MAX_COMPACTIONS_PER_TURN = 3` 熔断。

**详细理由**：Python 1.27 教训"`max_tokens` 调整无法解决 input overflow"——`max_tokens` 是 output 上限，而 overflow 是 input 超限；正解是 compact 后续跑。L1 切断单条结果污染（教训：MCP `MCP_MAX_OUTPUT_CHARS=100K` Python 的常量化），L2 主动减压避免 overflow，L3 兜底反应式恢复——三层组合保证用户绝大多数场景无感。LLM 想要原文可以 Read 重读。详见 plan `subagent-plans/plan/p0-overflow-compact-retry.md`。

**相关章节**：§3.5 / §6.4 / §10.6 / §17A.10

### ADR-X.97 Streaming Tool Execution 预留注入点（决策 #97 详细论证）

**决策摘要**：Phase 1 必做最小预留——Soul loop 增加 3 行 prefetch 检查（`runToolCall` 入口先查 `kosong.drainPrefetched()`，如果有 prefetched 结果直接复用）+ KosongAdapter 接口预留 `onToolCallReady?(toolCall)` 回调和 `_prefetchedToolResults: Map<string, ToolResult>` 字段。Phase 1 不启用并发，Phase 2 启用受控并发（基于 §11.7.1 `isConcurrencySafe` gate）不破坏 Soul loop 形态。

**详细理由**：升级自原 plan 的"推荐合入"，因 Python kosong 全并发的工程教训不可忽略——v2 的 Bash / Write / Edit 等强副作用 tool 全并发会引入 race。CC 路线"受控并发"由 `isConcurrencySafe` 元数据决定，更可控、更可审计。Soul loop 结构不动，能力下沉到 KosongAdapter / ToolCallOrchestrator——这是 v2 强保留的设计纪律（铁律 7）。详见 plan `subagent-plans/plan/p2-streaming-tool-execution-prep.md`。

**相关章节**：§5.1.7 / §6.13 / §10.7.5 / §11.7.1

### ADR-X.98 Tool UI 渲染契约（决策 #98 详细论证）

**决策摘要**：Phase 1 必做接口槽位 + Wire schema 字段一次到位——6 个 display hook（`getUserFacingName` / `getActivityDescription` / `getInputDisplay` / `getResultDisplay` / `getProgressDescription` / `getCollapsedSummary`）集中在 `Tool.display: ToolDisplayHooks` 字段；2 套 discriminated union（`ToolInputDisplay` / `ToolResultDisplay`，10+ 个具名 kind + `generic` fallback）落 wire.jsonl 让 replay 可还原；EditTool / WriteTool 的 diff 由 `ToolCallOrchestrator` 在 approval/display 阶段统一计算并复用；`ApprovalDisplay` 收编为 `ToolInputDisplay` 别名（§12.2 整合）。

**详细理由**：避免 Phase 2 加字段引发 Wire schema breaking change（schema 一次到位，字段没填只是 default fallback）。具体内置 tool 的 display 实现可渐进补，不必 Phase 1 全部到位。`ApprovalDisplay` 收编是发现"approval 展示给用户的 tool 调用前快照" = `ToolInputDisplay` 同一种东西的重构。详见 plan `subagent-plans/plan/p0-tool-ui-render-contract.md`。

**相关章节**：§3.6.1 / §10.2 / §10.7 / §12.2 / 附录 B / 附录 D.2

### ADR-X.99 Skill 自主调用（决策 #99 详细论证）

**决策摘要**：Phase 1 必做最小完整方案让 Soul 在 turn 中自主调用 skill——`SkillTool` 加入 §10.3.1 协作工具族（host-side 注入 `SkillManager` + `SkillInlineWriter`（inline）/ `SubagentHost`（fork））；Skill listing 走 `FullContextState.appendSystemReminder` durable 写入（projector 自然组装为 `<system-reminder>` 系统消息）；inline 注入用 `<kimi-skill-loaded>` tag 包裹防套娃，export filter 必须保留；Read / Glob 工具白名单加入 `${KIMI_HOME}/skills/` / `${PROJECT}/.kimi/skills/` / `${KIMI_HOME}/plugins/<name>/skills/`（fail-safe，Python 1.27 教训）；`MAX_SKILL_QUERY_DEPTH = 3` 限制（比 CC 不限深度更保守，防 LLM 自我迭代灾难）。

**详细理由**：v2 比 Python 先吃下这块——Skill 在 LLM 引导上是高 ROI 的能力。allowlist 比 CC 黑名单更可审计；durable 写入对齐 §4.5.2 isMeta 惯例和 ConversationProjector 自然路径，无需 turn-scope 缓冲。详见 plan `subagent-plans/plan/p0-skill-autonomous-invocation.md`。

**相关章节**：§4.5.2 / §10.3.1 / §15.9 / §15.10 / §15.11 / §15.13

### ADR-X.100 MCP 集成 Phase 1 接口预留（决策 #100 详细论证）

**决策摘要**：Phase 1 必做接口预留 8 人日——9 个核心接口定义（`McpClient` / `McpTransport` / `McpRegistry` / `McpToolAdapter` / `McpAuthAdapter` / `McpServerConfig` / `McpTransportConfig` / `McpPolicy` / `McpRegistrySnapshot`）+ `NoopMcpRegistry` 占位实现 + ToolRegistry 异步路径（`registerBatch` / `unregister*` / `onChanged`）+ ApprovalSource `mcp` 分支 + Wire methods `mcp.*` 占位 + Wire events 6 个 `mcp.*` schema + PathConfig 5 个路径方法 + HookEngine `OnMcpElicitation` 占位；按 §6.1 6 facade 模型，`mcpRegistry` 归入 `services` facade（详见 §17A.7.1）。Phase 3 实现约 45 人日。

**详细理由**：Python 没有 MCP 实现，参考价值 = 0。Phase 1 接口预留 8 人日 vs Phase 3 大重构 9 个子系统契约（ToolRegistry / ApprovalSource / Wire / PathConfig / HookEngine / Plugin / SoulPlus / Crash Recovery / Configuration），明显划算。MCP 通过 ToolRegistry 间接看到 Soul（铁律 6 不变），不污染 Soul loop。详见 plan `subagent-plans/plan/p0-mcp-integration-architecture.md` 和 §17A。

**相关章节**：§3.5 / §3.6 / §6.1 / §6.2 / §10.5 / §12.2 / §16 / §17A 全章 / §20.1

### ADR-X.101 CompactionProvider tail user_message 契约（决策 #101 详细论证）

**决策摘要**：`CompactionProvider.run` 实现方必须保证——如果入参 `messages` 末尾包含一条未配对的 user_message（没有后续 assistant response），它必须以独立 message 形式出现在返回的 `output.summary` 数组末尾。`TurnManager.executeCompaction` 在 `compactionProvider.run` 返回后做兜底校验：违反契约时 emit warning 并自动把 tail user_message 推回 summary 末尾（自愈而非 crash，避免一次错误的 summary 直接 fail 整个 turn）。同时新增 `isUserMessagePaired` helper 判定末尾 user_message 是否已配对。

**详细理由**：v2 的 `appendUserMessage` 在 `startTurn` 循环外（§6.4），compaction 后 `resetToSummary(output.summary)` 是完全替换 history。如果 CompactionProvider 实现遗漏末尾的 user_message——把它混进摘要文本块——LLM 在 compaction 后看到的 messages 里没有独立的待回应 prompt，Soul while 循环第一步 `response = await kosong.chat(...)` 返回 `end_turn`（无事可做），turn 0 步结束，用户 prompt 无响应。这是一个 P0 bug。CC 的 `buildPostCompactMessages` 显式串接 `messagesToKeep` 到 summary 末尾；pi-mono 的 `keepRecentTokens=20K` 始终保 tail；Python `SimpleCompaction.max_preserved_messages=2` hardcode 保留最后 2 条——三个参照实现都有自己的"保 tail"机制，但都是隐式的。v2 把它显式化为接口契约 + TurnManager 兜底校验，third-party CompactionProvider 实现遗漏时自愈而非静默丢消息。

**相关章节**：§6.4（executeCompaction 伪代码 + isUserMessagePaired helper）/ §6.12.2（CompactionProvider interface 注释）

**参考 plan**：`subagent-plans/plan/arch-roi-A-control-flow.md` 问题 1.2

### ADR-X.102 cancelBySource 同步语义边界（决策 #102 详细论证）

**决策摘要**：`ApprovalRuntime.cancelBySource(source): void` 同步 void 只承诺 "in-memory 状态立即一致"——in-memory waiter 立即 reject、cancel event 立即 emit 到 EventSink。不承诺 synthetic cancelled response 落 wire.jsonl（走 SessionJournal fire-and-forget 异步追赶）、agent team 跨进程撤销（mailbox publish ApprovalCancel envelope 异步）。崩溃窗口靠 `recoverPendingOnStartup` + request_id 去重兜住，最终一致。

**详细理由**：review agent 担心"同步 void 签名与 SQLite 异步操作矛盾"。实际上矛盾不存在——`cancelBySource` 的同步保证只覆盖 in-memory 操作（reject waiter + emit event），落盘和跨进程通信都是 fire-and-forget 异步。这与 §7.2 abort 标准顺序兼容：`cancelBySource` 是 abort 链的第一步，必须不阻塞，才能让后续 `controller.abort(...)` 立刻接力。Python 的 `cancel_by_source`（`approval_runtime/runtime.py:149`）同样是同步函数，跨语言一致。v2 不需要改任何代码或设计——只需要在 §12.2 接口注释和 §7.2 abort 顺序代码注释里显式化这个边界，避免 third-party 实现者误把 SQLite await 写进 cancelBySource 路径。

**相关章节**：§12.2（cancelBySource 接口注释）/ §7.2（abort 标准顺序交叉引用注释）

**参考 plan**：`subagent-plans/plan/arch-roi-A-control-flow.md` 问题 1.5

### ADR-X.103 NotificationRecord envelope_id + enqueueNotification 必须 await（决策 #103 详细论证）

**决策摘要**：(1) `NotificationRecord.data` 新增 `envelope_id?: string`，仅 team mail envelope 转入时填写，用于 §9.4.1 启动恢复的 envelope-level 幂等去重。(2) `NotificationManager.emit` 和 `TeamDaemonDeps.enqueueNotification` 的 async 签名显式标注，TS 编译器强制 caller await。(3) §8.3.3 TeamDaemon.handle 中明确标注 enqueueNotification **必须 await**。

**详细理由**：§9.4.1 的崩溃矩阵第 3 行描述了"SQL 已 ack 但 ContextState 写入未发起"的窗口——恢复时需要识别"已 ack 但未通知"的 envelope，这要求 wire 中的 NotificationRecord 携带 envelope_id 以供反查。如果不加 envelope_id，恢复路径只能假设"所有 delivered 的通知都已在 wire 里"——但这对崩溃在"ack 后、emit 前"窗口的场景不成立。Python kimi-cli 的 3 状态机（`pending → claimed → acked`）是更强的模型，但 v2 用 envelope_id + type system 强制 await 的轻量方案，在 Phase 1 的复杂度预算内已足够。

**相关章节**：§4.3（NotificationRecord 字段定义）/ §6.6（NotificationManager.emit 签名注释）/ §8.3.3（TeamDaemon.handle await 约束）/ §9.4.1（envelope-level 幂等）/ 附录 D.5（NotificationData 类型）

**参考 plan**：`subagent-plans/plan/arch-roi-B-events.md` 问题 1.4

### ADR-X.104 跨平台写入策略（决策 #104 详细论证）

**决策摘要**：§9.6 新增跨平台写入策略，引入 `atomicWrite` 工具函数（tmp + fsync + rename），统一处理 `state.json` 等需要原子写入的文件。`wire.jsonl` append-only 不需要 atomic write（只有 compaction rotate 需要）。compaction rotate 的 rollback 在 Windows 上用"先 unlink 再 rename"替代直接 rename 覆盖。SQLite WAL 自带跨平台锁。

**详细理由**：v2 的 compaction rotate 路径（`rename(wire.jsonl, wire.N.jsonl)` → `create(wire.jsonl)`）在 Windows 上 rollback 时需要注意——如果新 `wire.jsonl` 已经创建，Windows 上直接 `rename(wire.N.jsonl, wire.jsonl)` 会失败（EEXIST）。Python kimi-cli 1.27.0 明确引入 `atomic_json_write` 修复了 metadata 文件 crash 损坏的问题（CHANGELOG: "Use atomic JSON writes for metadata and session state files to prevent data corruption on crash"），CC 也有 `file.ts` 的 tmp+rename 模式。v2 统一采用相同策略。

**相关章节**：§9.6（跨平台写入策略）/ §二（运行时假设 - OS 假设引用）

**参考 plan**：`subagent-plans/plan/arch-roi-C-recovery.md` 问题 P3-POSIX

### ADR-X.105 统一启动恢复顺序（决策 #105 详细论证）

**决策摘要**：§9.7 新增 `SoulPlus.create` 的 6 步恢复顺序定义，显式化各 owner 恢复之间的顺序依赖。不引入 RecoveryCoordinator 类——启动恢复只发生在一个位置，抽象层的收益不覆盖成本。

**详细理由**：v2 的 6 处恢复策略散落在不同章节，新人无法从任何单一位置理解完整启动序列。最关键的顺序依赖是：(1) compaction rollback 必须最先（决定哪个 wire.jsonl 是当前文件）；(2) ApprovalRuntime 恢复依赖 ContextState 已 replay 完成（需要知道哪些 approval_request 是 dangling 的）；(3) TeamDaemon 恢复依赖 wireIndex 已建立（用于 envelope dedup）和 ApprovalRuntime 已就绪（处理 approval envelope）。CC 把恢复集中到 `deserializeMessagesWithInterruptDetection`（单一 pipeline，所有 filter 串行），Python 在 `app.py` 把 3 个 recover 调用平铺——两者都是"隐式顺序但实践中 OK"。v2 选择显式化，投入 0.5 人日，避免 Phase 3+ 加 MCP / Mailbox 时出现恢复顺序冲突。

**相关章节**：§9.7（统一启动恢复顺序）/ §6.2（启动顺序表新增"恢复"阶段行）

**参考 plan**：`subagent-plans/plan/arch-roi-C-recovery.md` 问题 2.2

### ADR-X.106 EventSink seq 语义规范（决策 #106 详细论证）

**决策摘要**：§6.13.6 新增 seq 语义规范，明确 seq 是 per-SessionEventBus 全局单调递增序列号，subagent wrapper 转发时父 EventBus 重新分配 seq，client 用 `after_seq` 拉到所有 source 的事件。

**详细理由**：v2 是 CC / pi-mono / Python 三个对照项目中唯一引入 seq 概念的。CC 完全没有 seq（pull 模式 AsyncGenerator，顺序由迭代器协议保证）；pi-mono 也没 seq（listener 串行 await）；Python 也没 seq（BroadcastQueue 单消费者按入队顺序写）。v2 引入 seq 是为了支持断线重连的增量事件重放——但 seq 的作用域（全局 vs per-source）和多写者语义之前未写明。明确后：(1) client 断线重连只需记住一个 lastSeq，发 `after_seq` 即可拿到所有遗漏事件；(2) client 按 source 分窗口渲染时自行 filter——server 不承担 source 过滤责任；(3) subagent wrapper 里"先写子 wire 再转父 bus"的顺序不变——子 wire 是 source-of-truth，seq 只是传输层的衍生标记。

**相关章节**：§6.13.6（seq 语义规范）/ §6.5（subagent EventSink wrapper 注释）/ §D.6.1（EventSource 类型）

**参考 plan**：`subagent-plans/plan/arch-roi-B-events.md` 问题 1.3

### ADR-X.107 磁盘管理与清理策略（决策 #107 详细论证）

**决策摘要**：§9.8 新增磁盘管理与清理策略，覆盖 wire.N.jsonl 归档（30 天）、tool-results/ GC、subagent wire 目录（7 天）三类可增长文件。启动延迟 10 分钟 + 每小时后台清理 + lockfile 互斥。

**详细理由**：CC 在没有 cleanup 机制之前就收到过用户磁盘满的 issue（`cleanup.ts` 604 行、`backgroundHousekeeping.ts` 启动后 10 分钟 + 24h interval + lockfile + marker 节流）。Python kimi-cli 只防"空 session 残骸"（`_delete_empty_session`），对真实增长完全失能。v2 的目录结构比 CC 更 regular（所有 session 数据在 `sessions/<sid>/` 下），GC 更简单——按 session 目录粒度清理即可。`cleanupPeriodDays=30` 经 CC 生产验证用户接受度高，v2 直接采用。

**相关章节**：§9.8（磁盘管理与清理策略）/ §17.2（目录结构）

**参考 plan**：`subagent-plans/plan/arch-roi-C-recovery.md` 问题 7.5

### ADR-X.108 Health Check / Self-Introspection API（决策 #108 详细论证）

**决策摘要**：§3.5 新增 `session.dump` / `session.healthcheck` / `core.metrics` 3 个管理通道方法，§17.8 新增 Self-Introspection API 章节定义返回类型。Phase 1 骨架，Phase 2 丰富字段。

**详细理由**：v2 生产环境出问题时，目前没有任何自检 API——只能让用户上传 `wire.jsonl` + `state.json`。CC 有 5 个自检命令（`/doctor` / `/heapdump` / `/debug` / `/cost` / `/status`），其中 `/doctor` 诊断安装类型 + 多重安装冲突 + ripgrep 状态，`/heapdump` 用 `v8.writeHeapSnapshot` 写 heap 快照。v2 不需要 CC 这么完整，但最少需要 3 个 API 覆盖"session 级 dump"（排障）、"session 级 healthcheck"（监控）、"进程级 metrics"（运维）三个维度。实现成本 1 天（每个 API 读现有内部状态，不引入新组件），ROI 极高。

**相关章节**：§3.5（Wire 请求方法列表）/ §17.8（Self-Introspection API 章节）

**参考 plan**：`subagent-plans/plan/arch-roi-E-infra.md` 问题 7.4

### ADR-X.109 TurnManager 全拆分（决策 #109 详细论证）

**决策摘要**：TurnManager 拆分为 4 个独立子组件 + 瘦身版 Turn Coordinator。CompactionOrchestrator（6 deps）/ WakeQueueScheduler（0 deps）/ PermissionClosureBuilder（2 deps，独立，不合并到 ToolCallOrchestrator）/ TurnLifecycleTracker（0 deps）。瘦身后 TurnManager 13 deps（9 外部 mock）。1 条 ADR 涵盖全部拆分。

**详细理由**：拆分前 TurnManager 持有 16 deps + 5 内部状态（turnPromises / turnAborts / turnIdCounter / wakeQueue / pendingContextEdits），承担 10+ 职责——compaction 编排、wake 队列管理、permission 闭包构造、turn lifecycle 追踪、skill detection 委托、approval source 生成、metrics 累计。CC 已把 compaction 独立到 `services/compact/` 目录（11 文件），permission 独立到 `useCanUseTool.tsx`（React hook），queryLoop 通过 `deps.autocompact()` + `canUseTool` 回调注入。pi-mono 把 wake 队列拆到 `PendingMessageQueue` 独立类，compaction 拆到 `core/compaction/` 3 文件。Python KimiSoul 的 20 字段 god object 是反面教材——v2 不应重蹈覆辙。

**拆分关键决策**：
- D1：拆出 4 个组件（CompactionOrchestrator / WakeQueueScheduler / PermissionClosureBuilder / TurnLifecycleTracker）
- D2：CompactionOrchestrator 和决策 #93 完全对齐（Soul 只检测、不执行；编排权在 CompactionOrchestrator）
- D3：PermissionClosureBuilder 独立（不合并到 ToolCallOrchestrator）——二者变化节奏不同
- D4：WakeQueueScheduler 不处理 steer（steer 走 ContextState.addUserMessages 路径，不经 wake 队列）
- D5：TurnLifecycleTracker 保留独立（abort 标准顺序的前两步 cancelBySource / discardStreaming 留在 TurnManager 编排）
- D6：瘦身后 13 deps（4 子组件 + 9 外部），实际 mock 9 个
- D7：test harness 后续——每个子组件可独立测试，mock ≤ 6
- D8：本 ADR 涵盖全部拆分，不另开 ADR

**相关章节**：§6.1（SoulPlus facade）/ §6.2（启动顺序 DAG）/ §6.4（TurnManager 全拆分）/ §7.2（abort 标准顺序）/ §8.3.3（TeamDaemon deps）

**参考 plan**：`subagent-plans/plan/p1-turnmanager-split.md`

### ADR-X.110 EventSink Backpressure 与 listener 契约（决策 #110 详细论证）

**决策摘要**：§6.13.6 新增 backpressure 与 listener 契约小节。eventLog 分类缓冲（状态事件 2000 条不丢 + 过程事件 8000 条溢出淘汰）、listener 不应阻塞（< 1ms）、lag 检测 onLag 回调、subscriber 上限 10 个。

**详细理由**：v2 的 EventSink 是 fire-and-forget push 模式（铁律 4），但 subscriber 端缺少契约。当前 eventLog 只有一个大数组 + shift 淘汰——content.delta 洪水（每个 token 一次 emit）会把 turn.end / tool.call 等关键状态事件挤出 eventLog，导致断线重连时丢失关键状态信息。CC 用 async generator pull 模式天然有 backpressure；v2 的 push 模式需要显式区分"状态事件必须完整"和"过程事件尽力而为"。分类 ring buffer 是最小侵入的方案——不改 EventSink.emit 签名（仍返回 void），只在 SessionEventBus 内部做分类存储。

**相关章节**：§4.8（EventSink 铁律）/ §6.13.6（事件缓冲与断线重放）

**参考 plan**：`subagent-plans/plan/arch-roi-B-events.md` 问题 7.7

### ADR-X.111 Cost Tracking 跨 provider（决策 #111 详细论证）

**决策摘要**：§6.12.5 新增 Cost Tracking 小节。CostCalculator 接口 + DefaultCostCalculator（正则匹配 model pricing）+ TurnManager.onTurnEnd 调用 + ContextState cumulativeCost 累计。附录 D 新增 CostCalculator / CostBreakdown 类型。

**详细理由**：v2 的 TokenUsage 只有 input/output token 计数，用户关心的是"这个 session 花了多少钱"而不是"用了多少 token"。CC 有 `/cost` 命令（显示 session 累计花费）；Python kimi-cli 有 `_cost_tracker`（内置 pricing 表）。v2 跨 provider（OpenAI / Anthropic / Moonshot / ...），pricing 差异大，需要可扩展的 pricing 匹配机制。DefaultCostCalculator 用正则匹配 model name，未匹配模型返回 `cost_usd = null`（不猜，明确标 unknown），比 CC 的硬编码更灵活。Phase 1 不做 per-user 配额（QuotaPolicy）和 billing integration——这些是 Phase 3+ 的企业功能。

**相关章节**：§6.12.5（Cost Tracking）/ 附录 D.10（CostCalculator / CostBreakdown 类型）

**参考 plan**：`subagent-plans/plan/arch-roi-E-infra.md` 问题 7.2

### ADR-X.112 Soul 嵌入性坦诚降级 + Minimum Host 参考（决策 #112 详细论证）

**决策摘要**：§5.1.9 修改嵌入性措辞，删除"10-15 行"误导性声明，改为实际估算（50-80 行核心代码 + 辅助类型）。新增 Minimum Embeddable Host 参考伪代码。明确嵌入价值是"可测试 + 可替换 host"，不是"零成本接入"。

**详细理由**：§5.1.9 原文暗示"几行代码就能嵌入 Soul"，但实际嵌入需要：(1) SoulContextState 实现（11+ 方法：buildMessages / appendAssistantMessage / appendToolResult / addUserMessages / drainSteerMessages / tokenCountWithPending / ...）；(2) KosongAdapter 实现（含 OAuth retry + ContextOverflowError 检测）；(3) EventSink（至少 CollectingSink / nullSink）；(4) 至少一个 Tool。参考 kimi-cli Python 的嵌入示例（`examples/custom-kimi-soul/main.py`，60 行 + 8 个对象构造）。坦诚降级避免第三方嵌入方在 pre-sales 阶段被误导，也避免内部团队低估嵌入集成的工作量。Soul 的可嵌入性价值是"可测试 + 可替换 host"——嵌入方可以用自己的 host 替换 SoulPlus，完全控制 compaction / permission / session 管理策略，而不需要 fork 整个 SoulPlus。

**相关章节**：§5.1.9（Soul 的可嵌入性举例）

**参考 plan**：`subagent-plans/plan/arch-roi-D-embedding.md` 问题 2.3

### ADR-X.113 SessionMeta 真相源化（决策 #113 详细论证）

**Context**：

v2 文档定稿时的 sessionMeta 设计有 5 个具体缺口：

1. §4.4 把 state.json 定义为 wire.jsonl 的衍生品，但 `title` / `tags` 等用户可改字段没有对应的 wire record，违反"wire 是唯一持久化真相源"原则
2. §3.5 line 281 的 `session.rename` wire 方法已声明，但**未设计**写入路径——改名后重启即丢
3. state.json 的派生字段（`last_model` / `turn_count` / `last_updated`）无明确 owner 与写入触发，存在多写者并发风险
4. SoulPlus 内部组件（shell hook / telemetry / NotificationManager）需要读 title 但无 API
5. state.json 与 wire.jsonl 不一致时的恢复策略未定义（决策 #75 引入了 `last_exit_code` 标记，但没规定后续恢复动作）

**Decision**：

1. 新增 `services.sessionMeta: SessionMetaService` 组件（services facade 阶段 5 装配，依赖 sessionJournal + eventBus + paths），作为 sessionMeta 的**统一内存视图与写入收口**
2. 新增 wire record `session_meta_changed { patch, source, reason? }`，按"消费方分群"的合并风格——区别于现有 5 个 ContextState config record 的独立风格（D2 / 详见 ADR-X.113 *Why not* 节）
3. 新增 wire 事件 `session_meta.changed`（patch + source），UI 实时可感知 wire-truth 字段变更；derived 字段更新**不**触发本事件（避免与 model.changed / turn.end 重复推送的噪音）
4. 三类字段分治（D1）：wire-truth（落 wire）/ derived（订阅 EventBus 聚合）/ runtime-only（仅 state.json）
5. 启动恢复折中策略（D7，与决策 #75 协同）：clean exit 信任 state.json（快路径），dirty exit / state.json 损坏时 replay wire.jsonl 修正——复用 §9.7 step 2 的 wire scan，无额外 I/O
6. subagent 冒泡（D9-1）：子 SoulPlus 也实例化 SessionMetaService，把 `session_meta_changed` 落到 `subagents/<sub_id>/wire.jsonl`；冒泡到主 EventBus 由 SoulRegistry wrapper 注入 `source: { kind: "subagent", id, name }`，与既有 §6.5 / §3.6.1 subagent 事件冒泡机制一致
7. 同步事务路径（D9-2）：`session.rename` / `session.setTags` / `session.getMeta` 在 TransactionalHandlerRegistry 注册，与 `setModel` 同路径——turn 跑到一半时 rename 不阻塞、不排队、不影响 Soul（title 不影响 LLM 行为，无需协调 ContextState / Soul step loop）
8. state.json 写入收口：除 `last_exit_code` 由 SessionLifecycle 在 shutdown 时直接覆写以外，其余字段全部由 SessionMetaService 通过 200ms debounced flush 合并写入，无并发写者

**Why not 合并入 ContextState config records**（D10）：

考虑过把 sessionMeta 字段合并到现有 `model_changed` 等 ContextState config 体系（统一为一种"config patch"），最终拒绝。4 个理由：

1. **写入路径异质**：`model_changed` 必须经 ContextState.applyConfigChange，被 ConversationProjector 投影时影响 LLM 输入；title 不进 ContextState，不影响 Projector 输出
2. **schema 异质 + 信息丢失**：`model_changed` 带 `old_model` 用于审计与 compaction 摘要；title 不需要 old_value；强行合并会损失语义
3. **重构成本高，收益低**：要动 Projector / Soul step loop / KosongAdapter / TransactionalHandler.setModel 等 6+ component，而现有 5 个 config record 已 stable
4. **last_model 在 SessionMeta 是 derived view**：source 各自独立，view 在 SessionMetaService 聚合 —— 这是清晰的事件聚合模式，比合并 schema 更符合关注点分离

**Why not 沿用风格 A（每字段独立 record）**（D2 详化）：

| 维度 | sessionMeta 字段（title / tags / description / archived） | 现有 config 字段（model / system_prompt / thinking / plan_mode / tools） |
|---|---|---|
| 写入路径 | SessionMetaService → SessionJournal | ContextState.applyConfigChange → JournalWriter |
| 是否进 LLM | 不进 | 进（影响 Projector 输出或 LLM 调用参数） |
| Consumer | UI + state.json（单一） | Projector / Soul step loop / Kosong / UI（异质） |
| Schema 形状 | 同质（基本是 string / string[] / boolean） | 异质（带 old_value / operation 等） |
| 未来扩展 | 高频加字段（description / archived / color / project_id...） | 稳定（现有 5 个已 stable） |

→ 同质 + 单一 consumer + 高频扩展 → **合并**单一 patch record；异质 + 多 consumer + 已 stable → **保持独立**。

**Consequences**：

- `session.rename` 崩溃可恢复（落 wire 真相源，replay 可重建）
- UI 实时感知元数据变化（不再需要轮询 `session.list`）
- state.json 派生字段单一写者，消除多写者并发风险
- 内部消费者（shell hook / telemetry / NotificationManager）通过 `subscribe()` API 读 sessionMeta
- 不破坏现有 6 facade DAG（services facade 仅新增 1 个字段，单向依赖 journal + eventBus + paths）
- 不动现有 5 个 ContextState config record（model_changed / system_prompt_changed / thinking_changed / plan_mode_changed / tools_changed）
- 不动 ContextState / Projector / Soul / TurnManager / Runtime 任何代码
- 子 SoulPlus 也需实例化 SessionMetaService（构造期 + 内存开销，~100 字节量级，可接受）
- 启动恢复增加一个子阶段（dirty 路径下增加一次 wire scan，与现有 §9.7 step 2 的 ContextState replay 合并执行，无额外 I/O）

**相关章节**：§3.5（wire methods）/ §3.6（wire events）/ §4.4（state.json 职责）/ §6.1（services facade）/ §6.13.7（SessionMetaService 完整设计）/ §9.7（启动恢复 step 7）/ 附录 B（session_meta_changed schema）/ 附录 D.5（SessionMetaChangedEvent）

**参考 plan**：`subagent-plans/plan/p1-session-meta-service.md`

---

## 附录 F：已废弃设计与已撤销决策

本附录集中收录所有在 v2 演进过程中被撤销或废弃的设计元素，供读者追溯决策历史。决策记录表（§二十一）里对应条目只保留占位 stub 指向这里，以保持速查表简洁。

### F.1 决策 #61：7 层权限检查链（已撤销，被 #79 / #80 / #81 取代）

- **原决策**：7 层权限检查链 — `deny > ask > tool.selfCheck > mode bypass > dynamic rules > allow > default ask`
- **原理由**：参考 cc 的分层优先级
- **撤销原因**：本轮重写彻底删除 7 层检查链，改为 SoulPlus 内部单一入口 `beforeToolCall` + 纯函数 `checkRules`（`deny > ask > allow > default`）
- **替代方案**：见决策 #79（方案 Z）、#80（Tool 接口极简化）、#81（单一 approval gate）
- **来源**：v2 新增 → 第二轮废弃

### F.2 决策 #65：ContextState 持有 WireStore（已撤销，被 #68 取代）

- **原决策**：ContextState 持有 WireStore 引用；写入方法同时更新内存+写盘；测试用 InMemoryContextState
- **原理由**：Soul 不知道 I/O 实现（依赖接口不依赖具体类）；write-ahead 语义由 ContextState 保证
- **撤销原因**：WireStore 抽象被 JournalWriter 取代，ContextState 改为持有 JournalWriter 引用
- **替代方案**：决策 #68（JournalWriter 单一写入入口）
- **保留的命名**：`InMemoryContextState` / `InMemorySessionJournal` 这两个名字作为"测试双"命名保留（见 §4.5.2 / §4.6），但决策本身作废——命名沿用不代表设计回潮
- **来源**：v2 新增 → 已被 #68 取代

### F.3 决策 #77：PermissionChecker per-Soul 隔离（已撤销，被 #78 / #83 取代）

- **原决策**：每个 Soul 实例有自己的 PermissionChecker；static rules 共享只读，dynamic rules per-Soul
- **原理由**：防止并发 Soul 之间的权限污染
- **撤销原因**：Soul 变纯函数（决策 #78）后，不存在"每个 Soul 实例的状态"。per-turn 隔离由"每次 runSoulTurn 拿到独立 `beforeToolCall` 闭包"天然保证——闭包本身即值，无共享状态
- **替代方案**：决策 #78（Soul/SoulPlus 边界）、决策 #83（TurnOverrides 一分为二 + baked 进闭包）
- **来源**：v2 新增 → 第二轮废弃

### F.4 §11.10 已删除的 Permission / Approval 旧设计清单

本节明确列出本轮重写（Phase 6 系列）相对 v2 初稿从旧 §11 / §12 / §6.12 / §4.5 删除的设计元素，避免读者在 v1 / v2 初稿 / 当前版本之间混淆。未出现在此列表中的设计要点视为保留。

- **"Soul 内的 7 层权限检查链"** —— 整段删除。现在只有 `beforeToolCall` 一个入口，规则匹配逻辑退化为一个纯函数 `checkRules`，住在 SoulPlus 内部
- **`Tool.checkPermissions` / `Tool.selfCheck` / `Tool.validateInput` 字段** —— Phase 2 §10 已经从 Tool 接口中删除；不再残留任何"tool 自检"的说法
- **`Runtime.permissionChecker` 字段** —— Phase 2 §6.12 已经明确 Runtime 不含这个字段；不再在 Soul runtime 里注入 PermissionChecker 实例
- **`SoulRegistry.createSoul` 里 per-Soul 注入 PermissionChecker 的代码块** —— 作废。现在 per-turn 隔离由"每次 runSoulTurn 拿到独立闭包"天然保证
- **旧 `ApprovalRuntime` 的 2 方法接口**（旧版只有 `waitForApproval` / `resolveApproval` 两个方法，参见 v2 初稿的 §11）—— 被 §12.2 的完整接口（`request` / `resolve` / `cancelBySource` / `recoverPendingOnStartup`）替代；`cancelBySource` 与 `recoverPendingOnStartup` 是对齐 D17 abort propagation contract 和 D5 被动 journal repair 新增的

**保留的硬核部分**：规则存储格式（PermissionRule schema、字符串 DSL）、加载合并（4+1 层来源）、匹配决策逻辑（`deny > ask > allow > default`）、PermissionMode（3 种模式）。这些是 permission 系统的硬核部分，未被撤销。

### F.5 决策 #82 的子设计撤销：Notification / Reminder 的 turn-scope 缓冲路径（被 #89 取代）

决策 #82 的整体设计（ContextState 一分为二：`SoulContextState` / `FullContextState`）**仍然有效**，但其中一个**子设计**已在 Phase 6E 被撤销——详见决策 #89。

- **被撤销的子设计**：`notification` / `system_reminder` 归 SessionJournal + `TurnManager.pendingNotifications` turn-scope 缓冲 + `ConversationProjector.ephemeralInjections` 读侧一次性注入
- **撤销原因**：让 notification 只在当前 turn 的一次性注入里存在，Turn N+1 就看不到了。会造成 assistant "我基于 Task X 的结果..."（来自 Turn N）在 Turn N+1 的上下文里完全找不到任何关于 Task X 的事实，触发幻觉或"Task X 是什么？"的追问——违反"上下文是 append-only 的事实记录"原则
- **替代方案**（决策 #89）：notification / system reminder / memory recall 改为通过 `FullContextState.appendNotification` / `appendSystemReminder` / `appendMemoryRecall` 做 durable 写入，作为对话事件进 transcript；Projector 每次从 snapshot 重新组装它们为 LLM message
- **影响**：TurnManager 删除 `pendingNotifications`；NotificationManager 直接写 ContextState；SessionJournal 去掉 `appendNotification`；`ConversationProjector.project` 签名从 `project(snapshot, ephemeralInjections, options)` 简化为 `project(snapshot, options?)`

### F.6 Phase 1 实现时 TBD（To-Be-Determined）项

本节集中收录 v2 文档定型后、Phase 1 实施过程中**仍需现场决策**的项。已在 batch1/2/3（A1~A6 + B1~B7）修复的接口形态 / 命名 / 章节引用不重复列出；本节只列**真正待定**的实现细节、参数选型、和延后到 Phase 2/3 的具体设计点。

| # | 项 | 待定内容 | 依赖决策 / 章节 |
|---|---|---|---|
| 1 | §17A 编号"十七A"长期方案 | "十七A"是临时编号方案（避免破坏 §十八 起的历史编号）。Phase 2/3 是否改为正式编号（例如把 MCP 章节并入 §十六 Plugin 章节，或重新编号）由文档 owner 决定 | §0 / §17A |
| 2 | EditTool diff 算法 Phase 2 切换决策 | Phase 1 用 `diff` npm package（unified diff）。Phase 2 是否切换到 `diff-match-patch`（更精细但更重）取决于实际需求 | §10.7.6 |
| 3 | mcp.* 事件 zod schema 完整字段（Phase 3） | Phase 1 zod schema 已落地（附录 A.x），但 `capabilities` 完整 enum、`auth_url` PKCE state、`tool_count` 拆分、`last_error.code` 标准化等待 Phase 3 `RealMcpRegistry` 实现时补 | 附录 A.x / §17A |
| 4 | `isConcurrencySafe` Phase 2 启用时机 | Phase 1 接口槽位已留（§10.2）。Phase 2 ToolCallOrchestrator 启用受控并发的具体里程碑 / 性能 baseline 待定 | §10.2 / §11.7.1 |
| 5 | McpRegistry / NoopMcpRegistry 的具体实现 | Phase 1 仅占位类骨架。Phase 3 实现 `StdioMcpTransport` / `HttpMcpTransport` / `RealMcpRegistry` 的具体技术选型（基于 `@modelcontextprotocol/sdk` Client 包装 vs 自实现 JSON-RPC framing）待 Phase 3 启动时定 | §17A.2 / §17A.9 |
| 6 | KosongAdapter 401/connection retry 具体策略参数 | 决策 #94 已定原则（OAuth 刷新 + 指数退避）；具体参数（指数退避基数、最大重试次数、jitter 范围、429 vs 5xx 不同曲线）Phase 1 实现时按生产 baseline 调 | §6.13 / 决策 #94 |
| 7 | Tool Result Budget 持久化文件路径具体格式 | 决策 #96 已定 50K/100K 阈值 + `<persisted-output>` preview；具体文件命名规则（`<sessionId>/<turnId>/<toolCallId>_<index>.txt` vs `<sessionId>/<contentHash>.txt`）+ 跨 session 共享去重 / 清理策略 Phase 1 实现时定 | §10.6 / `PathConfig.toolResultArchiveDir` |
| 8 | SkillInlineWriter 的 export/import 过滤具体实现 | 决策 #99 已定 `appendUserMessageMeta(isMeta=true)` + `<kimi-skill-loaded>` tag；`/export` filter / `/import` 反向加载 / replay 过滤的代码层接入点（在 SessionExporter？ConversationProjector？JournalReplayer？）Phase 1 实现时定 | §15.10.4 / §15.11 |
| 9 | ToolInputDisplay / ToolResultDisplay 在 client 端的渲染映射表 | 决策 #98 定的是 wire schema 字段；client（TUI / Web）每个 kind 具体怎么渲染（react component map / TUI 字符艺术等）由 client 团队 Phase 1 自行决定，不在 core 文档约束 | §10.7.3 / §10.7.5 |
| 10 | Plugin 注入 MCP 的具体接口（Phase 3） | 决策 #100 / §17A.7.2 给了 plugin `mcp.json` 加载 stub；Phase 3 实施时 `loadMcpJson` 是否完全复用 `McpConfigLoader.load`、是否需要 plugin lifecycle hook（卸载 plugin 时清 mcp server）等 Phase 3 定 | §16 / §17A.7.2 |
| 11 | ApprovalDisplay 收编后 Phase 2 是否需要 approval 专属 kind | 决策 #98 已收编 `ApprovalDisplay = ToolInputDisplay alias`；Phase 2 如果遇到 approval 专属 UI 需求（如 "diff 旁边强制显示 risk badge"），是否扩 `ToolInputDisplay` 加新 kind vs 引入 approval-only display 子集——Phase 2 评估 | §10.7.7 / §12.2 |
| 12 | JournalWriter 异步 drain 的 backpressure 策略 | 决策 #95 已定 50ms drain；如果生产环境 burst 写入超过 disk 吞吐（`pendingRecords` 长期堆积），是否引入 backpressure（暂停 `append` 等待 drain）vs 触发 `session.error(error_type: "internal")` Phase 1 实现时定 | §4.5.4 / 决策 #95 |
| 13 | Overflow Recovery 熔断后的用户引导 | 决策 #96 定 `MAX_COMPACTIONS_PER_TURN = 3` 后 emit `session.error(error_type: "context_overflow")`；UI 是否给用户提供"手动 /clear" / "导出当前 transcript" 等动作按钮，需求 + 时机 Phase 1 联调时定 | §3.5 / §6.4 |

> **不列入本表的项**：A1~A6 + B1~B7 在本次清理中已修复（接口形态 / 章节引用 / 命名 / 章节插入位置等）。本表只关注真正待定的实现选型 + 参数。

---

## 结语

v2 的核心思想是：**把 Soul 解放出来，让它变成纯状态机；把所有状态、持久化、管理 API 都收到 SoulPlus 这层壳里；让 `wire.jsonl` 成为 session 对话状态与会话审计记录的唯一持久化真相源；用 SQLite 消息总线支撑多进程 agent team 通信**。

这个架构能优雅支撑：
- 单 session 的对话（最基础场景）
- 多 session 并发（SDK / Hive 的需求）
- subagent（Task tool 起的后台任务，同进程 Soul）
- **agent team**（多进程 SoulPlus + SQLite 消息总线 + auto-wake）
- 断线重连（wire.jsonl event replay）
- 运行时配置切换（setModel / setSystemPrompt）
- 同进程库模式和跨进程 socket 模式的无缝切换
- **多端 UI 友好**（TUI / Web / VSC 插件，结构化事件 + 有始有终原则）

且每个能力都不会让其它能力变复杂——因为拆分是按"**变化的原因**"做的，而不是按"**功能域**"做的。

### 调研数据来源

本文档的设计决策基于以下代码级调研（通过 agent team 并行调研获得）：

| 系统 | 调研覆盖面 | 关键文件 |
|------|----------|---------|
| **cc-remake** | Agent team 架构、邮箱系统、进程启动、approval 冒泡、resume 机制、UI 渲染、错误处理 | `AgentTool.tsx`, `inProcessRunner.ts`, `teammateMailbox.ts`, `teamHelpers.ts`, `withRetry.ts`, `agentColorManager.ts` |
| **kimi-cli** (Python) | Notification 定义、Wire 类型系统、subagent 实现、RootWireHub、background task、approval runtime | `wire/types.py`, `wire/serde.py`, `notifications/models.py`, `subagents/runner.py`, `background/manager.py` |
| **pi-mono** | 事件系统、扩展机制、session 管理 | `coding-agent/src/core/extensions/types.ts`, `agent/src/agent-loop.ts` |
