Create a custom subagent with specific system prompt and name for reuse.

Usage:
- Define specialized agents with custom roles and boundaries
- Created agents can be referenced by name in the Task tool
- Use this when you need a specific agent type not covered by predefined agents
- The created agent configuration will be saved and can be used immediately

Example workflow:
1. Use CreateSubagent to define a specialized agent (e.g., 'code_reviewer')
2. Use the Task tool with agent='code_reviewer' to launch the created agent
