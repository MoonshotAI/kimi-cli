#!/usr/bin/env python3
"""
高级 Kimi CLI ACP 客户端示例

这个示例展示了如何创建一个功能完整的 ACP 客户端，包括：
- 文本和图像消息发送
- 错误处理和重试机制
- 日志记录
- 会话管理
"""

import asyncio
import acp
import base64
import logging
import os
from pathlib import Path
from PIL import Image
import io
import time

# 设置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class KimiACPClient:
    """Kimi CLI ACP 客户端封装类"""
    
    def __init__(self, debug=False, max_retries=3):
        self.client = acp.Client()
        self.session_id = None
        self.debug = debug
        self.max_retries = max_retries
        self.connection_start_time = None
        
    async def connect(self, cwd=None):
        """连接到 ACP 服务器"""
        for attempt in range(self.max_retries):
            try:
                if cwd is None:
                    cwd = str(Path.cwd())
                    
                self.connection_start_time = time.time()
                
                init_response = await self.client.initialize()
                
                if self.debug:
                    logger.info(f"连接到: {init_response.agent_info.name} v{init_response.agent_info.version}")
                    logger.info(f"协议版本: {init_response.protocol_version}")
                    logger.info(f"支持的功能: {init_response.agent_capabilities}")
                    
                session_response = await self.client.new_session(cwd=cwd)
                self.session_id = session_response.session_id
                
                connection_time = time.time() - self.connection_start_time
                if self.debug:
                    logger.info(f"会话已创建: {self.session_id}")
                    logger.info(f"连接耗时: {connection_time:.2f}秒")
                    
                return self.session_id
                
            except Exception as e:
                if attempt == self.max_retries - 1:
                    logger.error(f"连接失败，已达到最大重试次数: {e}")
                    raise
                
                retry_delay = 2 ** attempt  # 指数退避
                logger.warning(f"连接失败，{retry_delay}秒后重试... ({attempt + 1}/{self.max_retries}): {e}")
                await asyncio.sleep(retry_delay)
    
    async def send_text(self, text, stream=True):
        """发送文本消息"""
        if not self.session_id:
            raise RuntimeError("未连接到服务器，请先调用 connect()")
            
        logger.info(f"发送消息: {text[:100]}{'...' if len(text) > 100 else ''}")
        
        try:
            async for chunk in self.client.prompt(
                prompt=[acp.schema.TextContentBlock(text=text)],
                session_id=self.session_id,
            ):
                if stream:
                    await self._process_chunk(chunk)
                else:
                    yield chunk
                    
        except Exception as e:
            logger.error(f"发送消息失败: {e}")
            raise
    
    async def send_image(self, image_path, text=None, stream=True):
        """发送图像消息"""
        if not self.session_id:
            raise RuntimeError("未连接到服务器，请先调用 connect()")
            
        try:
            # 检查文件是否存在
            if not Path(image_path).exists():
                raise FileNotFoundError(f"图像文件不存在: {image_path}")
            
            # 读取并转换图像
            with Image.open(image_path) as img:
                img_buffer = io.BytesIO()
                img.save(img_buffer, format='PNG')
                img_bytes = img_buffer.getvalue()
                
                if self.debug:
                    logger.info(f"图像信息: {img.format} {img.size} {len(img_bytes)} bytes")
                    
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
                if stream:
                    await self._process_chunk(chunk)
                else:
                    yield chunk
                    
        except Exception as e:
            logger.error(f"发送图像失败: {e}")
            raise
    
    async def _process_chunk(self, chunk):
        """处理响应块"""
        if hasattr(chunk, 'delta') and chunk.delta:
            # 流式文本响应
            print(chunk.delta, end='', flush=True)
        elif hasattr(chunk, 'content') and chunk.content:
            # 完整内容响应
            for content_block in chunk.content:
                if hasattr(content_block, 'text'):
                    print(content_block.text, end='', flush=True)
                elif hasattr(content_block, 'tool_call'):
                    # 工具调用信息
                    tool_call = content_block.tool_call
                    print(f"\n🔧 工具调用: {tool_call.function.name}")
        elif hasattr(chunk, 'stop_reason'):
            print(f"\n\n🏁 会话结束: {chunk.stop_reason}")
            if chunk.stop_reason == "max_turn_requests":
                print("💡 提示: 达到最大轮次限制，可以开始新的会话")
            elif chunk.stop_reason == "cancelled":
                print("💡 提示: 会话被取消")
        elif hasattr(chunk, 'error'):
            print(f"\n❌ 错误: {chunk.error}")
    
    async def close(self):
        """关闭连接"""
        if self.client:
            await self.client.close()
            logger.info("连接已关闭")
            
        if self.connection_start_time:
            total_time = time.time() - self.connection_start_time
            logger.info(f"总连接时间: {total_time:.2f}秒")


