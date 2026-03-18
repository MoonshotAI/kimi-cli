#!/usr/bin/env python3
"""
Complete Official Tool Registry - All Moonshot Formula Tools
Handles encrypted_output vs output per official spec
"""

import json
import asyncio
from typing import Dict, Any, Optional, List
from dataclasses import dataclass
import httpx


@dataclass
class ToolMetadata:
    name: str
    description: str
    base_gamma: float
    formula_uri: str
    protected: bool = False  # If True, returns encrypted_output


OFFICIAL_TOOLS = {
    # Web & Information
    "web_search": ToolMetadata(
        name="web_search",
        description="Real-time information and internet search tool",
        base_gamma=0.8,
        formula_uri="moonshot/web-search:latest",
        protected=True  # Returns encrypted_output
    ),
    "fetch": ToolMetadata(
        name="fetch",
        description="URL content extraction as Markdown formatting",
        base_gamma=0.6,
        formula_uri="moonshot/fetch:latest",
        protected=False
    ),
    
    # Computation & Execution
    "code_runner": ToolMetadata(
        name="code_runner",
        description="Python code execution tool with print capture and error handling",
        base_gamma=0.5,
        formula_uri="moonshot/code_runner:latest",
        protected=False
    ),
    "quickjs": ToolMetadata(
        name="quickjs",
        description="Quick JS engine security execution JavaScript code tool",
        base_gamma=0.5,
        formula_uri="moonshot/quickjs:latest",
        protected=False
    ),
    
    # Data Processing
    "excel": ToolMetadata(
        name="excel",
        description="Excel and CSV file analysis tool",
        base_gamma=0.4,
        formula_uri="moonshot/excel:latest",
        protected=False
    ),
    "base64": ToolMetadata(
        name="base64",
        description="Base64 encoding and decoding tool",
        base_gamma=0.05,
        formula_uri="moonshot/base64:latest",
        protected=False
    ),
    
    # Utilities
    "convert": ToolMetadata(
        name="convert",
        description="Unit conversion: length, mass, volume, temperature, area, time, energy, pressure, speed, currency",
        base_gamma=0.1,
        formula_uri="moonshot/convert:latest",
        protected=False
    ),
    "date": ToolMetadata(
        name="date",
        description="Date and time processing, timezone conversion, calculation",
        base_gamma=0.1,
        formula_uri="moonshot/date:latest",
        protected=False
    ),
    "calculate_length": ToolMetadata(
        name="calculate_length",
        description="Calculate the length of input text",
        base_gamma=0.05,
        formula_uri="moonshot/calculate_length:latest",
        protected=False
    ),
    
    # Reasoning & Memory
    "rethink": ToolMetadata(
        name="rethink",
        description="Intelligent reasoning tool for organizing thoughts and planning",
        base_gamma=0.1,
        formula_uri="moonshot/rethink:latest",
        protected=False
    ),
    "memory": ToolMetadata(
        name="memory",
        description="Memory storage and retrieval system for conversation history",
        base_gamma=0.3,
        formula_uri="moonshot/memory:latest",
        protected=False
    ),
    
    # Selection & Fun
    "random_choice": ToolMetadata(
        name="random_choice",
        description="Random selection tool with weights and replacement options",
        base_gamma=0.2,
        formula_uri="moonshot/random-choice:latest",
        protected=False
    ),
    "mew": ToolMetadata(
        name="mew",
        description="Random cat meowing and blessing tool",
        base_gamma=0.05,  # Very low, just for fun
        formula_uri="moonshot/mew:latest",
        protected=False
    ),
}


