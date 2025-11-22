# 第 4 章：工具系统设计

在上一章，我们构建了一个包含两个简单工具的 Agent。但随着工具数量增加，我们需要一个更优雅、更灵活的工具系统。

本章将深入探讨如何设计一个类似 kimi-cli 的工具系统，支持：

- 🔌 **统一的工具接口**
- 📦 **动态工具加载**
- 💉 **依赖注入**
- ⚠️ **错误处理和验证**

## 4.1 工具系统的设计目标

### 问题

在第 3 章，我们的工具定义有几个问题：

```python
# 问题 1：每个工具都要手写 schema
def get_schema() -> dict:
    return {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "...",
            "parameters": {...}
        }
    }

# 问题 2：工具注册是手动的
TOOLS = {
    "get_current_time": GetTimeTool(),
    "calculator": CalculatorTool(),
}

# 问题 3：工具无法访问系统状态（如配置、上下文）
async def execute(self, params: dict) -> str:
    # 如何获取当前工作目录？
    # 如何访问上下文？
```

### 解决方案

我们需要：

1. **自动生成 schema**：从 Pydantic 模型自动生成
2. **工具注册表**：动态注册和查找工具
3. **依赖注入**：工具可以声明需要的依赖
4. **统一接口**：所有工具实现相同的协议

## 4.2 基于协议的工具设计

### 定义工具协议

```python
# tools/protocol.py

from typing import Protocol, TypeVar, Generic, Any
from pydantic import BaseModel

# 参数类型变量
TParams = TypeVar("TParams", bound=BaseModel)


class Tool(Protocol[TParams]):
    """工具协议

    所有工具必须实现这个协议
    """

    # 工具元数据
    name: str
    description: str

    async def execute(self, params: TParams) -> str:
        """执行工具

        Args:
            params: 工具参数（Pydantic 模型实例）

        Returns:
            工具执行结果（字符串）
        """
        ...

    def get_schema(self) -> dict:
        """获取 OpenAI Function Calling 格式的 schema"""
        ...
```

### 实现基类

```python
# tools/base.py

from typing import Generic, TypeVar, get_args
from pydantic import BaseModel
import inspect

TParams = TypeVar("TParams", bound=BaseModel)


class BaseTool(Generic[TParams]):
    """工具基类

    提供自动 schema 生成等通用功能
    """

    # 子类需要定义这些属性
    name: str
    description: str

    def __init__(self):
        """初始化工具"""
        # 自动推断参数类型
        self._param_type = self._get_param_type()

    def _get_param_type(self) -> type[BaseModel]:
        """获取参数类型（通过泛型推断）"""
        # 从类的 __orig_bases__ 获取泛型参数
        for base in getattr(self.__class__, "__orig_bases__", []):
            if hasattr(base, "__args__"):
                return base.__args__[0]

        raise ValueError(f"工具 {self.name} 没有指定参数类型")

    def get_schema(self) -> dict:
        """自动生成 schema"""
        # 将 Pydantic 模型转换为 JSON Schema
        param_schema = self._param_type.model_json_schema()

        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": param_schema
            }
        }

    async def execute(self, params: TParams) -> str:
        """执行工具（子类需要实现）"""
        raise NotImplementedError

    async def __call__(self, params: dict) -> str:
        """可调用接口

        Args:
            params: 原始参数字典

        Returns:
            执行结果
        """
        # 验证和解析参数
        validated_params = self._param_type.model_validate(params)

        # 执行工具
        return await self.execute(validated_params)
```

### 使用基类重写工具

```python
# tools/time_tool.py

from pydantic import BaseModel
from .base import BaseTool
from datetime import datetime


class GetTimeParams(BaseModel):
    """获取时间参数（空）"""
    pass


class GetTimeTool(BaseTool[GetTimeParams]):
    """获取当前时间"""

    name = "get_current_time"
    description = "获取当前系统时间，格式为 YYYY-MM-DD HH:MM:SS"

    async def execute(self, params: GetTimeParams) -> str:
        now = datetime.now()
        return now.strftime("%Y-%m-%d %H:%M:%S")
```

对比之前的实现，现在：

- ✅ 不需要手写 `get_schema()`
- ✅ 自动参数验证（Pydantic）
- ✅ 类型安全（Generic）

## 4.3 工具注册表

现在我们需要一个注册表来管理所有工具：

