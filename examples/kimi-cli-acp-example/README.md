# Kimi CLI ACP 集成示例

这个示例展示了如何使用 Kimi CLI 的 ACP（Agent Client Protocol）功能与各种客户端进行集成。

## 快速开始

### 1. 基本命令行使用

```bash
# 启动 ACP 服务器
kimi --acp

# 或使用独立的多会话服务器
kimi acp
```

### 2. 环境配置

```bash
# 设置 API 配置
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
export KIMI_API_KEY="your-api-key"
export KIMI_MODEL_NAME="moonshot-v1-8k"

# 启动服务器
kimi --acp
```

## Python 客户端示例

### 基本客户端

```python
import asyncio
import acp
from pathlib import Path

async def simple_acp_client():
    """简单的 ACP 客户端示例"""
    
    # 创建 ACP 客户端
    client = acp.Client()
    
    try:
        # 初始化连接
        init_response = await client.initialize()
        print(f"连接到: {init_response.agent_info.name} v{init_response.agent_info.version}")
        
        # 创建会话
        session_response = await client.new_session(cwd=str(Path.cwd()))
        session_id = session_response.session_id
        print(f"会话已创建: {session_id}")
        
        # 发送消息
        async for chunk in client.prompt(
            prompt=[acp.schema.TextContentBlock(text="你好，请简单介绍一下你自己")],
            session_id=session_id,
        ):
            if hasattr(chunk, 'content') and chunk.content:
                for content_block in chunk.content:
                    if hasattr(content_block, 'text'):
                        print(content_block.text, end='', flush=True)
        print()
        
    except Exception as e:
        print(f"错误: {e}")
    finally:
        await client.close()

if __name__ == "__main__":
    asyncio.run(simple_acp_client())
```

### 高级客户端类

```python
import asyncio
import acp
import base64
from pathlib import Path
from PIL import Image
import io
import logging

# 设置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class KimiACPClient:
    def __init__(self, debug=False):
        self.client = acp.Client()
        self.session_id = None
        self.debug = debug
        
    async def connect(self, cwd=None):
        """连接到 ACP 服务器"""
        if cwd is None:
            cwd = str(Path.cwd())
            
        init_response = await self.client.initialize()
        if self.debug:
            logger.info(f"连接到: {init_response.agent_info.name}")
            
        session_response = await self.client.new_session(cwd=cwd)
        self.session_id = session_response.session_id
        
        if self.debug:
            logger.info(f"会话已创建: {self.session_id}")
            
        return self.session_id
    
    async def send_text(self, text):
        """发送文本消息"""
        logger.info(f"发送消息: {text[:50]}...")
        
        async for chunk in self.client.prompt(
            prompt=[acp.schema.TextContentBlock(text=text)],
            session_id=self.session_id,
        ):
            await self._process_chunk(chunk)
    
    async def send_image(self, image_path, text=None):
        """发送图像消息"""
        try:
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
                
            logger.info(f"发送图像: {image_path}")
            
            async for chunk in self.client.prompt(
                prompt=content_blocks,
                session_id=self.session_id,
            ):
                await self._process_chunk(chunk)
                
        except Exception as e:
            logger.error(f"发送图像失败: {e}")
    
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
        logger.info("连接已关闭")

# 使用示例
async def advanced_example():
    client = KimiACPClient(debug=True)
    
    try:
        await client.connect()
        
        # 文本对话
        await client.send_text("请帮我分析一下这个 Python 项目的结构")
        
        # 如果有图像文件，可以发送图像
        # await client.send_image("screenshot.png", "请描述这个截图的内容")
        
    except Exception as e:
        logger.error(f"客户端错误: {e}")
    finally:
        await client.close()

if __name__ == "__main__":
    asyncio.run(advanced_example())
```

## 实际应用场景

### 代码审查助手

```python
async def code_review_assistant():
    """代码审查助手"""
    client = KimiACPClient(debug=True)
    
    try:
        await client.connect()
        
        # 读取要审查的代码文件
        code_file = "main.py"  # 替换为你的代码文件
        try:
            with open(code_file, 'r', encoding='utf-8') as f:
                code_content = f.read()
        except FileNotFoundError:
            logger.error(f"文件未找到: {code_file}")
            return
        
        review_prompt = f"""
        请对以下代码进行详细审查：

        文件名: {code_file}
        
        ```python
        {code_content}
        ```

        请从以下方面进行审查：
        1. 代码质量和最佳实践
        2. 潜在的 bug 和安全问题
        3. 性能优化建议
        4. 代码风格和可读性

        请提供具体的改进建议和示例代码。
        """
        
        logger.info(f"开始审查代码文件: {code_file}")
        await client.send_text(review_prompt)
        
    except Exception as e:
        logger.error(f"代码审查失败: {e}")
    finally:
        await client.close()

if __name__ == "__main__":
    asyncio.run(code_review_assistant())
```

