# AI CLI Hooks 系统设计方案调研报告

> **调研时间**: 2026-02-13
> **调研范围**: Claude Code、Gemini CLI、OpenAI Codex
> **报告目的**: 为 Kimi CLI 生命周期钩子系统（EPIC-0001）提供设计参考

---

## 执行摘要

通过对三个主流 AI CLI 工具的 hooks 系统调研发现：

| 工具 | Hooks 支持 | 成熟度 | 核心设计哲学 |
|------|-----------|--------|-------------|
| **Claude Code** | ✅ 完整 | 生产级 | 命令优先 + Prompt/Agent 扩展 |
| **Gemini CLI** | ✅ 完整 | 生产级 | 分层事件 + 严格 JSON 协议 |
| **OpenAI Codex** | ❌ 暂无 | - | 依赖沙箱权限系统替代 |

**关键洞察**: Claude Code 和 Gemini CLI 都采用了「Command Hooks」作为基础设计，但在事件粒度、配置方式、控制流机制上有显著差异。

---

## 1. Claude Code Hooks 系统

### 1.1 核心设计

Claude Code 的 hooks 系统采用**三层嵌套结构**:

```json
{
  "hooks": {
    "PreToolUse": [           // 1. 事件类型
      {
        "matcher": "Bash",    // 2. 匹配器
        "hooks": [            // 3. 处理器列表
          {
            "type": "command",
            "command": "./security-check.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 1.2 事件类型（14种）

| 事件 | 触发时机 | 可阻塞 | 典型用途 |
|------|---------|--------|---------|
| `SessionStart` | 会话开始/恢复 | ❌ | 注入项目上下文、环境初始化 |
| `SessionEnd` | 会话结束 | ❌ | 清理、生成报告 |
| `UserPromptSubmit` | 用户提交 Prompt 前 | ✅ | Prompt 过滤、验证 |
| `PreToolUse` | 工具执行前 | ✅ | 权限检查、危险命令拦截 |
| `PermissionRequest` | 权限对话框显示时 | ✅ | 自动批准/拒绝策略 |
| `PostToolUse` | 工具成功执行后 | ❌ | 日志记录、格式化 |
| `PostToolUseFailure` | 工具执行失败后 | ❌ | 错误处理、告警 |
| `Notification` | 系统通知时 | ❌ | 桌面通知转发 |
| `SubagentStart` | 子代理启动时 | ❌ | 子代理监控 |
| `SubagentStop` | 子代理结束时 | ✅ | 结果验证 |
| `Stop` | Claude 完成响应时 | ✅ | 任务完成检查 |
| `TeammateIdle` | 队友代理空闲时 | ✅ | 继续工作触发 |
| `TaskCompleted` | 任务标记完成时 | ✅ | 质量门禁 |
| `PreCompact` | 上下文压缩前 | ❌ | 状态保存 |

### 1.3 Hook 类型

Claude Code 支持 **3 种** hook 类型：

| 类型 | 用途 | 超时默认 | 特点 |
|------|------|---------|------|
| `command` | 执行 shell 命令 | 600s | 通过 stdin/stdout 通信 |
| `prompt` | LLM 单轮判断 | 30s | 返回 `{"ok": true/false, "reason": ""}` |
| `agent` | 子代理多轮验证 | 60s | 可使用工具进行复杂验证 |

### 1.4 控制流机制

**Exit Code 语义**:
- `0`: 成功，解析 stdout JSON
- `2`: 阻塞错误，stderr 反馈给 Claude
- 其他: 非阻塞错误，仅日志记录

**决策控制模式**（按事件区分）:
```json
// PreToolUse: 使用 hookSpecificOutput
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "...",
    "updatedInput": { /* 修改后的参数 */ }
  }
}