```python
# tools/registry.py

from typing import Dict, Type
from .base import BaseTool


class ToolRegistry:
    """工具注册表"""

    def __init__(self):
        self._tools: Dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """注册一个工具"""
        if tool.name in self._tools:
            raise ValueError(f"工具 '{tool.name}' 已经注册过了")

        self._tools[tool.name] = tool

    def get(self, name: str) -> BaseTool | None:
        """获取工具"""
        return self._tools.get(name)

    def get_all(self) -> Dict[str, BaseTool]:
        """获取所有工具"""
        return self._tools.copy()

    def get_schemas(self) -> list[dict]:
        """获取所有工具的 schemas（用于传给 LLM）"""
        return [tool.get_schema() for tool in self._tools.values()]

    async def execute(self, name: str, params: dict) -> str:
        """执行工具"""
        tool = self.get(name)
        if not tool:
            raise ValueError(f"工具 '{name}' 不存在")

        return await tool(params)


# 全局注册表
registry = ToolRegistry()
```

### 使用注册表

```python
# tools/__init__.py

from .registry import registry
from .time_tool import GetTimeTool
from .calculator_tool import CalculatorTool
from .file_tool import ReadFileTool

# 注册所有工具
registry.register(GetTimeTool())
registry.register(CalculatorTool())
registry.register(ReadFileTool())
```

在 Agent 中使用：

```python
from tools import registry

class Agent:
    def __init__(self):
        # 获取所有工具的 schemas
        self.tool_schemas = registry.get_schemas()

    async def execute_tool(self, name: str, params: dict) -> str:
        # 使用注册表执行
        return await registry.execute(name, params)
```

## 4.4 依赖注入

工具经常需要访问系统状态，如：

- 配置信息（API keys、工作目录）
- 上下文对象
- 其他服务（文件系统、网络）

### 定义依赖

```python
# core/dependencies.py

from dataclasses import dataclass
from pathlib import Path


@dataclass
class Config:
    """全局配置"""
    work_dir: Path
    api_key: str
    model: str


@dataclass
class Context:
    """上下文（消息历史）"""
    messages: list[dict]

    def add_message(self, role: str, content: str):
        self.messages.append({"role": role, "content": content})


@dataclass
class ToolDependencies:
    """工具可用的依赖"""
    config: Config
    context: Context
```

### 支持依赖注入的工具基类

```python
# tools/base.py（改进版）

from typing import Generic, TypeVar
from pydantic import BaseModel

TParams = TypeVar("TParams", bound=BaseModel)


class BaseTool(Generic[TParams]):
    """工具基类（支持依赖注入）"""

    name: str
    description: str

    def __init__(self, **dependencies):
        """初始化工具

        Args:
            **dependencies: 注入的依赖
        """
        self._dependencies = dependencies
        self._param_type = self._get_param_type()

    def _get_dependency(self, dep_type: type):
        """获取依赖"""
        for dep in self._dependencies.values():
            if isinstance(dep, dep_type):
                return dep
        return None

    # ... 其他方法同前
```

### 使用依赖的工具

```python
# tools/file_tool.py

from pydantic import BaseModel, Field
from pathlib import Path
from .base import BaseTool
from core.dependencies import Config


class ReadFileParams(BaseModel):
    """读取文件参数"""
    path: str = Field(description="文件路径（相对或绝对）")
    limit: int | None = Field(None, description="最多读取的行数")


class ReadFileTool(BaseTool[ReadFileParams]):
    """读取文件工具"""

    name = "read_file"
    description = "读取指定路径的文件内容"

    async def execute(self, params: ReadFileParams) -> str:
        # 获取配置依赖
        config = self._get_dependency(Config)

        # 解析路径（相对于工作目录）
        if config:
            file_path = config.work_dir / params.path
        else:
            file_path = Path(params.path)

        # 读取文件
        try:
            with open(file_path) as f:
                if params.limit:
                    lines = [f.readline() for _ in range(params.limit)]
                    content = "".join(lines)
                else:
                    content = f.read()

            return f"文件内容:\n{content}"

        except FileNotFoundError:
            return f"错误：文件 '{file_path}' 不存在"
        except Exception as e:
            return f"读取错误: {str(e)}"
```

### 注册时注入依赖

