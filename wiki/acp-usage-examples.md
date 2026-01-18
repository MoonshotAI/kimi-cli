# ACP 使用示例和最佳实践

## 快速开始

### 基本启动命令

```bash
# 启动多会话 ACP 服务器（推荐用于 IDE 集成）
kimi acp

# 启动单会话 ACP 服务器（用于简单集成）
kimi --acp

# 启用调试模式
kimi --debug --acp

# 使用自定义模型和配置
kimi --acp --model gpt-4 --agent-file /path/to/custom/agent.yaml
```

### 环境变量配置

```bash
# 设置 API 配置
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
export KIMI_API_KEY="your-api-key-here"
export KIMI_MODEL_NAME="moonshot-v1-8k"

# 启动 ACP 服务器
kimi --acp
```

## IDE 集成示例

### 1. Zed 编辑器集成

#### 安装和配置

1. 安装 Zed 编辑器（支持 ACP 协议的版本）
2. 编辑配置文件 `~/.config/zed/settings.json`：

```json
{
  "agent_servers": {
    "kimi-cli": {
      "command": "kimi",
      "args": ["--acp"],
      "env": {
        "KIMI_BASE_URL": "https://api.moonshot.cn/v1",
        "KIMI_API_KEY": "your-api-key",
        "KIMI_MODEL_NAME": "moonshot-v1-8k"
      }
    }
  },
  "features": {
    "agent_integration": true
  }
}
```

#### 使用方式

- 打开 Zed 编辑器
- 使用快捷键 `Ctrl+Shift+P` (Linux/Windows) 或 `Cmd+Shift+P` (macOS)
- 搜索 "Agent" 相关命令
- 选择 "Start Agent Session" 或直接输入问题

#### 常用操作

```bash
# 代码重构
"请帮我重构这个函数，使其更加简洁和高效"

# 代码审查
"请审查这段代码，指出潜在的问题和改进建议"

# 生成测试
"为这个类编写完整的单元测试"

# 文档生成
"为这个 API 生成详细的文档注释"
```

### 2. JetBrains IDEs 集成

#### IntelliJ IDEA / PyCharm / WebStorm

1. 安装 ACP 插件（如果可用）
2. 配置 ACP 服务器：

```json
// ~/.jetbrains/acp.json
{
  "agent_servers": {
    "kimi-cli": {
      "command": "kimi",
      "args": ["--acp", "--thinking"],
      "env": {
        "KIMI_BASE_URL": "https://api.moonshot.cn/v1",
        "KIMI_API_KEY": "your-api-key"
      },
      "working_directory": "$PROJECT_DIR$"
    }
  },
  "default_server": "kimi-cli"
}
```

#### VS Code 集成

1. 安装 ACP 扩展
2. 配置 settings.json：

```json
{
  "acp.servers": {
    "kimi-cli": {
      "command": "kimi",
      "args": ["--acp"],
      "env": {
        "KIMI_BASE_URL": "https://api.moonshot.cn/v1",
        "KIMI_API_KEY": "your-api-key"
      }
    }
  },
  "acp.defaultServer": "kimi-cli"
}
```

## 编程集成示例

### Python 客户端示例

```python
import asyncio
import acp
from pathlib import Path

async def basic_acp_client():
    """基本的 ACP 客户端示例"""
    
    # 创建 ACP 客户端
    client = acp.Client()
    
    try:
        # 初始化连接
        init_response = await client.initialize()
        print(f"Connected to: {init_response.agent_info.name} v{init_response.agent_info.version}")
        
        # 创建新会话
        session_response = await client.new_session(cwd=str(Path.cwd()))
        session_id = session_response.session_id
        print(f"Created session: {session_id}")
        
        # 发送简单的文本提示
        async for chunk in client.prompt(
            prompt=[acp.schema.TextContentBlock(text="你好，请介绍一下你自己")],
            session_id=session_id,
        ):
            if hasattr(chunk, 'content') and chunk.content:
                for content_block in chunk.content:
                    if hasattr(content_block, 'text'):
                        print(content_block.text, end='')
        print()
        
    except Exception as e:
        print(f"Error: {e}")
    finally:
        await client.close()

# 运行客户端
asyncio.run(basic_acp_client())
```

