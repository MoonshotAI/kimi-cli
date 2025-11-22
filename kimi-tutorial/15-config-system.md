# 第 15 章：配置系统

不同用户有不同需求：

- 🌍 国内用户：用 Moonshot Kimi
- 🌐 国际用户：用 OpenAI GPT-4
- 💰 成本敏感：用便宜的模型
- 🚀 性能优先：用最强的模型

**配置系统**让 Agent 灵活适应各种环境。

## 15.1 配置内容

```json
{
  "llm_providers": {
    "moonshot": {
      "base_url": "https://api.moonshot.cn/v1",
      "api_key_env": "MOONSHOT_API_KEY"
    },
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key_env": "OPENAI_API_KEY"
    }
  },
  "llm_models": {
    "kimi": {
      "provider": "moonshot",
      "name": "moonshot-v1-128k",
      "max_tokens": 128000,
      "cost_per_1k_input": 0.012,
      "cost_per_1k_output": 0.012
    },
    "gpt-4": {
      "provider": "openai",
      "name": "gpt-4-turbo",
      "max_tokens": 128000,
      "cost_per_1k_input": 0.01,
      "cost_per_1k_output": 0.03
    }
  },
  "default_model": "kimi",
  "max_steps": 100,
  "approval_required": true
}
```

## 15.2 配置加载

```python
# config.py

import json
import os
from pathlib import Path
from dataclasses import dataclass

@dataclass
class LLMProvider:
    base_url: str
    api_key: str

@dataclass
class LLMModel:
    provider: str
    name: str
    max_tokens: int
    cost_per_1k_input: float
    cost_per_1k_output: float

class Config:
    """全局配置"""

    def __init__(self, config_file: Path | None = None):
        if config_file is None:
            config_file = Path.home() / ".kimi" / "config.json"

        self.config_file = config_file
        self.data = self._load()

    def _load(self) -> dict:
        """加载配置"""
        if not self.config_file.exists():
            return self._default_config()

        with open(self.config_file) as f:
            return json.load(f)

    def _default_config(self) -> dict:
        """默认配置"""
        return {
            "llm_providers": {},
            "llm_models": {},
            "default_model": "gpt-4",
            "max_steps": 100,
        }

    def get_provider(self, name: str) -> LLMProvider:
        """获取 LLM 提供商配置"""
        provider_config = self.data["llm_providers"][name]

        # 从环境变量读取 API Key
        api_key_env = provider_config.get("api_key_env")
        api_key = os.getenv(api_key_env) if api_key_env else None

        return LLMProvider(
            base_url=provider_config["base_url"],
            api_key=api_key or ""
        )

    def get_model(self, name: str) -> LLMModel:
        """获取模型配置"""
        model_config = self.data["llm_models"][name]
        return LLMModel(**model_config)

    def save(self):
        """保存配置"""
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_file, 'w') as f:
            json.dump(self.data, f, indent=2)
```

## 15.3 使用配置

```python
# 加载配置
config = Config()

# 获取模型配置
model = config.get_model("kimi")

# 获取提供商配置
provider = config.get_provider(model.provider)

# 创建 LLM 客户端
from openai import AsyncOpenAI
client = AsyncOpenAI(
    base_url=provider.base_url,
    api_key=provider.api_key
)
```

## 15.4 小结

配置系统提供：

- ✅ **多提供商支持**
- ✅ **模型切换**
- ✅ **成本追踪**
- ✅ **环境适应**

---

**上一章**：[第 14 章：UI 模式](./14-ui-modes.md) ←
**下一章**：[第 16 章：会话管理](./16-session-management.md) →
