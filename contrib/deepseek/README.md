# DeepSeek Thinking Support for Kimi CLI

This directory provides two approaches to use DeepSeek models (with thinking/reasoning
support) in Kimi CLI:

1. **Native** (no proxy, recommended) — uses `OpenAILegacy` provider with the built-in
   `reasoning_key` support for `reasoning_content` round-trip.
2. **Proxy** — a lightweight local HTTP proxy (`deepseek_proxy.py`) that injects thinking
   mode into every request and maintains a local reasoning content store for
   multi-turn reliability.

---

## Approach 1: Native (recommended)

The `OpenAILegacy` provider in Kimi CLI already supports `reasoning_content` round-trip
out of the box. No external proxy or patching is needed.

### How it works

- The `reasoning_key` parameter on `OpenAILegacy` defaults to `"reasoning_content"`,
  which is the exact field name DeepSeek uses for thinking content.
- On **response parsing**: `reasoning_content` from DeepSeek's API is extracted via
  `getattr(delta, reasonning_key, None)` and converted to kosong's `ThinkPart` type.
- On **message sending**: kosong's `ThinkPart` is converted back to `reasoning_content`
  in the assistant message payload before sending to the API.
- The `thinking_effort` setting maps to `reasoning_effort` in the OpenAI API call.

### Configuration

Add to your `~/.kimi/config.toml`:

```toml
[providers.deepseek]
type = "openai_legacy"
base_url = "https://api.deepseek.com/v1"
api_key = "sk-your-actual-key"

[models.deepseek-chat]
provider = "deepseek"
model = "deepseek-chat"
max_context_size = 65536
capabilities = ["thinking"]

[models.deepseek-reasoner]
provider = "deepseek"
model = "deepseek-reasoner"
max_context_size = 65536
capabilities = ["thinking", "always_thinking"]
```

Set `default_model = "deepseek-chat"` to use DeepSeek as your default model.

#### Advanced: Custom `reasoning_key`

If your API uses a different field name for thinking content (e.g. `"reasoning"`,
`"thinking"`, `"thinking_content"`), set `reasoning_key` explicitly:

```toml
[providers.my-custom-provider]
type = "openai_legacy"
base_url = "https://api.example.com/v1"
api_key = "sk-..."
reasoning_key = "thinking"    # ← custom field name
```

Set `reasoning_key = ""` (empty string) to disable reasoning round-trip entirely.

#### Thinking effort

Pass `--thinking` on the CLI or set `default_thinking = true` in config to enable
thinking mode. The effort level maps as follows:

| `thinking_effort` | `reasoning_effort` |
|-------------------|-------------------|
| off               | None              |
| low               | low               |
| medium            | medium            |
| high              | high              |
| xhigh             | xhigh             |
| max               | xhigh (clamped)   |

---

## Approach 2: Proxy server

If you need to force thinking mode on models that don't advertise it, or want
extra debugging/logging, use the included proxy.

### How it works

`deepseek_proxy.py` is a **zero-dependency** Python script (stdlib only) that:

1. Listens on `http://127.0.0.1:18923`
2. Forwards requests to `https://api.deepseek.com/v1`
3. Injects `thinking: {"type": "enabled"}` + `reasoning_effort: "max"` into every
   chat completion request
4. Stores `reasoning_content` from DeepSeek responses in an in-memory store
5. Re-injects `reasoning_content` into multi-turn assistant messages (the proxy
   patches messages that are missing it, preventing 400 errors on turn 2+)
6. Handles both streaming and non-streaming responses

### Usage

```bash
# Start the proxy
python3 /path/to/kimi-cli/contrib/deepseek/deepseek_proxy.py &

# Point Kimi CLI at it
kimi --provider deepseek --model deepseek-chat
```

### Proxy config

```toml
[providers.deepseek]
type = "openai_legacy"
base_url = "http://localhost:18923/v1"
api_key = "sk-your-actual-key"

[models.deepseek-chat]
provider = "deepseek"
model = "deepseek-chat"
max_context_size = 65536
capabilities = ["thinking"]
```

### Logging

The proxy logs to `~/.kimi-code/proxy.log` (with INFO level) and stderr.
To silence the access log, adjust the `deepseek-proxy.access` logger level.

---

## Comparison

| Feature                | Native         | Proxy          |
|------------------------|----------------|----------------|
| Dependencies           | None (built-in)| stdlib only    |
| Reasoning content      | Full round-trip| Full + store   |
| Forced thinking mode   | Via config only| Always on      |
| Multi-turn reliability | Built-in       | Store fallback |
| Debug logging          | Kimi CLI logs  | Proxy logs     |
| Performance            | Direct API call| Extra hop      |

---

## Files

| File                | Description                                  |
|---------------------|----------------------------------------------|
| `README.md`         | This file                                    |
| `deepseek_proxy.py` | Zero-dependency HTTP proxy for DeepSeek API  |
| `config.toml.example` | Example Kimi CLI config for DeepSeek       |

---

## Related code

The native support lives in the kosong package:

- `packages/kosong/src/kosong/contrib/chat_provider/openai_legacy.py` — provider
  with `reasoning_key` parameter (line 78)
- `packages/kosong/src/kosong/chat_provider/kimi.py` — Kimi native provider that
  also handles `reasoning_content`
- `packages/kosong/src/kosong/message.py` — `ThinkPart` content type (line 91)
- `src/kimi_cli/llm.py` — `create_llm()` wires `reasoning_key` from config into
  `OpenAILegacy` (line 158-162)
- `src/kimi_cli/config.py` — `LLMProvider.reasoning_key` field (line 48)

## License

Same as Kimi CLI. See `LICENSE` / `NOTICE` at the repository root.
