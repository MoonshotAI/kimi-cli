"""
Plan Generator - Uses LLM to generate plans with multiple implementation options.

This module provides the PlanGenerator class that formats prompts, calls the LLM,
and parses the response into structured Plan and PlanOption objects.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from kimi_cli.plans.models import Plan, PlanOption
from kimi_cli.plans.prompts import PLAN_GENERATION_PROMPT

if TYPE_CHECKING:
    from kimi_cli.llm import LLM


class PlanGenerationError(Exception):
    """Raised when plan generation fails."""
    pass


class PlanGenerator:
    """Generates plans with multiple implementation options."""
    
    def __init__(self, llm: LLM | None) -> None:
        self._llm = llm
    
    async def generate(
        self,
        user_request: str,
        work_dir: str = "",
        files: list[str] | None = None,
        patterns: list[str] | None = None,
    ) -> Plan:
        """Generate plan with 2-3 implementation options.
        
        Args:
            user_request: The original user request
            work_dir: Current working directory
            files: List of relevant files
            patterns: Code patterns to consider
            
        Returns:
            Plan with options
            
        Raises:
            PlanGenerationError: If generation fails
        """
        if self._llm is None:
            raise PlanGenerationError("LLM not configured")
        
        # Format the prompt
        prompt = PLAN_GENERATION_PROMPT.format(
            user_request=user_request,
            work_dir=work_dir,
            files=", ".join(files or []),
            patterns=", ".join(patterns or []),
        )
        
        # Call LLM using the chat_provider
        try:
            from kosong.message import Message
            from kosong.tooling.empty import EmptyToolset
            import kosong
            
            result = await kosong.step(
                chat_provider=self._llm.chat_provider,
                system_prompt="You are a planning assistant. Respond with valid JSON only.",
                toolset=EmptyToolset(),
                history=[Message(role="user", content=[{"type": "text", "text": prompt}])],
            )
        except Exception as e:
            raise PlanGenerationError(f"LLM call failed: {e}") from e
        
        # Extract text content from the response
        raw_response = ""
        for part in result.message.content:
            if hasattr(part, 'text'):
                raw_response += part.text
        
        if not raw_response.strip():
            raise PlanGenerationError("LLM returned empty response")
        
        # Parse options from the response
        options = self._parse_options(raw_response)
        
        # Create the plan
        plan = Plan(
            id=str(uuid.uuid4()),
            query=user_request,
            options=options,
            created_at=datetime.now(),
            context_snapshot={
                "work_dir": work_dir,
                "files": files or [],
                "patterns": patterns or [],
            },
        )
        
        return plan
    
    def _parse_options(self, raw_json: str) -> list[PlanOption]:
        """Parse LLM JSON response into PlanOption objects.
        
        Args:
            raw_json: The raw JSON response from the LLM
            
        Returns:
            List of PlanOption objects
            
        Raises:
            PlanGenerationError: If parsing fails
        """
        # Try to extract JSON from markdown code blocks if present
        cleaned_json = self._extract_json_from_markdown(raw_json)
        
        try:
            data = json.loads(cleaned_json)
        except json.JSONDecodeError as e:
            raise PlanGenerationError(f"Invalid JSON response: {e}") from e
        
        # Validate structure
        if not isinstance(data, dict):
            raise PlanGenerationError("Response is not a JSON object")
        
        if "options" not in data:
            raise PlanGenerationError("Response missing 'options' field")
        
        options_data = data["options"]
        if not isinstance(options_data, list):
            raise PlanGenerationError("'options' field is not a list")
        
        if len(options_data) < 2:
            raise PlanGenerationError(f"Expected at least 2 options, got {len(options_data)}")
        
        # Parse each option
        options: list[PlanOption] = []
        for i, opt_data in enumerate(options_data, start=1):
            if not isinstance(opt_data, dict):
                raise PlanGenerationError(f"Option {i} is not an object")
            
            option = self._parse_single_option(opt_data, i)
            options.append(option)
        
        return options
    
    def _extract_json_from_markdown(self, text: str) -> str:
        """Extract JSON from markdown code blocks or return as-is.
        
        Args:
            text: The raw response text
            
        Returns:
            Cleaned JSON string
        """
        # Look for JSON in markdown code blocks
        patterns = [
            r'```json\s*(.*?)\s*```',  # ```json ... ```
            r'```\s*(.*?)\s*```',       # ``` ... ```
            r'`(.*?)`',                  # `...`
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text, re.DOTALL)
            if match:
                return match.group(1).strip()
        
        # Return as-is if no markdown found
        return text.strip()
    
    def _parse_single_option(self, data: dict, expected_id: int) -> PlanOption:
        """Parse a single option dict into a PlanOption.
        
        Args:
            data: The option data dictionary
            expected_id: The expected option ID (for validation)
            
        Returns:
            PlanOption object
        """
        # Get id with fallback
        option_id = data.get("id", expected_id)
        if not isinstance(option_id, int):
            option_id = expected_id
        
        # Get title with fallback
        title = data.get("title", f"Option {option_id}")
        if not isinstance(title, str) or not title.strip():
            title = f"Option {option_id}"
        
        # Get description with fallback
        description = data.get("description", "")
        if not isinstance(description, str):
            description = str(description) if description else ""
        
        # Get pros with fallback
        pros = data.get("pros", [])
        if not isinstance(pros, list):
            pros = []
        pros = [str(p) for p in pros if p]
        
        # Get cons with fallback
        cons = data.get("cons", [])
        if not isinstance(cons, list):
            cons = []
        cons = [str(c) for c in cons if c]
        
        # Get estimated_time with fallback
        estimated_time = data.get("estimated_time")
        if estimated_time is not None and not isinstance(estimated_time, str):
            estimated_time = str(estimated_time)
        
        # Get approach_type with validation and fallback
        approach_type = data.get("approach_type", "hybrid")
        if approach_type not in ("quick", "proper", "hybrid"):
            # Try to infer from id
            if option_id == 1:
                approach_type = "quick"
            elif option_id == 2:
                approach_type = "proper"
            else:
                approach_type = "hybrid"
        
        return PlanOption(
            id=option_id,
            title=title,
            description=description,
            pros=pros,
            cons=cons,
            estimated_time=estimated_time,
            approach_type=approach_type,
        )