// UserPromptSubmit/PostToolUse/Stop: 使用顶层 decision
{
  "decision": "block",
  "reason": "..."
}
```

### 1.5 配置层级

| 位置 | 作用域 | 可提交到仓库 |
|------|--------|-------------|
| `~/.claude/settings.json` | 全局 | ❌ |
| `.claude/settings.json` | 项目级 | ✅ |
| `.claude/settings.local.json` | 项目级（本地） | ❌ |
| Managed policy | 组织级 | ✅ |
| Plugin `hooks/hooks.json` | 插件启用时 | ✅ |
| Skill/Agent frontmatter | 组件生命周期内 | ✅ |

### 1.6 特色功能

- **`CLAUDE_ENV_FILE`**: SessionStart 钩子可写入环境变量，影响后续所有 Bash 命令
- **`/hooks` 交互菜单**: 内置命令管理钩子，无需手动编辑 JSON
- **MCP 工具匹配**: 支持 `mcp__<server>__<tool>` 模式匹配
- **异步钩子**: `async: true` 可在后台运行不阻塞主流程

---

## 2. Gemini CLI Hooks 系统

### 2.1 核心设计

Gemini CLI 采用**更细粒度的事件模型**，强调严格的 JSON 通信协议：

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "write_file|replace",
        "sequential": false,
        "hooks": [
          {
            "name": "security-check",
            "type": "command",
            "command": "$GEMINI_PROJECT_DIR/.gemini/hooks/security.sh",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

### 2.2 事件类型（10种）

Gemini CLI 的事件命名遵循 **Before/After** 模式，更强调 Agent 循环的各个阶段：

| 事件 | 触发时机 | 影响能力 | 常见用例 |
|------|---------|---------|---------|
| `SessionStart` | 会话开始 | 注入上下文 | 初始化资源 |
| `SessionEnd` | 会话结束 | Advisory | 清理、保存状态 |
| `BeforeAgent` | 用户提交后、规划前 | 阻塞/上下文 | Prompt 验证 |
| `AfterAgent` | Agent 循环结束 | 重试/停止 | 输出审查 |
| `BeforeModel` | 发送 LLM 请求前 | 阻塞/Mock | 修改 Prompt、切换模型 |
| `AfterModel` | 接收响应后 | 阻塞/编辑 | 过滤响应、PII 检测 |
| `BeforeToolSelection` | LLM 选择工具前 | 过滤工具 | 工具白名单 |
| `BeforeTool` | 工具执行前 | 阻塞/重写 | 参数验证 |
| `AfterTool` | 工具执行后 | 阻塞结果/上下文 | 结果处理 |
| `PreCompress` | 上下文压缩前 | Advisory | 状态保存 |
| `Notification` | 系统通知 | Advisory | 桌面提醒 |

### 2.3 关键差异：BeforeModel/AfterModel

Gemini CLI 独有的**模型层钩子**，可直接操作 LLM 请求/响应：

```typescript
// BeforeModel 可修改或模拟 LLM 请求
{
  "hookSpecificOutput": {
    "llm_request": { /* 覆盖请求 */ },
    "llm_response": { /* 模拟响应，跳过 LLM 调用 */ }
  }
}

// AfterModel 在流式传输的每个 chunk 触发
{
  "hookSpecificOutput": {
    "llm_response": { /* 修改当前 chunk */ }
  }
}
```

### 2.4 严格的 JSON 协议

**黄金规则**: stdout 必须**仅**包含最终 JSON，任何日志必须写入 stderr。

```bash
#!/bin/bash
input=$(cat)

# ✅ 正确：日志写入 stderr
echo "Debug info" >&2

# ✅ 正确：stdout 只有 JSON
echo '{"decision": "allow"}'
```

### 2.5 Exit Code 语义

| Exit Code | 含义 | 行为 |
|-----------|------|------|
| `0` | Success | 解析 stdout 为 JSON |
| `2` | System Block | 阻塞动作，stderr 作为拒绝原因 |
| 其他 | Warning | 非致命失败，继续执行 |

### 2.6 BeforeToolSelection 的联合策略

多个 hooks 的白名单采用**并集**策略：
```javascript
// 如果多个 hooks 返回 allowedFunctionNames
// 最终可用工具 = 所有白名单的并集
// 只有 mode: "NONE" 会覆盖其他 hooks
```

### 2.7 配置层级

| 位置 | 优先级 | 说明 |
|------|-------|------|
| `.gemini/settings.json` | 最高 | 项目级 |
| `~/.gemini/settings.json` | 中 | 用户级 |
| `/etc/gemini-cli/settings.json` | 低 | 系统级 |
| Extensions | 最低 | 扩展提供 |

### 2.8 安全特性

- **指纹识别**: 项目级 hooks 变更时（如 git pull），视为新的未信任 hook，执行前警告用户
- **环境隔离**: 执行时环境被清理，仅保留 `GEMINI_*` 变量

---

## 3. OpenAI Codex

### 3.1 现状

**Codex 目前没有实现 hooks 系统**。其功能由以下机制替代：

| 需求 | Codex 替代方案 |
|------|---------------|
| 危险命令拦截 | 沙箱权限系统（seatbelt / Docker） |
| 自动格式化 | 无原生支持，依赖 Codex 自主决定 |
| 上下文注入 | `AGENTS.md` 文件 |
| 环境初始化 | `.env` 文件加载 |

### 3.2 配置系统

Codex 使用传统的静态配置：

```yaml
# ~/.codex/config.yaml
model: o4-mini
approvalMode: suggest
fullAutoErrorMode: ask-user
providers:
  openai:
    baseURL: https://api.openai.com/v1
    envKey: OPENAI_API_KEY