async def interactive_demo():
    """交互式演示"""
    print("🚀 Kimi CLI ACP 高级客户端交互式演示")
    print("=" * 60)
    
    client = KimiACPClient(debug=True)
    
    try:
        await client.connect()
        
        print("\n📝 可用的命令:")
        print("  /text <message>     - 发送文本消息")
        print("  /image <path> [text] - 发送图像")
        print("  /help               - 显示帮助")
        print("  /quit               - 退出")
        print()
        
        while True:
            try:
                user_input = input("💬 > ").strip()
                
                if not user_input:
                    continue
                    
                if user_input.lower() in ['/quit', '/exit', 'quit', 'exit']:
                    break
                elif user_input.lower() in ['/help', 'help']:
                    print("📖 帮助信息:")
                    print("  /text <message>     - 发送文本消息给 AI")
                    print("  /image <path> [text] - 发送图像文件给 AI，可附带文字说明")
                    print("  /help               - 显示此帮助信息")
                    print("  /quit               - 退出程序")
                    continue
                elif user_input.startswith('/text '):
                    message = user_input[6:]  # 移除 '/text '
                    if message:
                        print("\n🤖 AI 响应:")
                        await client.send_text(message)
                        print()
                elif user_input.startswith('/image '):
                    parts = user_input[7:].split(' ', 1)  # 移除 '/image '
                    image_path = parts[0]
                    text = parts[1] if len(parts) > 1 else None
                    
                    print(f"\n🖼️  发送图像: {image_path}")
                    if text:
                        print(f"📝 附加文字: {text}")
                    print("🤖 AI 响应:")
                    
                    await client.send_image(image_path, text)
                    print()
                else:
                    # 默认作为文本消息处理
                    print("\n🤖 AI 响应:")
                    await client.send_text(user_input)
                    print()
                    
            except KeyboardInterrupt:
                print("\n👋 再见！")
                break
            except Exception as e:
                print(f"\n❌ 处理命令时出错: {e}")
                logger.exception("命令处理异常")
                
    except Exception as e:
        logger.error(f"客户端启动失败: {e}")
        print(f"❌ 无法连接到服务器: {e}")
        print("💡 请确保在另一个终端运行: kimi --acp")
        
    finally:
        await client.close()


async def batch_demo():
    """批量处理演示"""
    print("🔄 Kimi CLI ACP 批量处理演示")
    print("=" * 50)
    
    client = KimiACPClient(debug=True)
    
    try:
        await client.connect()
        
        # 批量处理任务列表
        tasks = [
            "你好，请介绍一下你的主要功能",
            "请解释什么是 Agent Client Protocol",
            "如何在 Python 中使用 ACP 协议？",
            "请给一个 ACP 集成的代码示例"
        ]
        
        for i, task in enumerate(tasks, 1):
            print(f"\n📝 任务 {i}/{len(tasks)}: {task[:50]}...")
            print("🤖 AI 响应:")
            
            try:
                await client.send_text(task)
                print(f"✅ 任务 {i} 完成")
            except Exception as e:
                print(f"❌ 任务 {i} 失败: {e}")
            
            print("-" * 40)
            
    finally:
        await client.close()


async def main():
    """主函数"""
    import sys
    
    if len(sys.argv) > 1:
        mode = sys.argv[1].lower()
        if mode == 'batch':
            await batch_demo()
        elif mode == 'interactive':
            await interactive_demo()
        else:
            print("❌ 未知模式。使用 'interactive' 或 'batch'")
    else:
        await interactive_demo()


if __name__ == "__main__":
    print("🔧 使用方法:")
    print("  python advanced_client.py interactive  # 交互式模式（默认）")
    print("  python advanced_client.py batch        # 批量处理模式")
    print()
    
    asyncio.run(main())