### 高级 Python 客户端

```python
import asyncio
import acp
import base64
from pathlib import Path
from PIL import Image
import io

class KimiACPClient:
    def __init__(self, debug=False):
        self.client = acp.Client()
        self.session_id = None
        self.debug = debug
        
    async def connect(self, cwd=None):
        """连接到 ACP 服务器并创建会话"""
        if cwd is None:
            cwd = str(Path.cwd())
            
        # 初始化连接
        init_response = await self.client.initialize()
        if self.debug:
            print(f"Connected to: {init_response.agent_info.name}")
            
        # 创建会话
        session_response = await self.client.new_session(cwd=cwd)
        self.session_id = session_response.session_id
        
        if self.debug:
            print(f"Session created: {self.session_id}")
            
        return self.session_id
    
    async def send_text(self, text):
        """发送文本消息"""
        async for chunk in self.client.prompt(
            prompt=[acp.schema.TextContentBlock(text=text)],
            session_id=self.session_id,
        ):
            await self._process_chunk(chunk)
    
    async def send_image(self, image_path, text=None):
        """发送图像消息"""
        # 读取图像并转换为 base64
        with Image.open(image_path) as img:
            img_buffer = io.BytesIO()
            img.save(img_buffer, format='PNG')
            img_bytes = img_buffer.getvalue()
            
        img_base64 = base64.b64encode(img_bytes).decode('utf-8')
        
        content_blocks = [
            acp.schema.ImageContentBlock(
                data=img_base64,
                mime_type="image/png"
            )
        ]
        
        if text:
            content_blocks.append(
                acp.schema.TextContentBlock(text=text)
            )
            
        async for chunk in self.client.prompt(
            prompt=content_blocks,
            session_id=self.session_id,
        ):
            await self._process_chunk(chunk)
    
    async def _process_chunk(self, chunk):
        """处理响应块"""
        if hasattr(chunk, 'delta') and chunk.delta:
            # 流式文本响应
            print(chunk.delta, end='', flush=True)
        elif hasattr(chunk, 'content') and chunk.content:
            # 完整内容响应
            for content_block in chunk.content:
                if hasattr(content_block, 'text'):
                    print(content_block.text)
        elif hasattr(chunk, 'stop_reason'):
            print(f"\n[会话结束: {chunk.stop_reason}]")
    
    async def close(self):
        """关闭连接"""
        await self.client.close()

# 使用示例
async def advanced_example():
    client = KimiACPClient(debug=True)
    
    try:
        await client.connect()
        
        # 文本对话
        await client.send_text("请帮我分析这个项目的结构")
        
        # 图像分析（如果有图像文件）
        # await client.send_image("screenshot.png", "请描述这个截图的内容")
        
    finally:
        await client.close()

asyncio.run(advanced_example())
```

### Node.js 客户端示例

```javascript
const { spawn } = require('child_process');
const { Readable, Writable } = require('stream');

class KimiACPClient {
    constructor() {
        this.process = null;
        this.stdin = null;
        this.stdout = null;
        this.sessionId = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
    }
    
    async start() {
        return new Promise((resolve, reject) => {
            this.process = spawn('kimi', ['--acp'], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            this.stdin = this.process.stdin;
            this.stdout = this.process.stdout;
            
            let buffer = '';
            this.stdout.on('data', (data) => {
                buffer += data.toString();
                let lines = buffer.split('\n');
                buffer = lines.pop();
                
                lines.forEach(line => {
                    if (line.trim()) {
                        try {
                            const message = JSON.parse(line);
                            this.handleMessage(message);
                        } catch (e) {
                            console.error('Failed to parse message:', line);
                        }
                    }
                });
            });
            
            this.process.on('error', reject);
            this.process.on('close', (code) => {
                console.log(`ACP process exited with code ${code}`);
            });
            
            // 初始化连接
            this.sendRequest('initialize', {
                protocol_version: 1,
                client_capabilities: {
                    prompt_capabilities: {
                        embedded_context: false,
                        image: true,
                        audio: false
                    }
                },
                client_info: {
                    name: 'Node.js ACP Client',
                    version: '1.0.0'
                }
            }).then(resolve).catch(reject);
        });
    }
    
    sendRequest(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const message = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };
            
            this.pendingRequests.set(id, { resolve, reject });
            this.stdin.write(JSON.stringify(message) + '\n');
        });
    }
    
    handleMessage(message) {
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve, reject } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            
            if (message.error) {
                reject(new Error(message.error.message));
            } else {
                resolve(message.result);
            }
        } else if (message.method === 'session_update') {
            this.handleSessionUpdate(message.params);
        }
    }
    
    handleSessionUpdate(params) {
        console.log('Session update:', params.session_update, params);
    }
    
    async createSession(cwd = process.cwd()) {
        const response = await this.sendRequest('new_session', { cwd });
        this.sessionId = response.session_id;
        return this.sessionId;
    }
    
    async sendPrompt(text) {
        const response = await this.sendRequest('prompt', {
            prompt: [{ type: 'text', text }],
            session_id: this.sessionId
        });
        return response;
    }
    
    stop() {
        if (this.process) {
            this.process.kill();
        }
    }
}

// 使用示例
async function nodeExample() {
    const client = new KimiACPClient();
    
    try {
        await client.start();
        const sessionId = await client.createSession();
        console.log('Session created:', sessionId);
        
        const response = await client.sendPrompt('你好，请介绍一下你的功能');
        console.log('Response:', response);
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        client.stop();
    }
}

nodeExample();
```

