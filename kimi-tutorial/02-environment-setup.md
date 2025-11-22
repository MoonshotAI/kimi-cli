# 第 2 章：环境准备

在开始编码之前，让我们先把工具准备好。就像厨师在烹饪前会准备好刀具、砧板一样，我们也需要一个舒适的开发环境。

这一章不会很枯燥——我会告诉你为什么需要这些工具，以及如何优雅地配置它们。

## 2.1 Python 环境

### 为什么是 Python 3.10+？

你可能会问："为什么一定要 Python 3.10 或更高版本？"

答案很简单：**现代 Python 的类型系统**。

```python
# Python 3.9 及以下
from typing import Union, Optional, List

def process(items: Optional[List[Union[str, int]]]) -> Union[str, None]:
    pass

# Python 3.10+（更清晰！）
def process(items: list[str | int] | None) -> str | None:
    pass
```

看到区别了吗？3.10+ 的语法更简洁、更易读。在构建 Agent 时，我们会大量使用类型提示，清晰的类型能帮助我们避免 bug。

### 安装 Python 3.10+

**macOS**（使用 Homebrew）：
```bash
brew install python@3.11
```

**Ubuntu/Debian**：
```bash
sudo apt update
sudo apt install python3.11 python3.11-venv
```

**Windows**：
访问 [python.org](https://python.org) 下载安装器。

### 验证安装

```bash
python3 --version
# 输出应该是: Python 3.10.x 或更高
```

## 2.2 虚拟环境：你的沙盒

### 故事时间：依赖地狱

想象你在开发两个项目：
- 项目 A 需要 `requests==2.28.0`
- 项目 B 需要 `requests==3.0.0`

如果你在全局安装这些包，它们会互相冲突。这就是"依赖地狱"。

**虚拟环境**就是解决方案——每个项目有自己的独立 Python 环境。

### 创建虚拟环境

```bash
# 创建一个名为 venv 的虚拟环境
python3 -m venv venv

# 激活它
# macOS/Linux:
source venv/bin/activate

# Windows:
venv\Scripts\activate

# 你会看到提示符变化
(venv) $
```

现在你在沙盒里了！所有的 `pip install` 都只会影响这个虚拟环境。

### 退出虚拟环境

```bash
deactivate
```

> 💡 **专业提示**：在每个项目里都创建虚拟环境，并把 `venv/` 加到 `.gitignore`。

## 2.3 包管理：pip vs poetry vs uv

### pip：经典之选

```bash
# 安装包
pip install openai pydantic

# 保存依赖列表
pip freeze > requirements.txt

# 在其他机器上安装
pip install -r requirements.txt
```

**优点**：简单、标准
**缺点**：不锁定子依赖版本，容易出现"在我机器上能跑"的问题

### poetry：现代解决方案

Poetry 是 Python 的包管理器，类似于 JavaScript 的 npm。

```bash
# 安装 poetry
curl -sSL https://install.python-poetry.org | python3 -

# 初始化项目
poetry init

# 添加依赖
poetry add openai pydantic

# 安装所有依赖
poetry install
```

**优点**：
- 自动创建虚拟环境
- 锁定所有依赖版本（`poetry.lock`）
- 统一管理项目元数据

**缺点**：学习曲线稍陡

### 我的建议

- **学习阶段**：用 `venv` + `pip`，简单直接
- **生产项目**：用 `poetry`，更可靠

## 2.4 开发工具

### 代码编辑器：VS Code

我强烈推荐 **VS Code**（Visual Studio Code），原因：

1. **免费开源**
2. **Python 支持出色**
3. **插件生态丰富**
4. **内置终端**

#### 必装插件

安装 VS Code 后，按 `Cmd/Ctrl + Shift + X` 打开插件市场，搜索安装：

1. **Python** (Microsoft)
   - 代码补全、调试、类型检查

2. **Pylance** (Microsoft)
   - 强大的类型检查和智能提示

3. **Ruff** (Astral)
   - 超快的 Linter 和 Formatter

4. **autoDocstring**
   - 自动生成文档字符串

#### VS Code 配置

创建 `.vscode/settings.json`：

```json
{
  "python.defaultInterpreterPath": "./venv/bin/python",
  "python.linting.enabled": true,
  "python.linting.ruffEnabled": true,
  "python.formatting.provider": "black",
  "editor.formatOnSave": true,
  "editor.rulers": [88],
  "[python]": {
    "editor.tabSize": 4
  }
}
```

### Git：版本控制

```bash
# 检查是否安装
git --version

# 如果没有，安装
# macOS:
brew install git

# Ubuntu:
sudo apt install git

# 配置
git config --global user.name "Your Name"
git config --global user.email "your@email.com"
```

## 2.5 获取 LLM API Key

要运行 Agent，你需要一个 LLM 提供商的 API Key。

### 选项 1：Moonshot Kimi（推荐给中国用户）

1. 访问 [https://platform.moonshot.cn](https://platform.moonshot.cn)
2. 注册账号
3. 创建 API Key
4. 记下你的 Key（以 `sk-` 开头）

**优点**：
- 中文支持好
- 国内访问快
- 价格实惠

### 选项 2：OpenAI

1. 访问 [https://platform.openai.com](https://platform.openai.com)
2. 注册（需要国际支付方式）
3. 创建 API Key

**优点**：
- 模型最强大
- 文档最完善

### 选项 3：Anthropic Claude

1. 访问 [https://console.anthropic.com](https://console.anthropic.com)
2. 注册
3. 创建 API Key

**优点**：
- 上下文窗口大
- 代码能力强

### 安全存储 API Key

**永远不要**把 API Key 写在代码里！使用环境变量：

创建 `.env` 文件（加到 `.gitignore`）：

```bash
# .env
OPENAI_API_KEY=sk-...
MOONSHOT_API_KEY=sk-...
```

在代码中读取：

```python
import os
from dotenv import load_dotenv

# 加载 .env 文件
load_dotenv()

# 读取 API Key
api_key = os.getenv("OPENAI_API_KEY")
```

安装 `python-dotenv`：

```bash
pip install python-dotenv
```

## 2.6 测试你的环境

让我们写一个小脚本来测试环境是否就绪：

**`test_env.py`**

```python
"""
环境测试脚本
检查所有依赖是否正确安装
"""

import sys

def check_python_version():
    """检查 Python 版本"""
    version = sys.version_info
    if version.major == 3 and version.minor >= 10:
        print(f"✓ Python {version.major}.{version.minor}.{version.micro}")
        return True
    else:
        print(f"✗ Python 版本过低: {version.major}.{version.minor}")
        return False

def check_package(name: str) -> bool:
    """检查包是否安装"""
    try:
        __import__(name)
        print(f"✓ {name} 已安装")
        return True
    except ImportError:
        print(f"✗ {name} 未安装")
        return False

def check_api_key(env_var: str) -> bool:
    """检查 API Key"""
    import os
    key = os.getenv(env_var)
    if key:
        print(f"✓ {env_var} 已设置 ({key[:10]}...)")
        return True
    else:
        print(f"✗ {env_var} 未设置")
        return False

def main():
    """主函数"""
    print("=" * 50)
    print("环境检查")
    print("=" * 50)

    checks = []

    # 检查 Python
    checks.append(check_python_version())

    # 检查必要的包
    packages = ["openai", "pydantic", "rich", "typer"]
    for pkg in packages:
        checks.append(check_package(pkg))

    # 检查 API Key
    from dotenv import load_dotenv
    load_dotenv()
    checks.append(check_api_key("OPENAI_API_KEY"))

    print("=" * 50)
    if all(checks):
        print("🎉 环境配置完美！")
    else:
        print("⚠️  有些问题需要解决")
        print("\n请运行: pip install openai pydantic rich typer python-dotenv")
    print("=" * 50)

if __name__ == "__main__":
    main()
```

运行测试：

```bash
python test_env.py
```

预期输出：

```
==================================================
环境检查
==================================================
✓ Python 3.11.5
✓ openai 已安装
✓ pydantic 已安装
✓ rich 已安装
✓ typer 已安装
✓ OPENAI_API_KEY 已设置 (sk-proj-ab...)
==================================================
🎉 环境配置完美！
==================================================
```

## 2.7 项目结构模板

让我们创建一个标准的项目结构：

```bash
mkdir my-agent
cd my-agent

# 创建目录
mkdir -p src/my_agent tests

# 创建文件
touch src/my_agent/__init__.py
touch src/my_agent/cli.py
touch src/my_agent/agent.py
touch tests/__init__.py
touch .env
touch .gitignore
touch pyproject.toml
touch README.md
```

**`.gitignore`**：

```gitignore
# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
venv/
env/
.venv

# IDE
.vscode/
.idea/
*.swp

# 环境变量
.env

# OS
.DS_Store
```

**`pyproject.toml`**：

```toml
[project]
name = "my-agent"
version = "0.1.0"
description = "My first coding agent"
requires-python = ">=3.10"
dependencies = [
    "openai>=1.0.0",
    "pydantic>=2.0.0",
    "rich>=13.0.0",
    "typer>=0.9.0",
    "python-dotenv>=1.0.0",
]

[project.scripts]
my-agent = "my_agent.cli:main"

[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"
```

安装项目（开发模式）：

```bash
pip install -e .
```

现在你可以在任何地方运行 `my-agent` 命令了！

## 2.8 开发工作流

这是我推荐的日常工作流程：

### 1. 早晨启动

```bash
# 进入项目目录
cd my-agent

# 激活虚拟环境
source venv/bin/activate

# 更新依赖（如果有变化）
pip install -e .

# 打开编辑器
code .
```

### 2. 编码

在 VS Code 中：
- 左侧：文件树
- 中间：编辑器
- 右侧：终端（`Ctrl + ``）

### 3. 测试

```bash
# 运行你的 agent
python -m my_agent.cli

# 或者（如果安装了）
my-agent
```

### 4. 提交

```bash
# 查看修改
git status
git diff

# 提交
git add .
git commit -m "feat: add new feature"

# 推送
git push
```

## 2.9 常见问题

### Q: 为什么 `pip install` 这么慢？

A: 使用国内镜像源：

```bash
pip install -i https://mirrors.aliyun.com/pypi/simple/ package-name

# 或者永久设置
pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/
```

### Q: 虚拟环境忘记激活怎么办？

A: 你会看到包装到全局了。删除后重新安装：

```bash
pip uninstall package-name
source venv/bin/activate
pip install package-name
```

### Q: VS Code 找不到 Python 解释器？

A: 按 `Cmd/Ctrl + Shift + P`，输入 "Python: Select Interpreter"，选择 `./venv/bin/python`。

## 2.10 小结

恭喜！你的开发环境已经准备就绪：

- ✅ Python 3.10+
- ✅ 虚拟环境
- ✅ 包管理
- ✅ VS Code 配置
- ✅ LLM API Key
- ✅ 项目结构

现在你拥有了一个专业的开发环境。在接下来的章节中，我们将在这个基础上构建 Agent。

> 💡 **重要**：每次开始编码前，记得激活虚拟环境！

---

**上一章**：[第 1 章：核心概念](./01-core-concepts.md) ←
**下一章**：[第 3 章：最简单的 Agent](./03-minimal-agent.md) →
