# Print 模式

Print 模式让 Kimi CLI 以非交互方式运行，适合脚本调用和自动化场景。

## 无交互运行

使用 `--print` 参数启用 Print 模式：

```sh
# 通过 --command 传入指令
kimi --print --command "列出当前目录的所有 Python 文件"

# 通过 stdin 传入指令
echo "解释这段代码的作用" | kimi --print
```

Print 模式的特点：

- **非交互**：执行完指令后自动退出，无需手动输入
- **自动审批**：隐式启用 `--yolo` 模式，所有操作自动批准
- **流式输出**：AI 的回复实时打印到 stdout

**管道组合示例**

```sh
# 分析 git diff 并生成提交信息
git diff --staged | kimi --print --command "根据这个 diff 生成一个符合 Conventional Commits 规范的提交信息"

# 读取文件并生成文档
cat src/api.py | kimi --print --command "为这个 Python 模块生成 API 文档"
```

## Stream JSON 格式

Print 模式支持 JSON 格式的输入和输出，方便程序化处理。

**JSON 输出**

使用 `--output-format=stream-json` 以 JSONL（每行一个 JSON）格式输出：

```sh
kimi --print --command "你好" --output-format=stream-json
```

输出示例：

```jsonl
{"type":"turn_begin","turn_id":"..."}
{"type":"text_delta","text":"你好"}
{"type":"text_delta","text":"！"}
{"type":"turn_end"}
```

**JSON 输入**

使用 `--input-format=stream-json` 接收 JSONL 格式的输入：

```sh
echo '{"type":"user_message","content":"你好"}' | kimi --print --input-format=stream-json --output-format=stream-json
```

这种模式下，Kimi CLI 会持续读取 stdin，每收到一条 JSON 消息就处理并输出响应，直到 stdin 关闭。

**消息格式**

输入消息：

```json
{"type": "user_message", "content": "你的问题或指令"}
```

输出消息类型包括：

| type | 说明 |
|------|------|
| `turn_begin` | 回合开始 |
| `text_delta` | 文本增量 |
| `tool_call` | 工具调用 |
| `tool_result` | 工具结果 |
| `turn_end` | 回合结束 |

完整的消息类型定义请参考 [Wire 消息](./wire-mode.md)。

## 使用场景

**CI/CD 集成**

在 CI 流程中自动生成代码或执行检查：

```sh
kimi --print --command "检查 src/ 目录下是否有明显的安全问题，输出 JSON 格式的报告"
```

**批量处理**

结合 shell 循环批量处理文件：

```sh
for file in src/*.py; do
  kimi --print --command "为 $file 添加类型注解"
done
```

**与其他工具集成**

作为其他工具的后端，通过 JSON 格式进行通信：

```sh
my-tool | kimi --print --input-format=stream-json --output-format=stream-json | process-output
```
