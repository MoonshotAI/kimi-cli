"""
Prompt templates for the kimi-cli Plans System.

This module contains LLM prompts for plan generation and execution.
"""

# Prompt for generating plan options based on user request and context
PLAN_GENERATION_PROMPT = """You are a planning assistant for a coding task. Analyze the user's request and generate 2-3 distinct implementation approaches.

## User Request
{user_request}

## Context
- Working Directory: {work_dir}
- Relevant Files: {files}
- Project Patterns: {patterns}

## Task
Generate 2-3 implementation options with different trade-offs. Each option should be a viable approach with realistic pros and cons.

### Option Guidelines

**Option 1: Quick Fix (approach_type: "quick")**
- Fastest implementation possible
- Minimal code changes
- May incur technical debt
- Best for urgent fixes or prototypes
- Time estimate: minutes to a few hours

**Option 2: Proper Solution (approach_type: "proper")**
- Clean, maintainable implementation
- Follows best practices and patterns
- Comprehensive testing and documentation
- Best for production code
- Time estimate: hours to days

**Option 3: Hybrid Approach (approach_type: "hybrid")** - Include only if applicable
- Balanced approach between quick and proper
- Addresses immediate needs with a path to refinement
- Moderate technical debt with mitigation plan
- Best when time is limited but quality matters
- Time estimate: between Option 1 and 2

## Output Format
Return ONLY a JSON object with no markdown formatting, no code blocks, and no additional commentary:

{{
  "options": [
    {{
      "id": 1,
      "title": "Short descriptive name",
      "description": "Detailed explanation of the approach including key steps and considerations",
      "pros": [
        "Specific advantage 1",
        "Specific advantage 2",
        "Specific advantage 3"
      ],
      "cons": [
        "Specific disadvantage 1",
        "Specific disadvantage 2",
        "Specific disadvantage 3"
      ],
      "estimated_time": "15 min",
      "approach_type": "quick"
    }},
    {{
      "id": 2,
      "title": "Short descriptive name",
      "description": "Detailed explanation of the approach including key steps and considerations",
      "pros": [
        "Specific advantage 1",
        "Specific advantage 2",
        "Specific advantage 3"
      ],
      "cons": [
        "Specific disadvantage 1",
        "Specific disadvantage 2",
        "Specific disadvantage 3"
      ],
      "estimated_time": "2 hours",
      "approach_type": "proper"
    }}
  ]
}}

## Important Rules
1. Return valid JSON only - no markdown, no code fences, no explanations
2. Each option must have a distinct approach (don't suggest 3 variations of the same thing)
3. Pros and cons must be specific to the actual task, not generic
4. Time estimates should be realistic for the described work
5. Approach types must be exactly: "quick", "proper", or "hybrid"
6. Option IDs must be sequential starting from 1
7. Include 2-3 options only - not more, not less unless context clearly suggests otherwise
8. If the task is trivial, 2 options (quick + proper) are sufficient
"""