### 文档生成器

```python
async def documentation_generator():
    """API 文档生成器"""
    client = KimiACPClient()
    
    try:
        await client.connect()
        
        doc_prompt = """
        请为以下 Python 函数生成符合 Google 风格的完整文档字符串：

        ```python
        def calculate_compound_interest(principal, annual_rate, years, compound_frequency=1):
            """
            Calculate compound interest over time.
            
            Args:
                principal (float): Initial amount of money
                annual_rate (float): Annual interest rate as decimal (e.g., 0.05 for 5%)
                years (int): Number of years to calculate
                compound_frequency (int): Number of times interest compounds per year
            
            Returns:
                float: Final amount after compound interest
            """
            if principal < 0:
                raise ValueError("Principal must be non-negative")
            if annual_rate < 0:
                raise ValueError("Annual rate must be non-negative")
            if years < 0:
                raise ValueError("Years must be non-negative")
            if compound_frequency <= 0:
                raise ValueError("Compound frequency must be positive")
            
            amount = principal * (1 + annual_rate / compound_frequency) ** (compound_frequency * years)
            return amount
        ```

        请生成包含以下内容的文档字符串：
        - 详细的功能描述
        - 完整的参数说明（包括类型和取值范围）
        - 返回值说明
        - 可能抛出的异常
        - 使用示例
        """
        
        await client.send_text(doc_prompt)
        
    except Exception as e:
        logger.error(f"文档生成失败: {e}")
    finally:
        await client.close()

if __name__ == "__main__":
    asyncio.run(documentation_generator())
```

### 测试用例生成

```python
async def test_case_generator():
    """单元测试生成器"""
    client = KimiACPClient()
    
    try:
        await client.connect()
        
        test_prompt = """
        请为以下 Python 类编写完整的 pytest 单元测试：

        ```python
        class ShoppingCart:
            def __init__(self):
                self.items = {}
                self.discounts = {}
            
            def add_item(self, item_id, name, price, quantity=1):
                if quantity <= 0:
                    raise ValueError("Quantity must be positive")
                if price < 0:
                    raise ValueError("Price cannot be negative")
                
                if item_id in self.items:
                    self.items[item_id]['quantity'] += quantity
                else:
                    self.items[item_id] = {
                        'name': name,
                        'price': price,
                        'quantity': quantity
                    }
            
            def remove_item(self, item_id, quantity=1):
                if item_id not in self.items:
                    raise KeyError("Item not found in cart")
                if quantity <= 0:
                    raise ValueError("Quantity must be positive")
                
                if quantity >= self.items[item_id]['quantity']:
                    del self.items[item_id]
                else:
                    self.items[item_id]['quantity'] -= quantity
            
            def apply_discount(self, discount_code, discount_percentage):
                if discount_percentage < 0 or discount_percentage > 100:
                    raise ValueError("Discount percentage must be between 0 and 100")
                self.discounts[discount_code] = discount_percentage
            
            def get_total(self):
                total = sum(item['price'] * item['quantity'] for item in self.items.values())
                
                # Apply the best discount
                if self.discounts:
                    best_discount = max(self.discounts.values())
                    total *= (1 - best_discount / 100)
                
                return round(total, 2)
            
            def get_item_count(self):
                return sum(item['quantity'] for item in self.items.values())
            
            def clear(self):
                self.items.clear()
                self.discounts.clear()
        ```

        请使用 pytest 框架编写测试，覆盖以下场景：
        1. 正常添加和删除商品
        2. 边界条件（0数量、负价格、大数量）
        3. 异常情况（商品不存在、无效参数）
        4. 折扣应用计算
        5. 总价计算准确性
        6. 清空购物车功能

        每个测试方法都应该有清晰的描述和断言。
        """
        
        await client.send_text(test_prompt)
        
    except Exception as e:
        logger.error(f"测试用例生成失败: {e}")
    finally:
        await client.close()

if __name__ == "__main__":
    asyncio.run(test_case_generator())
```

