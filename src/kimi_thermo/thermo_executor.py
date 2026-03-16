#!/usr/bin/env python3
"""
Canonical Thermodynamic Executor (T* Framework)
T* = (L - γ) / (|L| + λ)
"""

import os
import json
import asyncio
from typing import Dict, Optional
from dataclasses import dataclass
from enum import Enum
from openai import AsyncOpenAI
import httpx


class Regime(Enum):
    ACT = "ACT"
    HOLD = "HOLD"
    REFUSE = "REFUSE"


@dataclass
class ThermoState:
    L: float = 1.5
    gamma: float = 0.5
    lam: float = 0.1
    T_star: float = 0.0

    def compute(self) -> float:
        denom = abs(self.L) + self.lam
        self.T_star = (self.L - self.gamma) / denom if denom != 0 else float('-inf')
        return self.T_star

    def classify(self) -> Regime:
        t = self.compute()
        if t > 0:
            return Regime.ACT
        elif t > -1:
            return Regime.HOLD
        else:
            return Regime.REFUSE


class WorklessClient:
    """Zero user work. System manages T* regime."""

    def __init__(self):
        self.api_key = os.getenv("MOONSHOT_API_KEY")
        self.base_url = os.getenv("MOONSHOT_BASE_URL", "https://api.moonshot.ai/v1")
        self.client = AsyncOpenAI(base_url=self.base_url, api_key=self.api_key)
        self.http = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=60.0
        )
        self.history = []
        self.entropy_budget = 100.0
        self.current_entropy = 0.0

    def _estimate_gamma(self, query: str) -> float:
        gamma = 0.3
        if len(query) > 1000:
            gamma += 0.3
        if any(w in query.lower() for w in ["why", "how", "explain", "compare"]):
            gamma += 0.2
        if "?" in query:
            gamma += 0.1
        return min(gamma, 2.0)

    async def execute(self, query: str, mode: str = "auto") -> Dict:
        # Auto-estimate thermodynamic state
        gamma = self._estimate_gamma(query)
        state = ThermoState(gamma=gamma)

        # Adjust L based on history
        if self.history:
            recent_success = sum(1 for h in self.history[-3:] if h.get("success"))
            state.L = 0.5 + (recent_success / 3) * 1.5

        T_star = state.compute()

        # REFUSE check (canonical)
        if T_star <= -1:
            return {
                "regime": "REFUSE",
                "T_star": T_star,
                "output": f"REFUSE: Query requires γ={gamma:.2f} but L={state.L:.2f}. Simplify or provide grounding.",
                "workless": True
            }

        # HOLD: Auto-ground
        grounding = None
        if -1 < T_star <= 0:
            grounding = await self._auto_ground(query)
            if grounding:
                state.L = min(2.0, state.L + 0.3)
                T_star = state.compute()

        # Auto-configure per mode
        if mode == "benchmark":
            temp, top_p = 1.0, 0.95
            max_tokens = 128000
        else:
            temp = max(0.1, min(1.0, (T_star + 1) / 2))
            top_p = 0.95
            max_tokens = 8192 if T_star > 0.5 else 4096

        # Execute with thermodynamic system prompt
        system = self._assemble_prompt(T_star, grounding)

        try:
            response = await self.client.chat.completions.create(
                model="kimi-k2-0905-preview",
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": query}
                ],
                temperature=temp,
                top_p=top_p,
                max_tokens=max_tokens,
                stream=True
            )

            full_response = ""
            async for chunk in response:
                delta = chunk.choices[0].delta
                if delta.content:
                    full_response += delta.content

            # Update thermodynamics
            success = len(full_response) > 50
            state.L = state.L * 1.05 if success else state.L * 0.95
            entropy = state.L - gamma
            self.current_entropy += max(0, -entropy)

            self.history.append({"success": success, "T_star": T_star})

            return {
                "output": full_response,
                "regime": "ACT" if T_star > 0 else "HOLD",
                "T_star": T_star,
                "entropy": self.current_entropy,
                "workless": True
            }

        except Exception as e:
            return {"regime": "ERROR", "output": str(e), "workless": True}

    async def _auto_ground(self, query: str) -> Optional[str]:
        try:
            resp = await self.http.post(
                "/formulas/moonshot/web-search:latest/fibers",
                json={"name": "web_search", "arguments": json.dumps({"query": query[:100]})}
            )
            if resp.json().get("status") == "succeeded":
                return resp.json()["context"].get("output", "")[:500]
        except:
            pass
        return None

    def _assemble_prompt(self, T_star: float, grounding: str) -> str:
        parts = [f"Thermodynamic regime: T*={T_star:.2f}"]
        if grounding:
            parts.append(f"Grounding: {grounding[:200]}")
        if T_star < 0.3:
            parts.append("CAUTION: Low coherence. Conservative answers only.")
        return "\n".join(parts)
