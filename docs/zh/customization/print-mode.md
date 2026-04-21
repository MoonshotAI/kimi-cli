# Print 模式

Print 模式让 Kimi Code CLI 以非交互方式运行，适合脚本调用和自动化场景。

## 基本用法

使用 `--print` 参数启用 Print 模式：

```sh
# 通过 -p 传入指令（或 -c）
kimi --print -p "列出当前目录的所有 Python 文件"

# 通过 stdin 传入指令
echo "解释这段代码的作用" | kimi --print
```

Print 模式的特点：

- **非交互**：执行完指令后自动退出
- **自动审批**：隐式启用 `--yolo` 模式，所有操作自动批准，交互式问答（`AskUserQuestion`）和计划模式切换也会自动处理
- **文本输出**：AI 的回复输出到 stdout
- **后台任务等待**：单次 `--print` 模式下，如果后台任务仍在运行，进程会等待它们完成并让模型处理结果，而不是直接退出并杀死任务。等待时长上限为当前活跃任务中剩余预算最长的那个，被 `print_wait_ceiling_s` 配置项封顶（默认 1 小时）。超时后任务会被终止，模型会收到一条总结提示后再退出。详见 [配置文件](../configuration/config-files.md#background)

<!-- TODO: 支持同时从 stdin 读取内容和 -p 读取指令后启用此示例
**管道组合示例**

```sh
# 分析 git diff 并生成提交信息
git diff --staged | kimi --print -p "根据这个 diff 生成一个符合 Conventional Commits 规范的提交信息"

# 读取文件并生成文档
cat src/api.py | kimi --print -p "为这个 Python 模块生成 API 文档"
```
-->

## 仅输出最终消息

使用 `--final-message-only` 选项可以只输出最终的 assistant 消息，跳过中间的工具调用过程：

```sh
kimi --print -p "根据当前变更给我一个 Git commit message" --final-message-only
```

`--quiet` 是 `--print --output-format text --final-message-only` 的快捷方式，适合只需要最终结果的场景：

```sh
kimi --quiet -p "根据当前变更给我一个 Git commit message"
```

## JSON 格式

Print 模式支持 JSON 格式的输入和输出，方便程序化处理。输入和输出都使用 [Message](#message-格式) 格式。

**JSON 输出**

使用 `--output-format=stream-json` 以 JSONL（每行一个 JSON）格式输出：

```sh
kimi --print -p "你好" --output-format=stream-json
```

输出示例：

```jsonl
{"role":"assistant","content":"你好！有什么可以帮助你的吗？"}
```

如果 AI 调用了工具，会依次输出 assistant 消息和 tool 消息：

```jsonl
{"role":"assistant","content":"让我查看一下当前目录。","tool_calls":[{"type":"function","id":"tc_1","function":{"name":"Shell","arguments":"{\"command\":\"ls\"}"}}]}
{"role":"tool","tool_call_id":"tc_1","content":"file1.py\nfile2.py"}
{"role":"assistant","content":"当前目录有两个 Python 文件。"}
```

**JSON 输入**

使用 `--input-format=stream-json` 接收 JSONL 格式的输入：

```sh
echo '{"role":"user","content":"你好"}' | kimi --print --input-format=stream-json --output-format=stream-json
```

这种模式下，Kimi Code CLI 会持续读取 stdin，每收到一条用户消息就处理并输出响应，直到 stdin 关闭。

## Message 格式

输入和输出都使用统一的 Message 格式。

**User 消息**

```json
{"role": "user", "content": "你的问题或指令"}
```

也可以使用数组形式的 content：

```json
{"role": "user", "content": [{"type": "text", "text": "你的问题"}]}
```

**Assistant 消息**

```json
{"role": "assistant", "content": "回复内容"}
```

带工具调用的助手消息：

```json
{
  "role": "assistant",
  "content": "让我执行这个命令。",
  "tool_calls": [
    {
      "type": "function",
      "id": "tc_1",
      "function": {
        "name": "Shell",
        "arguments": "{\"command\":\"ls\"}"
      }
    }
  ]
}
```

**Tool 消息**

```json
{"role": "tool", "tool_call_id": "tc_1", "content": "工具执行结果"}
```

## 退出码

Print 模式使用退出码表示执行结果，方便脚本和 CI 系统判断是否需要重试：

| 退出码 | 含义 | 说明 |
| --- | --- | --- |
| `0` | 成功 | 任务正常完成 |
| `1` | 失败（不可重试） | 配置错误、认证失败、额度用尽等永久性错误 |
| `75` | 失败（可重试） | 429 速率限制、5xx 服务端错误、连接超时等暂时性错误 |

示例：根据退出码决定是否重试：

```sh
kimi --print -p "执行任务"
code=$?
if [ $code -eq 75 ]; then
  echo "遇到暂时性错误，稍后重试..."
  sleep 10
  kimi --print -p "执行任务"
elif [ $code -ne 0 ]; then
  echo "遇到不可恢复的错误，退出码: $code"
  exit $code
fi
```

## 使用场景

**CI/CD 集成**

在 CI 流程中自动生成代码或执行检查：

```sh
kimi --print -p "检查 src/ 目录下是否有明显的安全问题，输出 JSON 格式的报告"
```

**批量处理**

结合 shell 循环批量处理文件：

```sh
for file in src/*.py; do
  kimi --print -p "为 $file 添加类型注解"
done
```

**与其他工具集成**

作为其他工具的后端，通过 JSON 格式进行通信：

```sh
my-tool | kimi --print --input-format=stream-json --output-format=stream-json | process-output
```
