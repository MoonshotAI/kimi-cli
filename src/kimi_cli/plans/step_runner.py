from typing import TYPE_CHECKING

from kimi_cli.plans.models import PlanStep

if TYPE_CHECKING:
    from kimi_cli.llm import LLM


class StepRunner:
    """Run individual plan steps using LLM."""
    
    STEP_EXECUTION_PROMPT = """You are executing a step in a larger software development plan.

## Plan Context
{plan_description}

## Current Step to Execute
Name: {step_name}
Description: {step_description}

## Previous Steps Completed
{completed_steps}

## Instructions
Execute this step using the available tools. You can:
- Read and write files
- Run commands
- Search codebase
- Use any other available tools

Focus on completing this single step. Do not work on future steps.

## After Completion
Provide a summary in this EXACT format at the end of your response:

SUMMARY: <brief description of what was done>
FILES: <comma-separated list of modified files, or "none">
LINES_ADDED: <number>
LINES_REMOVED: <number>

Example:
SUMMARY: Created User model with email, password fields and validation methods
FILES: models/user.py
LINES_ADDED: 45
LINES_REMOVED: 0
"""
    
    def __init__(self, llm: "LLM"):
        self._llm = llm
    
    async def run(
        self,
        step: PlanStep,
        plan_description: str,
        completed_steps: list[dict],
    ) -> dict:
        """Execute step and return results.
        
        Args:
            step: The step to execute
            plan_description: Overall plan description for context
            completed_steps: List of completed step summaries
            
        Returns:
            Dict with:
            - summary: str - What was done
            - files: list[str] - Modified files
            - lines_added: int
            - lines_removed: int
        """
        # Build prompt
        completed_text = self._format_completed_steps(completed_steps)
        
        prompt = self.STEP_EXECUTION_PROMPT.format(
            plan_description=plan_description,
            step_name=step.name,
            step_description=step.description,
            completed_steps=completed_text,
        )
        
        # Call LLM
        # This should use the existing LLM infrastructure
        # For now, return a placeholder that will be replaced with actual LLM call
        response = await self._call_llm(prompt)
        
        # Parse result
        return self._parse_response(response)
    
    def _format_completed_steps(self, completed_steps: list[dict]) -> str:
        """Format completed steps for context."""
        if not completed_steps:
            return "None"
        
        lines = []
        for step in completed_steps:
            lines.append(f"- {step['name']}: {step['summary']}")
        return "\n".join(lines)
    
    async def _call_llm(self, prompt: str) -> str:
        """Call LLM with prompt.
        
        This should integrate with kimi-cli's LLM infrastructure.
        For now, placeholder that will be implemented based on actual LLM interface.
        """
        # TODO: Integrate with actual LLM
        # Options:
        # 1. Use self._llm.chat_provider.complete()
        # 2. Use existing agent loop
        # 3. Create temporary agent for step execution
        
        # Placeholder for structure
        raise NotImplementedError(
            "LLM integration needs to be implemented based on actual LLM interface. "
            "Use self._llm.chat_provider.complete() or similar."
        )
    
    def _parse_response(self, response: str) -> dict:
        """Parse LLM response for SUMMARY, FILES, LINES_*.
        
        Returns:
            Dict with summary, files, lines_added, lines_removed
        """
        result = {
            "summary": "",
            "files": [],
            "lines_added": 0,
            "lines_removed": 0,
        }
        
        lines = response.strip().split('\n')
        
        for line in lines:
            line = line.strip()
            
            if line.startswith('SUMMARY:'):
                result["summary"] = line[8:].strip()
            
            elif line.startswith('FILES:'):
                files_str = line[6:].strip()
                if files_str and files_str.lower() != 'none':
                    result["files"] = [f.strip() for f in files_str.split(',')]
            
            elif line.startswith('LINES_ADDED:'):
                try:
                    result["lines_added"] = int(line[12:].strip())
                except ValueError:
                    pass
            
            elif line.startswith('LINES_REMOVED:'):
                try:
                    result["lines_removed"] = int(line[14:].strip())
                except ValueError:
                    pass
        
        return result
