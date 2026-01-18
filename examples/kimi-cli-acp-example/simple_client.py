#!/usr/bin/env python3
"""
简单的 Kimi CLI ACP 客户端示例

这个示例展示了如何连接到 Kimi CLI ACP 服务器并进行基本的对话。
"""

import asyncio
import acp
from pathlib import Path


async def simple_acp_client():
    """简单的 ACP 客户端示例"""
    
    # 创建 ACP 客户端
    client = acp.Client()
    
    try:
        print("🔗 正在连接到 Kimi CLI ACP 服务器...")
        
        # 初始化连接
        init_response = await client.initialize()
        print(f"✅ 连接成功: {init_response.agent_info.name} v{init_response.agent_info.version}")
        
        # 创建会话
        session_response = await client.new_session(cwd=str(Path.cwd()))
        session_id = session_response.session_id
        print(f"📝 会话已创建: {session_id}")
        
        # 发送简单的文本提示
        print("\n🤖 发送消息: 你好，请简单介绍一下你自己")
        print("💬 响应:")
        
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
        print(f"❌ 错误: {e}")
        return False
    finally:
        await client.close()
        print("\n🔚 连接已关闭")
    
    return True


async def main():
    """主函数"""
    print("🚀 Kimi CLI ACP 简单客户端示例")
    print("=" * 50)
    
    # 检查 Kimi CLI 是否可用
    try:
        import subprocess
        result = subprocess.run(['kimi', '--version'], capture_output=True, text=True)
        if result.returncode != 0:
            print("❌ 错误: 未找到 Kimi CLI，请先安装 Kimi CLI")
            print("   安装方法: pip install kimi-cli")
            return
        print(f"📦 Kimi CLI 版本: {result.stdout.strip()}")
    except FileNotFoundError:
        print("❌ 错误: 未找到 Kimi CLI，请先安装 Kimi CLI")
        print("   安装方法: pip install kimi-cli")
        return
    
    print("\n📝 使用说明:")
    print("   这个示例将连接到 Kimi CLI ACP 服务器")
    print("   请确保在另一个终端中运行: kimi --acp")
    print("   或者配置环境变量后直接运行此脚本")
    print()
    
    # 检查环境变量
    import os
    if not os.getenv('KIMI_API_KEY'):
        print("⚠️  警告: 未设置 KIMI_API_KEY 环境变量")
        print("   请设置: export KIMI_API_KEY='your-api-key'")
        print("   或者在配置文件中配置 API 密钥")
        print()
    
    # 运行客户端
    success = await simple_acp_client()
    
    if success:
        print("\n✅ 示例运行成功！")
        print("💡 提示: 查看 advanced_client.py 了解更多高级功能")
    else:
        print("\n❌ 示例运行失败")
        print("💡 提示: 检查 Kimi CLI 是否正确安装和配置")


if __name__ == "__main__":
    asyncio.run(main())