```python
# main.py

from tools.registry import ToolRegistry
from tools.file_tool import ReadFileTool
from core.dependencies import Config, Context, ToolDependencies

# 创建依赖
config = Config(
    work_dir=Path.cwd(),
    api_key="sk-...",
    model="gpt-4"
)
context = Context(messages=[])

# 创建工具注册表
registry = ToolRegistry()

# 注册工具时注入依赖
registry.register(ReadFileTool(config=config, context=context))
```

## 4.5 动态工具加载

Kimi-CLI 的一个强大特性是可以从配置文件动态加载工具。

### 配置格式

```yaml
# agent.yaml
tools:
  - "tools.time_tool:GetTimeTool"
  - "tools.file_tool:ReadFileTool"
  - "tools.calculator_tool:CalculatorTool"
```

### 动态加载器

```python
# tools/loader.py

import importlib
from typing import Type
from .base import BaseTool


def load_tool_class(module_path: str) -> Type[BaseTool]:
    """动态加载工具类

    Args:
        module_path: 模块路径，格式为 "module.path:ClassName"

    Returns:
        工具类

    Example:
        >>> cls = load_tool_class("tools.time_tool:GetTimeTool")
        >>> tool = cls()
    """
    # 分割模块路径和类名
    module_name, class_name = module_path.split(":")

    # 导入模块
    module = importlib.import_module(module_name)

    # 获取类
    tool_class = getattr(module, class_name)

    # 验证是否是工具类
    if not issubclass(tool_class, BaseTool):
        raise TypeError(f"{class_name} 不是 BaseTool 的子类")

    return tool_class


def load_tools_from_config(
    config: dict,
    dependencies: dict
) -> ToolRegistry:
    """从配置加载工具

    Args:
        config: 配置字典
        dependencies: 要注入的依赖

    Returns:
        填充好的工具注册表
    """
    registry = ToolRegistry()

    for tool_path in config.get("tools", []):
        # 加载工具类
        tool_class = load_tool_class(tool_path)

        # 实例化（注入依赖）
        tool_instance = tool_class(**dependencies)

        # 注册
        registry.register(tool_instance)

    return registry
```

### 使用示例

```python
# main.py

import yaml
from tools.loader import load_tools_from_config
from core.dependencies import Config, Context

# 加载配置
with open("agent.yaml") as f:
    config = yaml.safe_load(f)

# 准备依赖
dependencies = {
    "config": Config(...),
    "context": Context(...)
}

# 动态加载工具
registry = load_tools_from_config(config, dependencies)

# 现在 registry 包含了所有配置的工具
print(registry.get_all().keys())
# {'get_current_time', 'read_file', 'calculator'}
```

## 4.6 错误处理和结果类型

### 工具结果类型

```python
# tools/result.py

from dataclasses import dataclass
from typing import Literal


@dataclass
class ToolSuccess:
    """工具执行成功"""
    type: Literal["success"] = "success"
    output: str


@dataclass
class ToolError:
    """工具执行失败"""
    type: Literal["error"] = "error"
    message: str
    details: str | None = None


ToolResult = ToolSuccess | ToolError
```

### 改进工具基类

```python
class BaseTool(Generic[TParams]):
    """工具基类"""

    async def execute(self, params: TParams) -> ToolResult:
        """执行工具（返回结构化结果）"""
        raise NotImplementedError

    async def __call__(self, params: dict) -> ToolResult:
        """可调用接口（增加错误处理）"""
        try:
            # 验证参数
            validated_params = self._param_type.model_validate(params)

            # 执行
            result = await self.execute(validated_params)

            # 确保返回 ToolResult
            if isinstance(result, str):
                return ToolSuccess(output=result)
            return result

        except ValidationError as e:
            # 参数验证错误
            return ToolError(
                message="参数验证失败",
                details=str(e)
            )
        except Exception as e:
            # 其他错误
            return ToolError(
                message=f"工具执行失败: {type(e).__name__}",
                details=str(e)
            )
```

### 在 Agent 中使用

```python
async def execute_tool(self, tool_call) -> str:
    """执行工具调用"""
    result = await registry.execute(tool_call.name, tool_call.params)

    if result.type == "success":
        return result.output
    else:
        # 错误信息也返回给 LLM，让它处理
        return f"错误: {result.message}\n{result.details or ''}"
```

## 4.7 完整示例：文件操作工具集

让我们实现一组完整的文件操作工具：

