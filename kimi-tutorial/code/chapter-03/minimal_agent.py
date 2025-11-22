"""
第 3 章代码示例：最简单的 Agent

这是一个完整可运行的最小 Agent 实现，包含：
- LLM 集成
- 基础工具（时间、计算器）
- 主执行循环
- 上下文管理

使用方法：
    export OPENAI_API_KEY="sk-..."
    python minimal_agent.py
"""

import asyncio
import json
from datetime import datetime
from typing import Any, Dict, List
from openai import AsyncOpenAI
from pydantic import BaseModel, Field


# ==================== 工具定义 ====================

class GetTimeParams(BaseModel):
    """获取时间参数（空）"""
    pass


class GetTimeTool:
    """获取当前时间的工具"""

    name = "get_current_time"
    description = "获取当前系统时间，格式为 YYYY-MM-DD HH:MM:SS"

    @staticmethod
    def get_schema() -> dict:
        return {
            "type": "function",
            "function": {
                "name": "get_current_time",
                "description": "获取当前系统时间",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        }

    async def execute(self, params: dict) -> str:
        now = datetime.now()
        return now.strftime("%Y-%m-%d %H:%M:%S")


class CalculatorParams(BaseModel):
    """计算器参数"""
    expression: str = Field(description="要计算的数学表达式")


class CalculatorTool:
    """简单计算器工具"""

    name = "calculator"
    description = "计算数学表达式的结果，支持 +、-、*、/ 等基本运算"

    @staticmethod
    def get_schema() -> dict:
        return {
            "type": "function",
            "function": {
                "name": "calculator",
                "description": "计算数学表达式",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": {
                            "type": "string",
                            "description": "要计算的表达式"
                        }
                    },
                    "required": ["expression"]
                }
            }
        }

    async def execute(self, params: dict) -> str:
        try:
            expression = params["expression"]
            # 警告：eval 仅用于演示，生产环境应使用安全的表达式解析器
            result = eval(expression)
            return f"{expression} = {result}"
        except Exception as e:
            return f"计算错误: {str(e)}"


# 工具注册表
TOOLS = {
    "get_current_time": GetTimeTool(),
    "calculator": CalculatorTool(),
}


# ==================== Agent 核心 ====================

class MinimalAgent:
    """最简单的 Agent 实现"""

    def __init__(self, api_key: str, model: str = "gpt-4"):
        """初始化 Agent"""
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model

        # 上下文（消息历史）
        self.messages: List[Dict[str, Any]] = [
            {
                "role": "system",
                "content": self._get_system_prompt()
            }
        ]

        # 工具 schemas
        self.tool_schemas = [
            tool.get_schema() for tool in TOOLS.values()
        ]

    def _get_system_prompt(self) -> str:
        """生成系统提示词"""
        return """你是一个有用的 AI 助手。

你可以使用以下工具来帮助用户：
- get_current_time: 获取当前时间
- calculator: 计算数学表达式

请根据用户的需求，选择合适的工具来完成任务。
"""

    async def run(self, user_input: str) -> str:
        """运行 Agent，处理用户输入"""

        print(f"\n[用户] {user_input}")

        # 1. 添加用户消息
        self.messages.append({
            "role": "user",
            "content": user_input
        })

        # 2. 主循环
        max_iterations = 10  # 防止无限循环

        for iteration in range(max_iterations):
            print(f"\n--- 迭代 {iteration + 1} ---")

            # 3. 调用 LLM
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=self.messages,
                tools=self.tool_schemas,
                tool_choice="auto"
            )

            assistant_message = response.choices[0].message

            # 4. 检查是否有工具调用
            if assistant_message.tool_calls:
                print(f"🔧 Agent 想要调用 {len(assistant_message.tool_calls)} 个工具")

                # 添加 assistant 消息
                self.messages.append({
                    "role": "assistant",
                    "content": assistant_message.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": tc.type,
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments
                            }
                        }
                        for tc in assistant_message.tool_calls
                    ]
                })

                # 5. 执行所有工具调用
                for tool_call in assistant_message.tool_calls:
                    await self._execute_tool_call(tool_call)

                # 6. 继续循环
                continue

            else:
                # 7. 没有工具调用，任务完成
                final_response = assistant_message.content or ""

                # 添加到历史
                self.messages.append({
                    "role": "assistant",
                    "content": final_response
                })

                print(f"\n[Agent] {final_response}")
                return final_response

        return "达到最大迭代次数，任务可能未完成。"

    async def _execute_tool_call(self, tool_call: Any) -> None:
        """执行单个工具调用"""
        tool_name = tool_call.function.name
        tool_args = json.loads(tool_call.function.arguments)

        print(f"  → 调用工具: {tool_name}")
        print(f"     参数: {tool_args}")

        # 查找工具
        if tool_name not in TOOLS:
            result = f"错误：工具 '{tool_name}' 不存在"
        else:
            # 执行工具
            tool = TOOLS[tool_name]
            try:
                result = await tool.execute(tool_args)
                print(f"  ✓ 结果: {result}")
            except Exception as e:
                result = f"工具执行错误: {str(e)}"
                print(f"  ✗ 错误: {result}")

        # 添加工具结果到消息历史
        self.messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": result
        })

    def show_history(self) -> None:
        """显示对话历史"""
        print("\n" + "=" * 50)
        print("对话历史：")
        print("=" * 50)
        for i, msg in enumerate(self.messages):
            role = msg["role"]
            if role == "system":
                print(f"{i}. [SYSTEM] {msg['content'][:50]}...")
            elif role == "user":
                print(f"{i}. [USER] {msg['content']}")
            elif role == "assistant":
                if msg.get("tool_calls"):
                    print(f"{i}. [ASSISTANT] [工具调用]")
                else:
                    print(f"{i}. [ASSISTANT] {msg['content']}")
            elif role == "tool":
                print(f"{i}. [TOOL] {msg['content'][:50]}...")
        print("=" * 50)


# ==================== 主程序 ====================

async def main():
    """主程序"""
    import os

    # 获取 API Key
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("错误：请设置 OPENAI_API_KEY 环境变量")
        return

    print("=" * 50)
    print("欢迎使用 Minimal Agent！")
    print("=" * 50)

    # 创建 Agent
    agent = MinimalAgent(api_key=api_key, model="gpt-4")

    # 示例对话
    test_inputs = [
        "现在几点了？",
        "帮我计算 123 * 456",
        "先告诉我现在几点，然后计算 100 + 200",
    ]

    for user_input in test_inputs:
        await agent.run(user_input)
        print("\n" + "-" * 50)

    # 显示历史
    agent.show_history()


if __name__ == "__main__":
    asyncio.run(main())
