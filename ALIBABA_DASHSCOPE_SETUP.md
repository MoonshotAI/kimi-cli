# Setting up Alibaba Cloud with Kimi Code CLI

This guide explains how to connect Kimi Code CLI with Alibaba Cloud's AI coding platforms.

## Prerequisites

1. An Alibaba Cloud account
2. A Coding Plan subscription OR Standard Dashscope API key

## Step 1: Get Your API Key

### Option A: Alibaba Cloud Coding Plan (Recommended for Coding)

This is a subscription-based plan designed specifically for AI coding assistants.

1. Go to [Alibaba Cloud Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)
2. Subscribe to the Coding Plan
3. Get your **Coding Plan API Key** (format: `sk-sp-xxxxx`)
4. Save it securely

**Coding Plan API Endpoint:** `https://coding-intl.dashscope.aliyuncs.com/v1`
**Supported Models:** `qwen3.5-plus`, `kimi-k2.5`, `glm-5`, `MiniMax-M2.5`, `qwen3-max`, `qwen3-coder-next`, `qwen3-coder-plus`, `glm-4.7`

### Option B: Standard Dashscope API (Pay-as-you-go)

1. Go to [Alibaba Cloud Model Studio (百炼)](https://bailian.console.aliyun.com/)
2. Navigate to **API-KEY Management**
3. Create or copy your API key (format: `sk-xxxxx`)
4. Save it securely

**Standard Dashscope Endpoint:** `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
**Supported Models:** `qwen-turbo`, `qwen-plus`, `qwen-max`, `qwen-long`, `qwen-vl-max`, `qwen-coder-plus`, `qwen-coder-turbo`

> **Important:** Coding Plan keys (`sk-sp-xxxxx`) and Standard Dashscope keys (`sk-xxxxx`) are **NOT interchangeable**. Use the correct platform for your key type.

## Step 2: Setup in Kimi Code CLI

### Using the `/login` Command (Interactive)

1. Start Kimi Code CLI:
   ```powershell
   D:\lext\kimi-jang-cli\.venv\Scripts\kimi.exe
   ```

2. Type:
   ```
   /login
   ```

3. Select your platform:
   ```
   1. KIMI-JANG
   2. Moonshot AI Open Platform (moonshot.cn)
   3. Moonshot AI Open Platform (moonshot.ai)
   4. Alibaba Cloud Coding Plan (coding-intl.dashscope)  ← For Coding Plan keys (sk-sp-xxxxx)
   5. Alibaba Cloud Dashscope Standard (dashscope-intl.aliyuncs.com)  ← For Standard keys (sk-xxxxx)
   ```

4. Enter your API key when prompted

5. Select your preferred model from the predefined list

6. Choose whether to enable thinking mode (if supported)

7. Setup complete!

> **Note:** Coding Plan doesn't support the `/models` API endpoint, so models are pre-defined in the CLI.

## Using the `/login` Command (Interactive)

1. Start Kimi Code CLI:
   ```powershell
   D:\lext\kimi-jang-cli\.venv\Scripts\kimi.exe
   ```

2. Type:
   ```
   /login
   ```

3. Select your platform:
   ```
   1. KIMI-JANG
   2. Moonshot AI Open Platform (moonshot.cn)
   3. Moonshot AI Open Platform (moonshot.ai)
   4. Alibaba Cloud Coding Plan (coding-intl.dashscope)  ← For Coding Plan keys (sk-sp-xxxxx)
   5. Alibaba Cloud Dashscope Standard (dashscope-intl.aliyuncs.com)  ← For Standard keys (sk-xxxxx)
   ```

4. Enter your API key when prompted

5. Select your preferred model from the predefined list

6. Choose whether to enable thinking mode (if supported)

7. Setup complete!

> **Note:** Coding Plan doesn't support the `/models` API endpoint, so models are pre-defined in the CLI.

## Step 3: Verify the Setup

After setup, check your configuration:

```powershell
D:\lext\kimi-jang-cli\.venv\Scripts\kimi.exe info
```

## Available Models

### Coding Plan Models
| Model | Context | Description | Best For |
|-------|---------|-------------|----------|
| `qwen3.5-plus` | 128K | Qwen 3.5 with vision | General coding (Recommended) |
| `kimi-k2.5` | 256K | Kimi's latest model | Complex reasoning, vision |
| `glm-5` | 128K | GLM model | Alternative option |
| `MiniMax-M2.5` | 256K | MiniMax model | Long context tasks |
| `qwen3-coder-next` | 128K | Qwen3 coder | Programming tasks |
| `qwen3-coder-plus` | 128K | Qwen3 coder+ | Advanced coding |
| `qwen3-max` | 128K | Qwen3 max | Complex tasks |
| `glm-4.7` | 128K | GLM 4.7 | Alternative option |

### Standard Dashscope Models
| Model | Context | Description | Best For |
|-------|---------|-------------|----------|
| `qwen-turbo` | 8K | Fast, cost-effective | Quick tasks |
| `qwen-plus` | 32K | Balanced | General coding tasks |
| `qwen-max` | 32K | Most capable | Complex reasoning |
| `qwen-long` | 1M | Long context | Document analysis |
| `qwen-vl-max` | 32K | Vision + text | Image understanding |
| `qwen-coder-plus` | 32K | Code-specialized | Programming tasks |
| `qwen-coder-turbo` | 32K | Fast coding | Quick code generation |

## Troubleshooting

### "404 Not Found" Error
- You selected Coding Plan but the endpoint doesn't have a `/models` endpoint
- This is expected - use the predefined model list instead (already fixed in this fork)

### "401 Unauthorized" Error
- Your API key is invalid or expired
- Make sure you're using the correct key for the platform:
  - Coding Plan: `sk-sp-xxxxx`
  - Standard Dashscope: `sk-xxxxx`

### Model Not Found
- Verify the model name matches the supported models for your plan
- Some models may require specific subscription levels

## Additional Resources

- [Alibaba Cloud Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)
- [Kimi Code CLI Documentation](https://moonshotai.github.io/kimi-cli/en/)
- [Alibaba Cloud Model Studio](https://bailian.console.aliyun.com/)
