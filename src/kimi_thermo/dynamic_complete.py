#!/usr/bin/env python3
"""
Dynamic Complete Executor - All Official Tools Integrated
"""

import os
import json
import asyncio
import time
from typing import Dict, Optional
from openai import AsyncOpenAI
import httpx

from .tools_complete import CompleteToolRegistry, OFFICIAL_TOOLS


class DynamicCompleteClient:
    """Maximum utility with all official tools"""
    
    def __init__(self):
        self.api_key = os.getenv("MOONSHOT_API_KEY")
        if not self.api_key:
            raise ValueError("Set MOONSHOT_API_KEY")
            
        self.base_url = os.getenv("MOONSHOT_BASE_URL", "https://api.moonshot.ai/v1")
        self.client = AsyncOpenAI(base_url=self.base_url, api_key=self.api_key)
        self.http = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=120.0
        )
        
        self.registry = CompleteToolRegistry(self.http)
        self.budget = 200.0
        self.cache = {}
        
    def _estimate_query_gamma(self, query: str) -> float:
        """Estimate complexity"""
        gamma = 0.3
        
        indicators = {
            "web_search": ["search", "find", "look up", "latest", "news", "current"],
            "code_runner": ["code", "script", "program", "python", "function", "debug"],
            "excel": ["excel", "csv", "spreadsheet", "data", "analyze file"],
            "convert": ["convert", "temperature", "currency", "miles", "kg", "dollars"],
            "fetch": ["url", "website", "page", "link", "http"],
            "rethink": ["plan", "think through", "step by step", "organize", "strategy"],
            "memory": ["remember", "save this", "store", "recall", "previous"],
            "mew": ["cat", "meow", "blessing", "🐱", "cute"]
        }
        
        for tool, keywords in indicators.items():
            if any(kw in query.lower() for kw in keywords):
                gamma += OFFICIAL_TOOLS[tool].base_gamma
        
        if len(query) > 1000:
            gamma += 0.3
            
        return min(gamma, 3.0)
    
    async def execute(self, query: str, mode: str = "utility") -> Dict:
        """Execute with all tools available"""
        start = time.time()
        
        # Check cache
        cache_key = query
        if cache_key in self.cache:
            return {**self.cache[cache_key], "cached": True, "cost": 0.0}
        
        # Determine which tools to enable based on query
        gamma = self._estimate_query_gamma(query)
        
        # Always enable high-value tools, filter by query intent
        enabled_tools = ["web_search", "code_runner", "fetch", "rethink", "convert", "date", "calculate_length"]
        
        # Add conditional tools
        if any(kw in query.lower() for kw in ["excel", "csv", "file", "data"]):
            enabled_tools.append("excel")
        if any(kw in query.lower() for kw in ["remember", "save", "store"]):
            enabled_tools.append("memory")
        if any(kw in query.lower() for kw in ["choose", "random", "pick", "select"]):
            enabled_tools.append("random_choice")
        if any(kw in query.lower() for kw in ["cat", "meow", "mew", "blessing"]):
            enabled_tools.append("mew")
        if any(kw in query.lower() for kw in ["javascript", "js", "node"]):
            enabled_tools.append("quickjs")
        if any(kw in query.lower() for kw in ["encode", "decode", "base64"]):
            enabled_tools.append("base64")
        
        # Get schemas
        tools = []
        for name in enabled_tools:
            schema = self.registry.get_schema(name)
            if schema:
                tools.append(schema)
        
        # Auto-grounding if needed
        grounding = None
        if gamma > 0.8:
            try:
                result = await self.registry.execute("web_search", {"query": query[:80]})
                if result and not result.startswith("Error"):
                    grounding = result[:500]
                    gamma -= 0.2  # Reduce gamma with grounding
            except:
                pass
        
        # Configure
        configs = {
            "utility": {"temp": 0.7, "max_tokens": 64000, "thinking": True},
            "fast": {"temp": 0.3, "max_tokens": 16000, "thinking": False},
            "deep": {"temp": 1.0, "max_tokens": 128000, "thinking": True}
        }
        cfg = configs.get(mode, configs["utility"])
        
        # Build system prompt
        system_parts = [
            f"[Dynamic Complete Mode | Tools: {len(enabled_tools)} | γ={gamma:.2f}]",
            "Available tools: " + ", ".join(enabled_tools)
        ]
        if grounding:
            system_parts.append(f"\n[Grounding Context]\n{grounding[:400]}...")
        
        # Execute
        try:
            response = await self.client.chat.completions.create(
                model="kimi-k2-0905-preview",
                messages=[
                    {"role": "system", "content": "\n".join(system_parts)},
                    {"role": "user", "content": query}
                ],
                tools=tools if tools else None,
                temperature=cfg["temp"],
                max_tokens=cfg["max_tokens"],
                stream=True,
                extra_body={"thinking": {"type": "enabled"}} if cfg["thinking"] else None
            )
            
            full_response = ""
            tools_used = []
            cost = 0.0
            
            async for chunk in response:
                delta = chunk.choices[0].delta
                
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        name = tc.function.name
                        args = json.loads(tc.function.arguments)
                        
                        # Execute the tool
                        result = await self.registry.execute(name, args)
                        tools_used.append(name)
                        
                        # Add to response context
                        full_response += f"\n[{name} result: {result[:100]}...]\n"
                        
                        # Track cost
                        cost += self.registry.costs.get(name, 0.01)
                
                if delta.content:
                    full_response += delta.content
            
            # Base cost for completion
            cost += 0.002 * (len(full_response) / 1000)  # Approximate token cost
            
            # Update spent
            self.registry.total_spent += cost
            
            result = {
                "output": full_response,
                "tools_used": tools_used,
                "cost": cost,
                "total_spent": self.registry.total_spent,
                "budget_remaining": 200.0 - self.registry.total_spent,
                "time_seconds": time.time() - start,
                "cached": False
            }
            
            # Cache short results
            if len(full_response) < 8000 and not result.get("error"):
                self.cache[cache_key] = result
            
            return result
            
        except Exception as e:
            return {
                "output": f"Error: {e}",
                "error": True,
                "cost": 0.0,
                "tools_used": [],
                "total_spent": self.registry.total_spent,
                "budget_remaining": 200.0 - self.registry.total_spent,
                "time_seconds": time.time() - start,
                "cached": False
            }
    
    async def close(self):
        await self.http.aclose()
    
    def get_full_audit(self):
        """Complete audit with all tools"""
        return self.registry.get_audit_report()
