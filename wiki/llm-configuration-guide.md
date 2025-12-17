# Kimi CLI LLM配置指南

Kimi CLI 支持多种LLM提供商，允许您根据需要配置不同的模型。本指南将详细介绍如何配置各种LLM服务。

## 支持的LLM提供商

Kimi CLI 目前支持以下LLM提供商：

- **kimi** - Moonshot AI的Kimi模型
- **openai_legacy** - OpenAI Legacy API
- **openai_responses** - OpenAI Responses API
- **anthropic** - Anthropic Claude
- **google_genai** - Google Gemini
- **_chaos** - 混沌测试模式

## 配置文件位置

配置文件位于：`~/.kimi/config.json`

## 配置结构

配置文件使用JSON格式，主要包含以下部分：

```json
{
  "default_model": "gpt-4",
  "models": {
    "model_name": {
      "provider": "provider_name",
      "model": "api_model_name",
      "max_context_size": 128000,
      "capabilities": ["thinking", "image_in"]
    }
  },
  "providers": {
    "provider_name": {
      "type": "provider_type",
      "base_url": "https://api.example.com/v1",
      "api_key": "your-api-key",
      "custom_headers": {}
    }
  }
}
```

## 具体配置示例

### 1. OpenAI GPT配置

```json
{
  "default_model": "gpt-4",
  "models": {
    "gpt-4": {
      "provider": "openai",
      "model": "gpt-4",
      "max_context_size": 128000,
      "capabilities": []
    },
    "gpt-4-turbo": {
      "provider": "openai", 
      "model": "gpt-4-turbo-preview",
      "max_context_size": 128000,
      "capabilities": []
    }
  },
  "providers": {
    "openai": {
      "type": "openai_responses",
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-your-openai-api-key"
    }
  }
}
```

### 2. Anthropic Claude配置

```json
{
  "default_model": "claude-3-5-sonnet-20241022",
  "models": {
    "claude-3-5-sonnet": {
      "provider": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "max_context_size": 200000,
      "capabilities": []
    }
  },
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "base_url": "https://api.anthropic.com",
      "api_key": "sk-ant-your-anthropic-api-key"
    }
  }
}
```

### 3. Google Gemini配置

```json
{
  "default_model": "gemini-1.5-pro",
  "models": {
    "gemini-1.5-pro": {
      "provider": "google",
      "model": "gemini-1.5-pro-latest",
      "max_context_size": 2097152,
      "capabilities": []
    }
  },
  "providers": {
    "google": {
      "type": "google_genai",
      "base_url": "https://generativelanguage.googleapis.com/v1beta",
      "api_key": "your-google-api-key"
    }
  }
}
```

### 4. 自定义OpenAI兼容API配置

```json
{
  "default_model": "custom-model",
  "models": {
    "custom-model": {
      "provider": "custom",
      "model": "gpt-4",
      "max_context_size": 128000,
      "capabilities": []
    }
  },
  "providers": {
    "custom": {
      "type": "openai_responses",
      "base_url": "https://your-custom-api.com/v1",
      "api_key": "your-custom-api-key",
      "custom_headers": {
        "Authorization": "Bearer your-custom-token",
        "X-Custom-Header": "custom-value"
      }
    }
  }
}
```

### 5. 多提供商混合配置

```json
{
  "default_model": "gpt-4",
  "models": {
    "gpt-4": {
      "provider": "openai",
      "model": "gpt-4",
      "max_context_size": 128000,
      "capabilities": []
    },
    "claude-3-5-sonnet": {
      "provider": "anthropic", 
      "model": "claude-3-5-sonnet-20241022",
      "max_context_size": 200000,
      "capabilities": []
    },
    "gemini-pro": {
      "provider": "google",
      "model": "gemini-1.5-pro-latest", 
      "max_context_size": 2097152,
      "capabilities": []
    }
  },
  "providers": {
    "openai": {
      "type": "openai_responses",
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-your-openai-key"
    },
    "anthropic": {
      "type": "anthropic",
      "base_url": "https://api.anthropic.com",
      "api_key": "sk-ant-your-anthropic-key"
    },
    "google": {
      "type": "google_genai",
      "base_url": "https://generativelanguage.googleapis.com/v1beta",
      "api_key": "your-google-key"
    }
  }
}
```

## 环境变量配置

除了配置文件，您还可以使用环境变量来覆盖配置：

### OpenAI
```bash
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="sk-your-openai-api-key"
```

### Kimi
```bash
export KIMI_BASE_URL="https://api.moonshot.ai/v1"
export KIMI_API_KEY="your-kimi-api-key"
export KIMI_MODEL_NAME="kimi-k2-turbo-preview"
export KIMI_MODEL_MAX_CONTEXT_SIZE="250000"
```

## 模型能力配置

某些模型支持特殊能力，目前支持：

- `thinking` - 思考能力（适用于支持推理的模型）
- `image_in` - 图像输入能力

```json
{
  "models": {
    "thinking-model": {
      "provider": "openai",
      "model": "o1-preview",
      "max_context_size": 128000,
      "capabilities": ["thinking"]
    },
    "vision-model": {
      "provider": "openai", 
      "model": "gpt-4-vision-preview",
      "max_context_size": 128000,
      "capabilities": ["image_in"]
    }
  }
}
```

## 切换模型

配置完成后，您可以通过以下方式切换模型：

1. **修改配置文件**：更改 `default_model` 字段
2. **命令行参数**：使用 `--model` 参数指定模型
3. **运行时切换**：在会话中使用 `/model` 命令

## 配置验证

Kimi CLI 会在启动时验证配置文件的正确性。如果配置有误，会显示详细的错误信息。

## 常见问题

### Q: 如何获取API密钥？
A: 请访问相应的提供商官网获取：
- OpenAI: https://platform.openai.com/api-keys
- Anthropic: https://console.anthropic.com/
- Google: https://console.cloud.google.com/

### Q: 如何设置代理？
A: 可以通过环境变量设置代理：
```bash
export HTTP_PROXY="http://proxy.example.com:8080"
export HTTPS_PROXY="http://proxy.example.com:8080"
```

### Q: 模型上下文大小如何设置？
A: 查看模型文档了解最大上下文大小，建议设置比最大值小一些的值以确保稳定性。

### Q: 配置文件密码安全吗？
A: 配置文件中的API密钥会被加密存储，但仍建议保护好配置文件的访问权限。

## 示例配置文件

完整的示例配置文件可以在项目的 `examples/` 目录中找到。

## 故障排除

如果遇到配置问题，可以：

1. 检查JSON格式是否正确
2. 验证API密钥是否有效
3. 确认网络连接是否正常
4. 查看日志输出获取详细错误信息

更多信息请参考 [项目文档](https://github.com/MoonshotAI/kimi-cli)。