class CompleteToolRegistry:
    """Official Formula Tool Registry with T* tracking"""
    
    def __init__(self, http_client: httpx.AsyncClient):
        self.http = http_client
        self.tool_states = {
            name: {"L": 1.5, "gamma": meta.base_gamma, "T_star": 0.0, "calls": 0, "spent": 0.0}
            for name, meta in OFFICIAL_TOOLS.items()
        }
        self.total_spent = 0.0
        
        # Cost tracking (estimated USD per call)
        self.costs = {
            "web_search": 0.02,
            "fetch": 0.01,
            "code_runner": 0.01,
            "quickjs": 0.01,
            "excel": 0.01,
            "memory": 0.005,
            "convert": 0.001,
            "date": 0.001,
            "base64": 0.001,
            "calculate_length": 0.001,
            "rethink": 0.001,
            "random_choice": 0.001,
            "mew": 0.001,
        }
    
    def get_schema(self, tool_name: str) -> Optional[Dict]:
        """Generate OpenAI-compatible function schema"""
        meta = OFFICIAL_TOOLS.get(tool_name)
        if not meta:
            return None
        
        schemas = {
            "web_search": {
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": meta.description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "What to search for"},
                            "classes": {
                                "type": "array",
                                "items": {
                                    "enum": ["all", "academic", "social", "library", "finance", "code", "ecommerce", "medical"],
                                    "type": "string"
                                },
                                "description": "Search domains to focus on"
                            }
                        },
                        "required": ["query"]
                    }
                }
            },
            "fetch": {
                "type": "function",
                "function": {
                    "name": "fetch",
                    "description": meta.description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "url": {"type": "string", "format": "uri", "description": "URL to fetch"},
                            "max_length": {"type": "integer", "default": 5000, "description": "Max characters to return"},
                            "raw": {"type": "boolean", "default": False, "description": "Get raw HTML without simplification"},
                            "start_index": {"type": "integer", "default": 0}
                        },
                        "required": ["url"]
                    }
                }
            },
            "code_runner": {
                "type": "function",
                "function": {
                    "name": "code_runner",
                    "description": meta.description + "\nFeatures: print() captured, last expression returned, syntax errors detailed, timeout protection, variables persist across calls, ctx.read_object() for files, matplotlib support",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "code": {"type": "string", "description": "Python code to execute"}
                        },
                        "required": ["code"]
                    }
                }
            },
            "quickjs": {
                "type": "function",
                "function": {
                    "name": "quickjs",
                    "description": meta.description + "\nFeatures: console.log captured, last expression returned, ES6+ support, ctx.log() for Python host logging, variables persist across calls",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "code": {"type": "string", "description": "JavaScript code to execute"}
                        },
                        "required": ["code"]
                    }
                }
            },
            "excel": {
                "type": "function",
                "function": {
                    "name": "excel",
                    "description": meta.description + "\nSupports .xlsx, .xls, .csv analysis",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "file_path": {"type": "string", "description": "Path to Excel/CSV file"},
                            "operation": {"type": "string", "enum": ["read", "analyze", "convert"], "default": "read"},
                            "sheet": {"type": "string", "description": "Sheet name or index"}
                        },
                        "required": ["file_path"]
                    }
                }
            },
            "convert": {
                "type": "function",
                "function": {
                    "name": "convert",
                    "description": meta.description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "value": {"type": "number", "description": "Value to convert"},
                            "from_unit": {"type": "string", "description": "Source unit (m, kg, °C, USD, J, Pa, etc.)"},
                            "to_unit": {"type": "string", "description": "Target unit"}
                        },
                        "required": ["value", "from_unit", "to_unit"]
                    }
                }
            },
            "date": {
                "type": "function",
                "function": {
                    "name": "date",
                    "description": meta.description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "operation": {"type": "string", "enum": ["time", "convert", "between", "add", "subtract"], "description": "Operation type"},
                            "date": {"type": "string", "description": "Date string (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)"},
                            "date1": {"type": "string", "description": "First date for difference"},
                            "date2": {"type": "string", "description": "Second date for difference"},
                            "days": {"type": "integer", "description": "Days to add/subtract"},
                            "zone": {"type": "string", "description": "Timezone (e.g., Asia/Shanghai)"},
                            "from_zone": {"type": "string"},
                            "to_zone": {"type": "string"},
                            "format": {"type": "string", "default": "%Y-%m-%d %H:%M:%S"}
                        },
                        "required": ["operation"]
                    }
                }
            },
            "base64": {
                "type": "function",
                "function": {
                    "name": "base64",
                    "description": meta.description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "enum": ["encode", "decode"], "description": "Encode or decode"},
                            "data": {"type": "string", "description": "Text to encode or base64 to decode"},
                            "encoding": {"type": "string", "default": "utf-8"}
                        },
                        "required": ["action", "data"]
                    }
                }
            },
            "rethink": {
                "type": "function",
                "function": {
                    "name": "rethink",
                    "description": meta.description + "\nUse for: listing rules, making plans, organizing thoughts, step-by-step thinking, pausing to reflect. Does not return info, just organizes your reasoning.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "thought": {"type": "string", "description": "The thought to organize and structure"}
                        },
                        "required": ["thought"]
                    }
                }
            },
            "memory": {
                "type": "function",
                "function": {
                    "name": "memory",
                    "description": meta.description + "\nTTL default 86400 seconds (24 hours)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "enum": ["store", "retrieve", "delete", "list"], "description": "Operation type"},
                            "key": {"type": "string", "description": "Storage key name"},
                            "data": {"type": "object", "description": "Data to store"},
                            "prefix": {"type": "string", "description": "Key prefix for list operation"},
                            "ttl": {"type": "integer", "default": 86400, "description": "Expiration time in seconds"}
                        },
                        "required": ["action"]
                    }
                }
            },
            "random_choice": {
                "type": "function",
                "function": {
                    "name": "random_choice",
                    "description": meta.description + "\nSupports weighted selection, with/without replacement, seed for reproducibility",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "candidates": {"type": "array", "items": {"type": "string"}, "description": "List of candidates"},
                            "count": {"type": "integer", "default": 1, "description": "Number to select"},
                            "replace": {"type": "boolean", "default": False, "description": "Allow duplicates"},
                            "weights": {"type": "array", "items": {"type": "number"}, "description": "Weights for each candidate"},
                            "seed": {"type": "integer", "description": "Random seed for reproducibility"},
                            "format": {"type": "string", "enum": ["simple", "detailed", "json"], "default": "simple"}
                        },
                        "required": ["candidates"]
                    }
                }
            },
            "calculate_length": {
                "type": "function",
                "function": {
                    "name": "calculate_length",
                    "description": meta.description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string", "description": "Text to measure"}
                        },
                        "required": ["text"]
                    }
                }
            },
            "mew": {
                "type": "function",
                "function": {
                    "name": "mew",
                    "description": meta.description + "\n🐱 Random cat meowing and blessing",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "count": {"type": "integer", "default": 1, "description": "Number of meows"},
                            "blessing": {"type": "boolean", "default": True, "description": "Include blessing"}
                        }
                    }
                }
            },
        }
        
        return schemas.get(tool_name)
    
    def compute_t_star(self, tool_name: str, context_gamma: float = 0.0) -> float:
        """Compute T* for specific tool"""
        state = self.tool_states[tool_name]
        total_gamma = state["gamma"] + context_gamma
        lam = 0.1 + (state["calls"] * 0.01)
        t_star = (state["L"] - total_gamma) / (abs(state["L"]) + lam)
        state["T_star"] = t_star
        return t_star
    
    def update_from_result(self, tool_name: str, success: bool, cost: float):
        """Update thermodynamic state and spending"""
        state = self.tool_states[tool_name]
        
        if success:
            state["L"] = min(2.5, state["L"] * 1.05)
            state["gamma"] = max(0.05, state["gamma"] * 0.95)
        else:
            state["L"] = max(0.8, state["L"] * 0.9)
            state["gamma"] = min(3.0, state["gamma"] * 1.1)
        
        state["calls"] += 1
        state["spent"] += cost
        self.total_spent += cost
        
        entropy = state["L"] - state["gamma"]
        return max(0, -entropy)  # Return entropy produced
    
    async def execute(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """Execute tool via Formula Fiber API with proper output handling"""
        meta = OFFICIAL_TOOLS.get(tool_name)
        if not meta:
            raise ValueError(f"Unknown tool: {tool_name}")
        
        # Check T* before execution
        t_star = self.compute_t_star(tool_name)
        if t_star <= -1:
            return f"TOOL_REFUSE: {tool_name} in collapse (T*={t_star:.2f})"
        
        # Get cost
        cost = self.costs.get(tool_name, 0.01)
        
        try:
            resp = await self.http.post(
                f"/formulas/{meta.formula_uri}/fibers",
                json={"name": tool_name, "arguments": json.dumps(arguments)},
                timeout=60.0
            )
            fiber = resp.json()
            
            # Handle response per official spec
            if fiber.get("status") == "succeeded":
                # Check for encrypted_output (protected tools) or output
                if meta.protected and "encrypted_output" in fiber.get("context", {}):
                    result = fiber["context"]["encrypted_output"]
                else:
                    result = fiber["context"].get("output", "")
                
                self.update_from_result(tool_name, True, cost)
                return result
                
            else:
                # Handle errors per spec
                if "error" in fiber:
                    error_msg = fiber["error"]
                elif "error" in fiber.get("context", {}):
                    error_msg = fiber["context"]["error"]
                else:
                    error_msg = "Unknown error"
                
                self.update_from_result(tool_name, False, cost)
                return f"Error: {error_msg}"
            
        except Exception as e:
            self.update_from_result(tool_name, False, cost)
            raise
    
    def get_all_schemas(self) -> List[Dict]:
        """Get all tool schemas"""
        return [
            self.get_schema(name) 
            for name in OFFICIAL_TOOLS.keys() 
            if self.get_schema(name)
        ]
    
    def get_tool_costs(self) -> Dict[str, float]:
        """Get cost breakdown"""
        return {
            name: {
                "per_call": self.costs.get(name, 0.01),
                "total_spent": state["spent"],
                "calls": state["calls"],
                "avg_cost": state["spent"] / max(1, state["calls"])
            }
            for name, state in self.tool_states.items()
        }
    
    def get_audit_report(self) -> Dict:
        """Full audit with costs"""
        return {
            "total_spent_usd": self.total_spent,
            "budget_remaining": 200.0 - self.total_spent,
            "tool_breakdown": self.get_tool_costs(),
            "thermodynamic_states": {
                name: {
                    "L": state["L"],
                    "gamma": state["gamma"],
                    "T_star": state["T_star"],
                    "regime": "ACT" if state["T_star"] > 0 else "HOLD" if state["T_star"] > -1 else "REFUSE"
                }
                for name, state in self.tool_states.items()
            }
        }
