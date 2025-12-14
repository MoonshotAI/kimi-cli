# Python 快速入门指南 - 面向 Java 开发者

> 本文档基于 Kimi CLI 项目的实际代码，帮助 Java 开发者快速掌握项目所需的 Python 知识。

## 目录

- [Java vs Python 核心差异](#java-vs-python-核心差异)
- [基础语法速览](#基础语法速览)
- [类型注解系统](#类型注解系统)
- [异步编程（async/await）](#异步编程asyncawait)
- [面向对象编程](#面向对象编程)
- [装饰器（Decorators）](#装饰器decorators)
- [数据类和 Pydantic](#数据类和-pydantic)
- [异常处理](#异常处理)
- [常用标准库](#常用标准库)
- [项目中的实际模式](#项目中的实际模式)
- [快速参考对照表](#快速参考对照表)

---

## Java vs Python 核心差异

### 1. 语法风格

| 特性 | Java | Python |
|------|------|--------|
| **缩进** | 使用大括号 `{}` | 使用缩进（4个空格） |
| **分号** | 必需 `;` | 不需要 |
| **变量声明** | 需要类型 `String name = "value";` | 直接赋值 `name = "value"` |
| **字符串** | 双引号 `"string"` | 单引号或双引号 `'string'` 或 `"string"` |
| **注释** | `//` 或 `/* */` | `#` 或 `""" """` |

### 2. 类型系统

**Java**: 静态类型，编译时检查
```java
String name = "Kimi";
int count = 10;
List<String> items = new ArrayList<>();
```

**Python**: 动态类型，但支持类型注解（本项目大量使用）
```python
name: str = "Kimi"
count: int = 10
items: list[str] = []
```

### 3. 包和模块

**Java**: 包结构，使用 `package` 和 `import`
```java
package com.example;
import java.util.List;
```

**Python**: 模块系统，使用 `import`
```python
from kimi_cli.config import Config
from kimi_cli.soul import KimiSoul
```

---

## 基础语法速览

### 1. 变量和基本类型

```python
# 基本类型（带类型注解）
name: str = "Kimi CLI"
version: int = 54
is_active: bool = True
price: float = 99.99

# 集合类型
items: list[str] = ["a", "b", "c"]
config: dict[str, int] = {"max_steps": 100, "timeout": 60}
capabilities: set[str] = {"thinking", "image"}

# 可选类型（类似 Java 的 Optional）
model_name: str | None = None  # Python 3.10+
# 或使用 typing.Optional（Python 3.9-）
from typing import Optional
model_name: Optional[str] = None
```

**Java 对照**:
```java
String name = "Kimi CLI";
int version = 54;
boolean isActive = true;
double price = 99.99;

List<String> items = Arrays.asList("a", "b", "c");
Map<String, Integer> config = Map.of("max_steps", 100);
Set<String> capabilities = Set.of("thinking", "image");

Optional<String> modelName = Optional.empty();
```

### 2. 字符串格式化

```python
# f-string（推荐，Python 3.6+）
name = "Kimi"
version = 54
message = f"Welcome to {name} version {version}"

# 格式化字符串（类似 Java 的 String.format）
message = "Welcome to {} version {}".format(name, version)

# 项目中的实际例子
logger.info("Loading agent: {agent_file}", agent_file=agent_file)
```

**Java 对照**:
```java
String name = "Kimi";
int version = 54;
String message = String.format("Welcome to %s version %d", name, version);
// 或
String message = "Welcome to " + name + " version " + version;
```

### 3. 列表推导式（List Comprehensions）

```python
# 过滤和转换
numbers = [1, 2, 3, 4, 5]
squares = [x * x for x in numbers]  # [1, 4, 9, 16, 25]
evens = [x for x in numbers if x % 2 == 0]  # [2, 4]

# 项目中的实际例子（src/kimi_cli/soul/agent.py）
tools = [tool for tool in tools if tool not in agent_spec.exclude_tools]
```

**Java 对照**:
```java
List<Integer> numbers = List.of(1, 2, 3, 4, 5);
List<Integer> squares = numbers.stream()
    .map(x -> x * x)
    .collect(Collectors.toList());
List<Integer> evens = numbers.stream()
    .filter(x -> x % 2 == 0)
    .collect(Collectors.toList());
```

### 4. 字典（Dictionary）

```python
# 创建字典
config: dict[str, int] = {
    "max_steps": 100,
    "timeout": 60
}

# 访问和修改
value = config["max_steps"]  # 100
config["timeout"] = 120

# 安全访问（类似 Java 的 getOrDefault）
timeout = config.get("timeout", 60)  # 如果不存在返回默认值

# 字典推导式
squares_dict = {x: x * x for x in range(5)}  # {0: 0, 1: 1, 2: 4, 3: 9, 4: 16}
```

**Java 对照**:
```java
Map<String, Integer> config = Map.of(
    "max_steps", 100,
    "timeout", 60
);

int value = config.get("max_steps");
config.put("timeout", 120);

int timeout = config.getOrDefault("timeout", 60);
```

### 5. 条件表达式

```python
# 三元运算符（类似 Java 的 ? :）
status = "active" if is_enabled else "inactive"

# 项目中的实际例子（src/kimi_cli/tools/bash/__init__.py）
_NAME = "CMD" if platform.system() == "Windows" else "Bash"
```

**Java 对照**:
```java
String status = isEnabled ? "active" : "inactive";
String name = System.getProperty("os.name").startsWith("Windows") ? "CMD" : "Bash";
```

### 6. 模式匹配（match/case）- Python 3.10+

```python
# 类似 Java 的 switch（但更强大）
match ui:
    case "shell":
        succeeded = await instance.run_shell_mode(command)
    case "print":
        succeeded = await instance.run_print_mode(...)
    case "acp":
        succeeded = await instance.run_acp_server()
    case _:  # 默认情况
        raise ValueError(f"Unknown UI mode: {ui}")
```

**Java 对照**:
```java
switch (ui) {
    case "shell":
        succeeded = await instance.runShellMode(command);
        break;
    case "print":
        succeeded = await instance.runPrintMode(...);
        break;
    case "acp":
        succeeded = await instance.runAcpServer();
        break;
    default:
        throw new IllegalArgumentException("Unknown UI mode: " + ui);
}
```

---

## 类型注解系统

Python 3.5+ 支持类型注解，本项目大量使用。虽然运行时不会强制检查，但 IDE 和类型检查工具（如 pyright）会使用它们。

### 1. 基本类型注解

```python
# 变量类型注解
name: str = "Kimi"
count: int = 10
is_active: bool = True

# 函数参数和返回值
def greet(name: str) -> str:
    return f"Hello, {name}!"
```

**Java 对照**:
```java
String name = "Kimi";
int count = 10;
boolean isActive = true;

String greet(String name) {
    return "Hello, " + name + "!";
}
```

### 2. 集合类型注解

```python
from typing import List, Dict, Set, Optional

# Python 3.9+ 可以使用内置类型
items: list[str] = []
config: dict[str, int] = {}
capabilities: set[str] = set()

# Python 3.9- 需要使用 typing
from typing import List, Dict, Set
items: List[str] = []
config: Dict[str, int] = {}
capabilities: Set[str] = set()
```

**Java 对照**:
```java
List<String> items = new ArrayList<>();
Map<String, Integer> config = new HashMap<>();
Set<String> capabilities = new HashSet<>();
```

### 3. 可选类型和联合类型

```python
# Python 3.10+ 联合类型
model_name: str | None = None
timeout: int | float = 60

# Python 3.9- 使用 Optional 和 Union
from typing import Optional, Union
model_name: Optional[str] = None
timeout: Union[int, float] = 60

# 项目中的实际例子（src/kimi_cli/cli.py）
agent_file: Annotated[Path | None, typer.Option(...)] = None
```

**Java 对照**:
```java
Optional<String> modelName = Optional.empty();
// Java 没有联合类型，需要使用泛型或继承
```

### 4. 泛型类型注解

```python
from typing import TypeVar, Generic, Type

# 类型变量
T = TypeVar('T')

# 泛型类
class Container(Generic[T]):
    def __init__(self, value: T):
        self.value = value

# 项目中的实际例子（src/kimi_cli/tools/bash/__init__.py）
class Bash(CallableTool2[Params]):
    params: type[Params] = Params
```

**Java 对照**:
```java
class Container<T> {
    private T value;
    
    public Container(T value) {
        this.value = value;
    }
}
```

### 5. 字面量类型（Literal Types）

```python
from typing import Literal

# 限制为特定值
UIMode = Literal["shell", "print", "acp", "wire"]

def set_ui_mode(mode: UIMode) -> None:
    ...

# 项目中的实际例子（src/kimi_cli/cli.py）
UIMode = Literal["shell", "print", "acp", "wire"]
```

**Java 对照**:
```java
enum UIMode {
    SHELL, PRINT, ACP, WIRE
}

void setUiMode(UIMode mode) {
    ...
}
```

### 6. Protocol（协议类型）- 类似 Java 的接口

```python
from typing import Protocol

class Drawable(Protocol):
    def draw(self) -> None: ...

def render(obj: Drawable) -> None:
    obj.draw()

# 项目中的实际例子
class Soul(Protocol):
    name: str
    model_name: str
    async def run(self, user_input: str) -> None: ...
```

**Java 对照**:
```java
interface Drawable {
    void draw();
}

void render(Drawable obj) {
    obj.draw();
}
```

### 7. Annotated（元数据注解）

```python
from typing import Annotated

# 用于添加元数据到类型注解
# 项目中的实际例子（src/kimi_cli/cli.py）
verbose: Annotated[
    bool,
    typer.Option(
        "--verbose",
        help="Print verbose information.",
    ),
] = False
```

**Java 对照**:
```java
// Java 使用注解（Annotations）
@Option(name = "--verbose", help = "Print verbose information.")
boolean verbose = false;
```

---

## 异步编程（async/await）

这是本项目最重要的特性之一！Python 的异步编程类似于 Java 的 `CompletableFuture` 和 `async/await`（Java 19+）。

### 1. 基本概念

```python
import asyncio

# 定义异步函数
async def fetch_data(url: str) -> str:
    # 模拟异步操作
    await asyncio.sleep(1)
    return f"Data from {url}"

# 调用异步函数
async def main():
    result = await fetch_data("https://api.example.com")
    print(result)

# 运行异步程序
asyncio.run(main())
```

**Java 对照**:
```java
CompletableFuture<String> fetchData(String url) {
    return CompletableFuture.supplyAsync(() -> {
        try {
            Thread.sleep(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return "Data from " + url;
    });
}

void main() {
    String result = fetchData("https://api.example.com").join();
    System.out.println(result);
}
```

### 2. 项目中的实际例子

```python
# src/kimi_cli/app.py
async def run_shell_mode(self, command: str | None = None) -> bool:
    from kimi_cli.ui.shell import ShellApp
    
    with self._app_env():
        app = ShellApp(self._soul, welcome_info=welcome_info)
        return await app.run(command)

# src/kimi_cli/tools/bash/__init__.py
async def __call__(self, params: Params) -> ToolReturnType:
    if not await self._approval.request(...):
        return ToolRejectedError()
    
    exitcode = await _stream_subprocess(...)
    return builder.ok("Command executed successfully.")
```

### 3. 并发执行

```python
import asyncio

# 并发执行多个异步任务
async def main():
    # 方式1: gather（等待所有完成）
    results = await asyncio.gather(
        fetch_data("url1"),
        fetch_data("url2"),
        fetch_data("url3")
    )
    
    # 方式2: 创建任务
    task1 = asyncio.create_task(fetch_data("url1"))
    task2 = asyncio.create_task(fetch_data("url2"))
    result1 = await task1
    result2 = await task2

# 项目中的实际例子（src/kimi_cli/tools/bash/__init__.py）
await asyncio.wait_for(
    asyncio.gather(
        _read_stream(process.stdout, stdout_cb),
        _read_stream(process.stderr, stderr_cb),
    ),
    timeout,
)
```

**Java 对照**:
```java
CompletableFuture<String> future1 = fetchData("url1");
CompletableFuture<String> future2 = fetchData("url2");
CompletableFuture<String> future3 = fetchData("url3");

CompletableFuture.allOf(future1, future2, future3).join();
```

### 4. 异步上下文管理器

```python
# 定义异步上下文管理器
class AsyncResource:
    async def __aenter__(self):
        # 初始化资源
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        # 清理资源
        pass

# 使用
async def main():
    async with AsyncResource() as resource:
        # 使用资源
        pass
```

**Java 对照**:
```java
// Java 使用 try-with-resources
try (Resource resource = new Resource()) {
    // 使用资源
}
```

---

## 面向对象编程

### 1. 类定义

```python
class Person:
    # 类变量
    species: str = "Homo sapiens"
    
    # 构造函数
    def __init__(self, name: str, age: int):
        # 实例变量（使用 self）
        self.name: str = name
        self.age: int = age
    
    # 实例方法
    def greet(self) -> str:
        return f"Hello, I'm {self.name}"
    
    # 类方法
    @classmethod
    def from_birth_year(cls, name: str, birth_year: int) -> "Person":
        age = 2025 - birth_year
        return cls(name, age)
    
    # 静态方法
    @staticmethod
    def is_adult(age: int) -> bool:
        return age >= 18
```

**Java 对照**:
```java
class Person {
    static String species = "Homo sapiens";
    
    String name;
    int age;
    
    Person(String name, int age) {
        this.name = name;
        this.age = age;
    }
    
    String greet() {
        return "Hello, I'm " + name;
    }
    
    static Person fromBirthYear(String name, int birthYear) {
        int age = 2025 - birthYear;
        return new Person(name, age);
    }
    
    static boolean isAdult(int age) {
        return age >= 18;
    }
}
```

### 2. 继承

```python
class Animal:
    def __init__(self, name: str):
        self.name = name
    
    def speak(self) -> str:
        return "Some sound"

class Dog(Animal):
    def __init__(self, name: str, breed: str):
        super().__init__(name)  # 调用父类构造函数
        self.breed = breed
    
    def speak(self) -> str:  # 重写方法
        return "Woof!"
    
    def fetch(self) -> str:
        return f"{self.name} fetches the ball"
```

**Java 对照**:
```java
class Animal {
    String name;
    
    Animal(String name) {
        this.name = name;
    }
    
    String speak() {
        return "Some sound";
    }
}

class Dog extends Animal {
    String breed;
    
    Dog(String name, String breed) {
        super(name);
        this.breed = breed;
    }
    
    @Override
    String speak() {
        return "Woof!";
    }
    
    String fetch() {
        return name + " fetches the ball";
    }
}
```

### 3. 项目中的实际例子

```python
# src/kimi_cli/soul/kimisoul.py
class KimiSoul(Soul):
    """The soul of Kimi CLI."""
    
    def __init__(
        self,
        agent: Agent,
        runtime: Runtime,
        *,
        context: Context,
    ):
        self._agent = agent
        self._runtime = runtime
        self._context = context
    
    @property
    def name(self) -> str:
        return self._agent.name
    
    @property
    def model_name(self) -> str:
        return self._runtime.llm.chat_provider.model_name if self._runtime.llm else ""
    
    async def run(self, user_input: str | list[ContentPart]):
        # 异步方法实现
        ...
```

---

## 装饰器（Decorators）

装饰器是 Python 的强大特性，类似于 Java 的注解，但功能更强大。

### 1. 基本装饰器

```python
def my_decorator(func):
    def wrapper(*args, **kwargs):
        print("Before function call")
        result = func(*args, **kwargs)
        print("After function call")
        return result
    return wrapper

@my_decorator
def greet(name: str):
    print(f"Hello, {name}!")

greet("Kimi")  # 输出: Before function call\nHello, Kimi!\nAfter function call
```

### 2. 项目中的常用装饰器

#### @property（属性装饰器）

```python
class KimiSoul:
    def __init__(self):
        self._name = "Kimi"
    
    @property
    def name(self) -> str:
        """获取名称"""
        return self._name
    
    @name.setter
    def name(self, value: str):
        """设置名称"""
        self._name = value

# 使用
soul = KimiSoul()
print(soul.name)  # 调用 getter
soul.name = "New Name"  # 调用 setter
```

**Java 对照**:
```java
class KimiSoul {
    private String name = "Kimi";
    
    public String getName() {
        return name;
    }
    
    public void setName(String name) {
        this.name = name;
    }
}
```

#### @override（重写装饰器）

```python
from typing import override

class BaseTool:
    def execute(self) -> str:
        return "Base execution"

class MyTool(BaseTool):
    @override
    def execute(self) -> str:
        return "My execution"
```

**Java 对照**:
```java
class BaseTool {
    String execute() {
        return "Base execution";
    }
}

class MyTool extends BaseTool {
    @Override
    String execute() {
        return "My execution";
    }
}
```

#### @dataclass（数据类装饰器）

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True, kw_only=True)
class Agent:
    name: str
    system_prompt: str
    toolset: Toolset
```

**Java 对照**:
```java
// Java 14+ Record
record Agent(String name, String systemPrompt, Toolset toolset) {}

// 或传统方式
class Agent {
    private final String name;
    private final String systemPrompt;
    private final Toolset toolset;
    
    // 构造函数、getter、equals、hashCode、toString...
}
```

---

## 数据类和 Pydantic

### 1. @dataclass

```python
from dataclasses import dataclass, field

@dataclass
class Point:
    x: int
    y: int
    name: str = "origin"  # 默认值
    tags: list[str] = field(default_factory=list)  # 可变默认值

# 自动生成 __init__, __repr__, __eq__ 等
point = Point(1, 2, "A")
print(point)  # Point(x=1, y=2, name='A')
```

**Java 对照**:
```java
// Java 14+ Record
record Point(int x, int y, String name) {
    Point {
        name = name == null ? "origin" : name;
    }
}
```

### 2. Pydantic（数据验证库）

本项目大量使用 Pydantic 进行数据验证和配置管理。

```python
from pydantic import BaseModel, Field, SecretStr, field_serializer

class LLMProvider(BaseModel):
    """LLM provider configuration."""
    
    type: ProviderType
    base_url: str
    api_key: SecretStr  # 敏感信息
    custom_headers: dict[str, str] | None = None
    
    @field_serializer("api_key", when_used="json")
    def dump_secret(self, v: SecretStr):
        return v.get_secret_value()

# 使用
provider = LLMProvider(
    type="kimi",
    base_url="https://api.example.com",
    api_key=SecretStr("secret-key")
)

# 自动验证
try:
    invalid_provider = LLMProvider(type="invalid")  # 会抛出 ValidationError
except ValidationError as e:
    print(e)
```

**Java 对照**:
```java
// 使用 Bean Validation (JSR 303)
class LLMProvider {
    @NotNull
    private ProviderType type;
    
    @NotBlank
    private String baseUrl;
    
    @NotNull
    private SecretStr apiKey;
    
    // getters, setters, 验证逻辑...
}
```

---

## 异常处理

### 1. 基本异常处理

```python
try:
    result = 10 / 0
except ZeroDivisionError as e:
    print(f"Error: {e}")
except Exception as e:
    print(f"Unexpected error: {e}")
else:
    print("No error occurred")
finally:
    print("Always executed")
```

**Java 对照**:
```java
try {
    int result = 10 / 0;
} catch (ArithmeticException e) {
    System.out.println("Error: " + e.getMessage());
} catch (Exception e) {
    System.out.println("Unexpected error: " + e.getMessage());
} finally {
    System.out.println("Always executed");
}
```

### 2. 自定义异常

```python
class ConfigError(Exception):
    """Configuration error."""
    pass

# 使用
if not config.is_valid():
    raise ConfigError("Invalid configuration")

# 项目中的实际例子（src/kimi_cli/exception.py）
class KimiCLIException(Exception):
    """Base exception for Kimi CLI."""
    pass

class ConfigError(KimiCLIException):
    """Configuration error."""
    pass
```

**Java 对照**:
```java
class ConfigError extends Exception {
    ConfigError(String message) {
        super(message);
    }
}

if (!config.isValid()) {
    throw new ConfigError("Invalid configuration");
}
```

### 3. 异常链

```python
try:
    process_file()
except FileNotFoundError as e:
    raise ConfigError("Config file not found") from e
```

**Java 对照**:
```java
try {
    processFile();
} catch (FileNotFoundException e) {
    throw new ConfigError("Config file not found", e);
}
```

---

## 常用标准库

### 1. pathlib（路径操作）

```python
from pathlib import Path

# 创建路径对象
config_file = Path("~/.kimi/config.json")
work_dir = Path.cwd()  # 当前目录

# 路径操作
parent = config_file.parent
name = config_file.name
suffix = config_file.suffix  # .json

# 检查路径
if config_file.exists():
    content = config_file.read_text(encoding="utf-8")

# 项目中的实际例子
config_file = get_share_dir() / "config.json"  # 路径拼接使用 /
```

**Java 对照**:
```java
import java.nio.file.Path;
import java.nio.file.Paths;

Path configFile = Paths.get(System.getProperty("user.home"), ".kimi", "config.json");
Path workDir = Paths.get(".");

if (Files.exists(configFile)) {
    String content = Files.readString(configFile);
}
```

### 2. asyncio（异步编程）

```python
import asyncio

# 创建异步任务
async def task():
    await asyncio.sleep(1)
    return "Done"

# 运行
result = await task()

# 并发执行
results = await asyncio.gather(task1(), task2(), task3())

# 超时控制
try:
    result = await asyncio.wait_for(task(), timeout=5.0)
except asyncio.TimeoutError:
    print("Task timed out")
```

### 3. json（JSON 处理）

```python
import json

# 读取 JSON
with open("config.json", encoding="utf-8") as f:
    data = json.load(f)

# 写入 JSON
with open("config.json", "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)

# 字符串转换
json_str = json.dumps(data, indent=2)
data = json.loads(json_str)
```

**Java 对照**:
```java
import com.fasterxml.jackson.databind.ObjectMapper;

ObjectMapper mapper = new ObjectMapper();
Config config = mapper.readValue(new File("config.json"), Config.class);
mapper.writeValue(new File("config.json"), config);
```

### 4. collections.abc（抽象集合）

```python
from collections.abc import Callable, Sequence, Mapping

# 类型注解中使用
def process_items(items: Sequence[str]) -> None:
    ...

def apply_func(func: Callable[[str], int], value: str) -> int:
    return func(value)
```

---

## 项目中的实际模式

### 1. 依赖注入模式

```python
# 项目中的实际例子（src/kimi_cli/soul/agent.py）
tool_deps = {
    ResolvedAgentSpec: agent_spec,
    Runtime: runtime,
    Config: runtime.config,
    Session: runtime.session,
    Approval: runtime.approval,
}

# 工具类通过构造函数接收依赖
class Bash(CallableTool2[Params]):
    def __init__(self, approval: Approval, **kwargs: Any):
        super().__init__(**kwargs)
        self._approval = approval
```

### 2. 工厂模式

```python
# 项目中的实际例子（src/kimi_cli/app.py）
class KimiCLI:
    @staticmethod
    async def create(
        session: Session,
        *,
        yolo: bool = False,
        mcp_configs: list[dict[str, Any]] | None = None,
    ) -> KimiCLI:
        # 创建和配置实例
        config = load_config(config_file)
        runtime = await Runtime.create(config, llm, session, yolo)
        agent = await load_agent(agent_file, runtime, mcp_configs=mcp_configs)
        soul = KimiSoul(agent, runtime, context=context)
        return KimiCLI(soul, runtime, env_overrides)
```

### 3. 上下文管理器模式

```python
# 项目中的实际例子（src/kimi_cli/app.py）
@contextlib.contextmanager
def _app_env(self) -> Generator[None]:
    original_cwd = Path.cwd()
    os.chdir(self._runtime.session.work_dir)
    try:
        yield
    finally:
        os.chdir(original_cwd)

# 使用
with self._app_env():
    app = ShellApp(self._soul)
    return await app.run(command)
```

**Java 对照**:
```java
try (AppEnv env = new AppEnv()) {
    ShellApp app = new ShellApp(soul);
    return app.run(command);
}
```

### 4. 策略模式（通过 Protocol）

```python
# 项目中的实际例子
class Soul(Protocol):
    name: str
    async def run(self, user_input: str) -> None: ...

class KimiSoul:
    name: str = "Kimi"
    async def run(self, user_input: str) -> None:
        ...

# 可以接受任何实现 Soul 协议的对象
def execute(soul: Soul) -> None:
    ...
```

---

## 快速参考对照表

### 类型系统

| Python | Java | 说明 |
|--------|------|------|
| `str` | `String` | 字符串 |
| `int` | `int` / `Integer` | 整数 |
| `float` | `double` / `Double` | 浮点数 |
| `bool` | `boolean` / `Boolean` | 布尔值 |
| `list[T]` | `List<T>` | 列表 |
| `dict[K, V]` | `Map<K, V>` | 字典/映射 |
| `set[T]` | `Set<T>` | 集合 |
| `tuple[T, ...]` | 无直接对应 | 元组（不可变） |
| `T | None` | `Optional<T>` | 可选类型 |
| `Callable[[T], R]` | `Function<T, R>` | 函数类型 |

### 控制流

| Python | Java |
|--------|------|
| `if/elif/else` | `if/else if/else` |
| `for item in items:` | `for (Item item : items)` |
| `while condition:` | `while (condition)` |
| `match/case` | `switch/case` (Java 14+) |
| `break` / `continue` | `break` / `continue` |

### 函数定义

| Python | Java |
|--------|------|
| `def func(param: type) -> return_type:` | `returnType func(type param)` |
| `async def func():` | `CompletableFuture<T> func()` |
| `*args` | `Type... args` |
| `**kwargs` | `Map<String, Object> kwargs` |

### 类定义

| Python | Java |
|--------|------|
| `class MyClass:` | `class MyClass` |
| `class Child(Parent):` | `class Child extends Parent` |
| `def __init__(self):` | `MyClass()` |
| `self.attr` | `this.attr` |
| `@property` | getter/setter 方法 |
| `@staticmethod` | `static` 方法 |
| `@classmethod` | `static` 方法（第一个参数是类） |

### 异常处理

| Python | Java |
|--------|------|
| `try/except/else/finally` | `try/catch/finally` |
| `raise Exception()` | `throw new Exception()` |
| `except Exception as e:` | `catch (Exception e)` |

### 常用操作

| Python | Java |
|--------|------|
| `len(list)` | `list.size()` |
| `item in list` | `list.contains(item)` |
| `list.append(item)` | `list.add(item)` |
| `dict.get(key, default)` | `map.getOrDefault(key, default)` |
| `str.format()` / `f"{var}"` | `String.format()` / `+` 拼接 |
| `list comprehension` | `Stream API` |

---

## 学习路径建议

### 第1天：基础语法
1. ✅ 变量和基本类型
2. ✅ 字符串操作
3. ✅ 列表和字典
4. ✅ 条件语句和循环

### 第2天：函数和类
1. ✅ 函数定义和调用
2. ✅ 类和对象
3. ✅ 继承和多态
4. ✅ 装饰器基础

### 第3天：类型系统和异步
1. ✅ 类型注解
2. ✅ 异步编程（async/await）
3. ✅ 异常处理
4. ✅ 标准库使用

### 第4天：项目实践
1. ✅ 阅读项目代码
2. ✅ 理解项目架构
3. ✅ 尝试小改动
4. ✅ 运行和调试

---

## 常见陷阱和注意事项

### 1. 可变默认参数

```python
# ❌ 错误：可变对象作为默认参数
def add_item(item, items=[]):
    items.append(item)
    return items

# ✅ 正确：使用 None 或 default_factory
def add_item(item, items=None):
    if items is None:
        items = []
    items.append(item)
    return items
```

### 2. 类型注解不会强制检查

```python
# 类型注解只是提示，不会在运行时检查
def add(a: int, b: int) -> int:
    return a + b

result = add("hello", "world")  # 运行时不会报错，但类型检查工具会警告
```

### 3. 异步函数必须用 await 调用

```python
# ❌ 错误：忘记 await
result = async_function()  # 返回的是协程对象，不是结果

# ✅ 正确
result = await async_function()
```

### 4. 缩进很重要

```python
# Python 使用缩进表示代码块，不是大括号
if condition:
    do_something()  # 缩进表示在 if 块内
    do_more()
else:
    do_other()  # 缩进表示在 else 块内
```

---

## 推荐资源

1. **Python 官方文档**: https://docs.python.org/3/
2. **类型注解指南**: https://docs.python.org/3/library/typing.html
3. **异步编程指南**: https://docs.python.org/3/library/asyncio.html
4. **Pydantic 文档**: https://docs.pydantic.dev/

---

**文档版本**: 1.0  
**最后更新**: 2025-01-XX  
**适用项目**: Kimi CLI