```python
# tools/file_tools.py

from pydantic import BaseModel, Field
from pathlib import Path
import fnmatch
from .base import BaseTool
from .result import ToolSuccess, ToolError, ToolResult
from core.dependencies import Config


# ==================== Read File ====================

class ReadFileParams(BaseModel):
    path: str = Field(description="文件路径")
    offset: int = Field(0, description="起始行号（0-indexed）")
    limit: int | None = Field(None, description="读取行数")


class ReadFileTool(BaseTool[ReadFileParams]):
    name = "read_file"
    description = "读取文件内容，支持分页"

    async def execute(self, params: ReadFileParams) -> ToolResult:
        config = self._get_dependency(Config)
        file_path = config.work_dir / params.path

        try:
            with open(file_path) as f:
                lines = f.readlines()

            # 分页
            start = params.offset
            end = start + params.limit if params.limit else len(lines)
            selected_lines = lines[start:end]

            # 添加行号
            numbered = [
                f"{start + i + 1:4d} | {line.rstrip()}"
                for i, line in enumerate(selected_lines)
            ]

            return ToolSuccess(
                output=f"文件: {params.path}\n" + "\n".join(numbered)
            )

        except FileNotFoundError:
            return ToolError(message=f"文件不存在: {params.path}")


# ==================== Write File ====================

class WriteFileParams(BaseModel):
    path: str = Field(description="文件路径")
    content: str = Field(description="文件内容")
    create_dirs: bool = Field(True, description="自动创建父目录")


class WriteFileTool(BaseTool[WriteFileParams]):
    name = "write_file"
    description = "写入文件内容，会覆盖现有文件"

    async def execute(self, params: WriteFileParams) -> ToolResult:
        config = self._get_dependency(Config)
        file_path = config.work_dir / params.path

        try:
            # 创建父目录
            if params.create_dirs:
                file_path.parent.mkdir(parents=True, exist_ok=True)

            # 写入文件
            with open(file_path, 'w') as f:
                f.write(params.content)

            return ToolSuccess(
                output=f"成功写入 {len(params.content)} 字节到 {params.path}"
            )

        except Exception as e:
            return ToolError(
                message=f"写入文件失败",
                details=str(e)
            )


# ==================== Glob ====================

class GlobParams(BaseModel):
    pattern: str = Field(description="文件匹配模式，如 '*.py' 或 'src/**/*.ts'")


class GlobTool(BaseTool[GlobParams]):
    name = "glob"
    description = "查找匹配模式的文件"

    async def execute(self, params: GlobParams) -> ToolResult:
        config = self._get_dependency(Config)

        try:
            # 使用 pathlib 的 glob
            if "**" in params.pattern:
                # 递归模式
                matches = list(config.work_dir.glob(params.pattern))
            else:
                # 非递归
                matches = list(config.work_dir.glob(params.pattern))

            if not matches:
                return ToolSuccess(output="没有找到匹配的文件")

            # 转换为相对路径
            rel_paths = [
                str(p.relative_to(config.work_dir))
                for p in matches
            ]

            return ToolSuccess(
                output=f"找到 {len(matches)} 个文件:\n" +
                       "\n".join(f"  - {p}" for p in rel_paths)
            )

        except Exception as e:
            return ToolError(message="Glob 失败", details=str(e))
```

## 4.8 小结

在本章，我们设计了一个完整的工具系统：

- ✅ **统一接口**：`BaseTool` 协议
- ✅ **自动 Schema**：从 Pydantic 模型生成
- ✅ **工具注册表**：集中管理工具
- ✅ **依赖注入**：工具可以访问系统状态
- ✅ **动态加载**：从配置文件加载工具
- ✅ **错误处理**：结构化的结果类型

这个设计与 kimi-cli 的工具系统非常相似，但我们简化了一些细节以便理解核心概念。

### Kimi-CLI 的工具系统

在 kimi-cli 中，工具系统使用了 `kosong` 库的 `CallableTool2` 基类，原理类似但功能更强大：

- 支持更复杂的依赖注入
- 支持审批系统（Approval）
- 支持并行执行多个工具
- 更完善的错误处理

## 练习

1. **实现 Grep 工具**：在文件中搜索匹配的行
2. **实现 Shell 工具**：执行 shell 命令（下一章会详细讲解）
3. **添加工具缓存**：相同的工具调用返回缓存结果
4. **实现工具中间件**：在工具执行前后添加钩子

---

**下一章**：[第 5 章：上下文管理](./05-context-management.md) →