## 实际应用场景

### 1. 代码审查助手

```python
async def code_review_assistant():
    """代码审查助手示例"""
    client = KimiACPClient(debug=True)
    
    try:
        await client.connect()
        
        review_prompt = """
        请对以下代码进行详细审查：
        
        1. 代码质量和最佳实践
        2. 潜在的 bug 和安全问题
        3. 性能优化建议
        4. 代码风格和可读性
        
        请提供具体的改进建议。
        """
        
        await client.send_text(review_prompt)
        
    finally:
        await client.close()

# 运行代码审查
asyncio.run(code_review_assistant())
```

### 2. 文档生成器

```python
async def documentation_generator():
    """API 文档生成示例"""
    client = KimiACPClient()
    
    try:
        await client.connect()
        
        doc_prompt = """
        请为以下 Python 函数生成完整的文档字符串：
        
        ```python
        def calculate_discount(price, discount_percent, min_price=0):
            """
            Calculate discounted price with minimum price constraint.
            """
            if discount_percent < 0 or discount_percent > 100:
                raise ValueError("Discount percent must be between 0 and 100")
            
            discounted_price = price * (1 - discount_percent / 100)
            return max(discounted_price, min_price)
        ```
        
        请生成符合 Google 风格的文档字符串，包括：
        - 功能描述
        - 参数说明
        - 返回值说明
        - 异常说明
        - 使用示例
        """
        
        await client.send_text(doc_prompt)
        
    finally:
        await client.close()

asyncio.run(documentation_generator())
```

### 3. 测试用例生成

```python
async def test_generator():
    """单元测试生成示例"""
    client = KimiACPClient()
    
    try:
        await client.connect()
        
        test_prompt = """
        请为以下 Python 类编写完整的单元测试：
        
        ```python
        class BankAccount:
            def __init__(self, owner, balance=0):
                self.owner = owner
                self.balance = balance
                self.transactions = []
            
            def deposit(self, amount):
                if amount <= 0:
                    raise ValueError("Deposit amount must be positive")
                self.balance += amount
                self.transactions.append(('deposit', amount))
                return self.balance
            
            def withdraw(self, amount):
                if amount <= 0:
                    raise ValueError("Withdrawal amount must be positive")
                if amount > self.balance:
                    raise ValueError("Insufficient funds")
                self.balance -= amount
                self.transactions.append(('withdraw', amount))
                return self.balance
            
            def get_balance(self):
                return self.balance
            
            def get_transaction_history(self):
                return self.transactions.copy()
        ```
        
        请使用 pytest 框架编写测试，覆盖以下场景：
        - 正常的存款和取款
        - 边界条件（0金额、大金额）
        - 异常情况（负数金额、余额不足）
        - 交易历史记录
        """
        
        await client.send_text(test_prompt)
        
    finally:
        await client.close()

asyncio.run(test_generator())
```

## 最佳实践

