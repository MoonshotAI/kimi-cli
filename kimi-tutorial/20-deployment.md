# 第 20 章：部署和分发

你的 Agent 开发完成了！如何分发给用户？

## 20.1 打包

使用 setuptools：

```toml
# pyproject.toml

[project]
name = "my-agent"
version = "1.0.0"
dependencies = [
    "openai>=1.0.0",
    "pydantic>=2.0.0",
    # ...
]

[project.scripts]
my-agent = "my_agent.cli:main"
```

构建：

```bash
python -m build
# 生成 dist/my-agent-1.0.0.tar.gz
```

## 20.2 发布到 PyPI

```bash
# 安装 twine
pip install twine

# 上传
twine upload dist/*
```

用户安装：

```bash
pip install my-agent
my-agent --help
```

## 20.3 Docker 部署

```dockerfile
# Dockerfile

FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

CMD ["my-agent", "--mode", "print"]
```

构建和运行：

```bash
docker build -t my-agent .
docker run -e OPENAI_API_KEY=sk-... my-agent
```

## 20.4 环境变量

生产部署时通过环境变量配置：

```bash
export OPENAI_API_KEY="sk-..."
export AGENT_MAX_STEPS=50
export AGENT_DEBUG=false

my-agent
```

---

**上一章**：[第 19 章：调试技巧](./19-debugging.md) ←
**下一章**：[第 21 章：最佳实践](./21-best-practices.md) →