## IDE 集成配置

### Zed 编辑器配置

创建或编辑 `~/.config/zed/settings.json`：

```json
{
  "agent_servers": {
    "kimi-cli": {
      "command": "kimi",
      "args": ["--acp"],
      "env": {
        "KIMI_BASE_URL": "https://api.moonshot.cn/v1",
        "KIMI_API_KEY": "your-api-key-here",
        "KIMI_MODEL_NAME": "moonshot-v1-8k"
      }
    }
  },
  "features": {
    "agent_integration": true
  }
}
```

### VS Code 配置

创建或编辑 `.vscode/settings.json`：

```json
{
  "acp.servers": {
    "kimi-cli": {
      "command": "kimi",
      "args": ["--acp"],
      "env": {
        "KIMI_BASE_URL": "https://api.moonshot.cn/v1",
        "KIMI_API_KEY": "your-api-key-here"
      }
    }
  },
  "acp.defaultServer": "kimi-cli"
}
```

## 运行示例

### 安装依赖

```bash
# 安装 Python 依赖
pip install agent-client-protocol pillow

# 或使用项目环境
uv sync
```

### 运行示例

```bash
# 运行基本客户端
python simple_client.py

# 运行高级客户端
python advanced_client.py

# 运行代码审查
python code_review.py

# 运行文档生成
python documentation_generator.py

# 运行测试用例生成
python test_generator.py
```

## 故障排除

### 常见问题

1. **连接失败**
   ```bash
   # 检查 Kimi CLI 是否正确安装
   kimi --version
   
   # 检查 ACP 服务器是否正常启动
   kimi --debug --acp
   ```

2. **API 配置错误**
   ```bash
   # 检查环境变量
   echo $KIMI_API_KEY
   echo $KIMI_BASE_URL
   
   # 测试 API 连接
   kimi --model moonshot-v1-8k "测试连接"
   ```

3. **依赖问题**
   ```bash
   # 重新安装依赖
   pip install --upgrade agent-client-protocol pillow
   
   # 或使用项目环境
   uv sync --reinstall
   ```

### 调试技巧

```python
# 启用详细日志
import logging
logging.basicConfig(level=logging.DEBUG)

# 使用调试模式启动客户端
client = KimiACPClient(debug=True)

# 启动服务器时使用调试模式
# 在终端中运行: kimi --debug --acp
```

## 扩展功能

### 自定义工具集成

```python
async def custom_tools_example():
    """自定义工具使用示例"""
    client = KimiACPClient(debug=True)
    
    try:
        await client.connect()
        
        custom_prompt = """
        请使用以下工具完成任务：
        
        1. 使用 Glob 工具查找所有的 Python 文件
        2. 使用 Grep 工具搜索包含 "TODO" 的行
        3. 使用 SetTodoList 工具创建一个任务列表
        
        请逐步执行并报告结果。
        """
        
        await client.send_text(custom_prompt)
        
    except Exception as e:
        logger.error(f"自定义工具使用失败: {e}")
    finally:
        await client.close()

if __name__ == "__main__":
    asyncio.run(custom_tools_example())
```

### 多轮对话

```python
async def conversation_example():
    """多轮对话示例"""
    client = KimiACPClient(debug=True)
    
    try:
        await client.connect()
        
        # 第一轮对话
        await client.send_text("你好，我想学习如何使用 Kimi CLI 的 ACP 功能")
        
        # 等待用户输入
        input("按回车键继续下一轮对话...")
        
        # 第二轮对话
        await client.send_text("请给我一些具体的代码示例")
        
        # 第三轮对话
        input("按回车键继续下一轮对话...")
        await client.send_text("这些示例中有什么需要注意的地方吗？")
        
    except Exception as e:
        logger.error(f"多轮对话失败: {e}")
    finally:
        await client.close()

if __name__ == "__main__":
    asyncio.run(conversation_example())
```

## 总结

这个示例展示了 Kimi CLI ACP 功能的强大之处：

1. **标准化协议**: 使用 ACP 协议确保与各种客户端的兼容性
2. **流式响应**: 支持实时的流式消息传输
3. **多模态支持**: 支持文本、图像等多种输入格式
4. **工具集成**: 可以调用各种内置工具执行复杂任务
5. **会话管理**: 支持多会话管理和持久化

通过这些示例，你可以快速上手 Kimi CLI 的 ACP 功能，并将其集成到自己的开发工作流中。
