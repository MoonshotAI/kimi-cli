# AWS Bedrock Mantle with Kimi Code CLI

Use Kimi models through [Amazon Bedrock Mantle](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html)’s OpenAI-compatible API.

## Quick setup (recommended)

1. Create a Bedrock API key in the AWS console.
2. Start Kimi Code CLI shell mode and run `/login` (or `/setup`).
3. Choose **AWS Bedrock Mantle (OpenAI-compatible)**.
4. Pick an AWS Region that supports Mantle and lists the models you need (for Kimi, regions such as `eu-west-2` or `us-east-1` often expose `moonshotai.*` IDs; availability varies by region).
5. Paste your API key and select a model (for example `moonshotai.kimi-k2.5`).

Configuration is written to `~/.kimi/config.toml` under the managed provider `managed:bedrock-mantle`.

## Verify (non-interactive)

```sh
kimi --print --prompt "Say hello in one short sentence."
```

## Manual configuration

If you prefer not to use `/login`, use `openai_legacy` with the Mantle `base_url`:

```toml
default_model = "bedrock-mantle/moonshotai.kimi-k2.5"

[providers."managed:bedrock-mantle"]
type = "openai_legacy"
base_url = "https://bedrock-mantle.eu-west-2.api.aws/v1"
api_key = "ABSK..."

[models."bedrock-mantle/moonshotai.kimi-k2.5"]
provider = "managed:bedrock-mantle"
model = "moonshotai.kimi-k2.5"
max_context_size = 131072
capabilities = ["thinking", "image_in"]
```

Model alias keys must match what `/login` would generate (`<platform_id>/<model_id>`).

## Environment overrides

For any `openai_legacy` provider, Kimi CLI can override the saved URL and key from the environment:

- `OPENAI_BASE_URL` — replaces `base_url` when set.
- `OPENAI_API_KEY` — replaces `api_key` when set.

These apply per run and are useful for CI or switching regions without editing TOML.

## Search and fetch

Mantle setup does **not** configure Moonshot Search/Fetch. The `SearchWeb` and `FetchURL` tools behave like other non–Kimi Code providers (search unavailable; fetch may fall back locally). Use Kimi Code via `/login` if you need those services.