```

### 3.3 扩展机制

Codex 计划通过 **MCP (Model Context Protocol)** 实现扩展，而非 hooks。

---

## 4. 设计方案对比分析

### 4.1 事件模型对比

```
Claude Code:                    Gemini CLI:
┌─────────────────┐            ┌─────────────────┐
│  SessionStart   │            │  SessionStart   │
└────────┬────────┘            └────────┬────────┘
         ▼                              ▼
┌─────────────────┐            ┌─────────────────┐
│UserPromptSubmit │            │  BeforeAgent    │
└────────┬────────┘            └────────┬────────┘
         ▼                              ▼
┌─────────────────┐            ┌─────────────────┐
│   PreToolUse    │◄──────────►│  BeforeModel    │
└────────┬────────┘            └────────┬────────┘
         │                    ┌─────────┴─────────┐
         │                    ▼                   ▼
         │           ┌─────────────┐    ┌─────────────────┐
         │           │BeforeToolSel│    │   BeforeTool    │
         │           └──────┬──────┘    └────────┬────────┘
         │                  │                    │
         ▼                  ▼                    ▼
    [Tool Exec]        [Tool Exec]          [Tool Exec]
         │                  │                    │
         ▼                  ▼                    ▼
┌─────────────────┐   ┌─────────────┐    ┌─────────────────┐
│  PostToolUse    │◄──┤  AfterModel │    │   AfterTool     │
└─────────────────┘   └──────┬──────┘    └────────┬────────┘
                             │                    │
                             ▼                    ▼
                      ┌─────────────────┐  ┌─────────────────┐
                      │  AfterAgent     │  │   SessionEnd    │
                      └─────────────────┘  └─────────────────┘