### 1. 性能优化

#### 连接管理

```python
# 使用连接池管理多个会话
class ACPConnectionPool:
    def __init__(self, max_connections=5):
        self.max_connections = max_connections
        self.connections = []
        self.available = []
        
    async def get_connection(self):
        if self.available:
            return self.available.pop()
        
        if len(self.connections) < self.max_connections:
            client = KimiACPClient()
            await client.connect()
            self.connections.append(client)
            return client
            
        raise Exception("Maximum connections reached")
    
    async def release_connection(self, client):
        self.available.append(client)
```

#### 批量操作

```python
async def batch_code_review(files):
    """批量代码审查"""
    client = KimiACPClient()
    
    try:
        await client.connect()
        
        for file_path in files:
            with open(file_path, 'r') as f:
                content = f.read()
            
            prompt = f"""
            请审查以下文件 {file_path}：
            
            ```python
            {content}
            ```
            
            请提供简洁的审查意见。
            """
            
            await client.send_text(prompt)
            print(f"✓ 完成审查: {file_path}")
            
    finally:
        await client.close()
```

### 2. 错误处理

```python
async def robust_acp_client():
    """健壮的 ACP 客户端实现"""
    client = KimiACPClient()
    max_retries = 3
    retry_delay = 1
    
    for attempt in range(max_retries):
        try:
            await client.connect()
            await client.send_text("测试连接")
            print("连接成功")
            break
            
        except ConnectionError as e:
            if attempt == max_retries - 1:
                raise
            print(f"连接失败，{retry_delay}秒后重试... ({attempt + 1}/{max_retries})")
            await asyncio.sleep(retry_delay)
            retry_delay *= 2
            
        except Exception as e:
            print(f"未知错误: {e}")
            raise
    
    try:
        # 正常使用客户端
        await client.send_text("你好，请介绍一下你的功能")
        
    except Exception as e:
        print(f"使用过程中出错: {e}")
        
    finally:
        await client.close()
```

### 3. 监控和日志

```python
import logging
import time
from typing import Dict, Any

class MonitoredACPClient:
    def __init__(self):
        self.client = KimiACPClient()
        self.metrics = {
            'requests': 0,
            'errors': 0,
            'total_response_time': 0
        }
        self.logger = logging.getLogger(__name__)
        
    async def send_text(self, text):
        start_time = time.time()
        self.metrics['requests'] += 1
        
        try:
            await self.client.connect()
            await self.client.send_text(text)
            
        except Exception as e:
            self.metrics['errors'] += 1
            self.logger.error(f"Request failed: {e}")
            raise
            
        finally:
            response_time = time.time() - start_time
            self.metrics['total_response_time'] += response_time
            self.logger.info(f"Request completed in {response_time:.2f}s")
    
    def get_metrics(self) -> Dict[str, Any]:
        avg_response_time = (
            self.metrics['total_response_time'] / self.metrics['requests']
            if self.metrics['requests'] > 0 else 0
        )
        
        return {
            **self.metrics,
            'average_response_time': avg_response_time,
            'error_rate': self.metrics['errors'] / self.metrics['requests'] if self.metrics['requests'] > 0 else 0
        }
```

### 4. 安全考虑

```python
import os
from pathlib import Path

class SecureACPClient:
    def __init__(self, allowed_directories=None):
        self.allowed_directories = allowed_directories or [os.getcwd()]
        self.client = KimiACPClient()
        
    def validate_directory(self, path):
        """验证工作目录是否在允许的范围内"""
        abs_path = Path(path).resolve()
        return any(
            str(abs_path).startswith(allowed_dir)
            for allowed_dir in self.allowed_directories
        )
    
    async def connect(self, cwd=None):
        """安全连接，验证工作目录"""
        if cwd and not self.validate_directory(cwd):
            raise ValueError(f"Directory not allowed: {cwd}")
            
        await self.client.connect(cwd=cwd)
    
    async def send_text(self, text):
        """发送文本前进行内容验证"""
        # 检查敏感信息
        sensitive_patterns = ['password', 'secret', 'token', 'key']
        if any(pattern in text.lower() for pattern in sensitive_patterns):
            self.logger.warning("Potentially sensitive content detected")
            
        await self.client.send_text(text)
```