```

### 4.2 设计哲学对比

| 维度 | Claude Code | Gemini CLI |
|------|-------------|------------|
| **核心抽象** | 命令脚本为主 | 事件流为主 |
| **通信协议** | stdin/stdout JSON + Exit Code | 严格 JSON stdout |
| **配置格式** | JSON | JSON |
| **事件粒度** | 较粗（聚焦工具和用户交互） | 较细（包含模型层） |
| **控制流** | 按事件类型区分决策格式 | 统一 decision 字段 |
| **Hook 类型** | command/prompt/agent | 仅 command（目前） |
| **异步支持** | ✅ async 字段 | ❌ 同步执行 |
| **环境变量** | ✅ CLAUDE_ENV_FILE | ❌ 清理环境 |

### 4.3 优缺点分析

**Claude Code 优势**:
- 3 种 hook 类型（command/prompt/agent）覆盖不同复杂度需求
- `CLAUDE_ENV_FILE` 机制实现环境持久化
- `/hooks` 交互菜单降低使用门槛
- 丰富的决策控制选项（allow/deny/ask）

**Claude Code 劣势**:
- 决策控制格式按事件类型不一致（增加了学习成本）
- 缺少模型层钩子（BeforeModel/AfterModel）

**Gemini CLI 优势**:
- 更完整的事件覆盖（模型层钩子）
- 严格的 JSON 协议减少调试困难
- 统一的 decision 字段设计
- 工具过滤的联合策略（并集）

**Gemini CLI 劣势**:
- 仅支持 command 类型 hooks
- 缺少 prompt/agent 类型用于复杂决策
- 环境变量隔离，无法实现持久化

---

## 5. 对 Kimi CLI Hooks 系统的建议

基于以上调研，为 Kimi CLI（EPIC-0001）提出以下设计建议：

### 5.1 推荐的事件集合

融合两者的优点，建议实现以下事件：

**Session 层**:
- `SessionStart` - 会话启动
- `SessionEnd` - 会话结束

**Agent 层**:
- `BeforeAgent` / `UserPromptSubmit` - 用户输入处理前
- `AfterAgent` / `Stop` - Agent 响应完成后

**模型层**（可选，高级功能）:
- `BeforeModel` - 发送 LLM 请求前
- `AfterModel` - 接收 LLM 响应后

**工具层**:
- `BeforeToolUse` / `PreToolUse` - 工具执行前（可阻塞/修改）
- `AfterToolUse` / `PostToolUse` - 工具执行后
- `PostToolUseFailure` - 工具执行失败

**其他**:
- `PreCompact` - 上下文压缩前
- `Notification` - 系统通知

### 5.2 推荐的 Hook 类型

建议支持 **3 种** 类型，与 Claude Code 一致：

| 类型 | 用途 | 默认超时 | 实现优先级 |
|------|------|---------|-----------|
| `Command` | Shell 脚本 | 30s | P0 |
| `Prompt` | LLM 单轮判断 | 10s | P1 |
| `Agent` | 子代理验证 | 60s | P2 |

### 5.3 推荐的配置格式

采用 TOML（与 Kimi CLI 现有配置一致）：

```toml
[[hooks.pre_tool_use]]
event = "PreToolUse"
type = "Command"
matcher = { tool = "Shell", pattern = "rm -rf.*" }
command = "./security-check.sh"
timeout = 5000

[[hooks.session_start]]
event = "SessionStart"
type = "Command"
command = "echo '{\"role\": \"system\", \"content\": \"Project: $(basename $PWD)\"}'"
```

### 5.4 推荐的控制流设计

**Exit Code**:
- `0`: 成功，解析 stdout JSON
- `2`: 阻塞，stderr 作为反馈
- 其他: 非阻塞警告

**决策格式**（统一设计，简化学习成本）：
```json
{
  "decision": "allow|deny|ask",
  "reason": "...",
  "modified_arguments": { /* 修改后的参数 */ },
  "additional_context": "..."
}
```

### 5.5 推荐的环境机制

- **环境变量**: `KIMI_ENV_FILE` 支持 SessionStart 设置持久化环境变量
- **项目目录**: `KIMI_PROJECT_DIR` 供 hooks 引用项目根目录
- **会话信息**: `KIMI_SESSION_ID`, `KIMI_CWD`

### 5.6 性能考虑

| 场景 | 目标延迟 | 策略 |
|------|---------|------|
| 无匹配 hooks | < 1ms | Matcher 快速筛选 |
| 匹配但未触发 | < 2ms | 正则缓存 |
| 正常执行 | < 10ms | 并行执行 |
| 超时 | 100ms | 强制放弃 |

---

## 6. 参考资源

### Claude Code
- [Hooks Reference](https://code.claude.com/docs/hooks)
- [Hooks Guide](https://code.claude.com/docs/hooks-guide)
- [示例代码](https://github.com/anthropics/claude-code/blob/main/examples/hooks/)

### Gemini CLI
- [Hooks Docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/)
- [Reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)
- [Writing Hooks](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md)

### OpenAI Codex
- [README](https://github.com/openai/codex/blob/main/codex-cli/README.md)
- 暂无 hooks 文档

---

## 7. 结论

Claude Code 和 Gemini CLI 的 hooks 系统都达到了生产级成熟度，但设计理念有所不同：

- **Claude Code** 更注重**易用性**和**灵活性**，提供多种 hook 类型和丰富的控制选项
- **Gemini CLI** 更注重**严格性**和**细粒度控制**，提供模型层钩子和严格的协议

对于 Kimi CLI，建议：
1. **Phase 1**: 实现 Command 类型 hooks + 核心事件（SessionStart/End, Pre/PostToolUse）
2. **Phase 2**: 增加 Prompt 类型 hooks + UserPromptSubmit 事件
3. **Phase 3**: 增加 Agent 类型 hooks + 高级事件（BeforeModel 等）

---

*报告结束*