## 故障排除

### 常见问题和解决方案

#### 1. 连接问题

```bash
# 检查 ACP 服务器是否正常工作
kimi --acp --debug

# 检查端口占用
lsof -i :<port>

# 测试基本连接
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_version":1}}' | kimi --acp
```

#### 2. 权限问题

```python
# 检查工作目录权限
import os
from pathlib import Path

def check_directory_permissions(path):
    """检查目录权限"""
    p = Path(path)
    
    checks = [
        (p.exists(), "目录存在"),
        (p.is_dir(), "是目录"),
        (os.access(p, os.R_OK), "可读"),
        (os.access(p, os.W_OK), "可写"),
        (os.access(p, os.X_OK), "可执行"),
    ]
    
    for check, description in checks:
        if not check:
            print(f"❌ {description}")
        else:
            print(f"✅ {description}")
            
check_directory_permissions("/path/to/work/dir")
```

#### 3. 内存和性能监控

```python
import psutil
import time

def monitor_acp_process():
    """监控 ACP 进程的资源使用"""
    # 找到 kimi 进程
    for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_percent']):
        if 'kimi' in proc.info['name']:
            print(f"PID: {proc.info['pid']}")
            print(f"CPU: {proc.info['cpu_percent']}%")
            print(f"内存: {proc.info['memory_percent']}%")
            
            # 获取详细内存信息
            try:
                memory_info = proc.memory_info()
                print(f"RSS: {memory_info.rss / 1024 / 1024:.2f} MB")
                print(f"VMS: {memory_info.vms / 1024 / 1024:.2f} MB")
            except psutil.NoSuchProcess:
                pass

# 定期监控
while True:
    monitor_acp_process()
    time.sleep(5)
```

### 调试技巧

#### 1. 启用详细日志

```bash
# 启用调试模式
kimi --debug --acp

# 设置日志级别
export KIMI_LOG_LEVEL=TRACE
kimi --acp

# 查看日志文件
tail -f ~/.kimi/logs/kimi.log
```

#### 2. 协议分析

```python
import json
import asyncio

class ACPDebugger:
    def __init__(self):
        self.messages = []
        
    async def debug_session(self):
        """调试 ACP 会话流程"""
        client = KimiACPClient()
        
        # 重写消息处理以记录所有通信
        original_handle_message = client.handleMessage
        def debug_handle_message(message):
            self.messages.append({
                'timestamp': time.time(),
                'direction': 'incoming',
                'message': message
            })
            return original_handle_message(message)
        
        client.handleMessage = debug_handle_message
        
        try:
            await client.connect()
            await client.send_text("测试消息")
            
            # 输出调试信息
            print("=== ACP 协议调试信息 ===")
            for msg in self.messages:
                print(f"[{msg['timestamp']}] {msg['direction']}:")
                print(json.dumps(msg['message'], indent=2, ensure_ascii=False))
                print()
                
        finally:
            await client.close()

asyncio.run(ACPDebugger().debug_session())
```

## 总结

ACP 集成为 Kimi CLI 提供了强大的协议支持，使其能够无缝集成到各种开发环境中。通过合理的使用和最佳实践，可以显著提升开发效率和代码质量。

### 关键要点

1. **选择合适的服务器模式**：多会话服务器用于 IDE 集成，单会话服务器用于简单场景
2. **合理配置环境变量**：通过环境变量管理 API 配置
3. **实现健壮的错误处理**：包括连接重试、异常捕获和优雅降级
4. **注意性能优化**：使用连接池、批量操作和异步处理
5. **确保安全性**：验证工作目录、检查敏感内容和限制资源使用
6. **完善的监控和调试**：记录关键指标、启用详细日志和协议分析

### 扩展建议

1. **开发专用客户端库**：为常用语言封装 ACP 客户端
2. **集成更多开发工具**：支持更多的 IDE 和编辑器
3. **增强协议功能**：支持文件传输、协作编辑等高级功能
4. **性能优化**：实现连接复用、消息压缩等优化策略
5. **安全加固**：添加认证、加密和访问控制机制

通过这些实践和示例，开发者可以充分利用 ACP 的强大功能，构建高效的 AI 辅助开发工作流。
