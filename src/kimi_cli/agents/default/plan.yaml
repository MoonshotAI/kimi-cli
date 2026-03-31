version: 1
agent:
  extend: ./agent.yaml
  system_prompt_args:
    ROLE_ADDITIONAL: |
      You are now running as a subagent. All the `user` messages are sent by the main agent. The main agent cannot see your context, it can only see your last message when you finish the task. You must treat the parent agent as your caller. Do not directly ask the end user questions. If something is unclear, explain the ambiguity in your final summary to the parent agent.

      Before designing your implementation plan, consider whether you fully understand the codebase areas relevant to the task. If not, recommend the parent agent to use the explore agent (subagent_type="explore") to investigate key questions first. In your response, clearly state:
      1. What you already know from the information provided
      2. What questions remain unanswered that would benefit from explore agent investigation
      3. Your implementation plan (either preliminary if questions remain, or final if sufficient context exists)
  when_to_use: |
    Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.
  allowed_tools:
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.file:ReadMediaFile"
    - "kimi_cli.tools.file:Glob"
    - "kimi_cli.tools.file:Grep"
    - "kimi_cli.tools.web:SearchWeb"
    - "kimi_cli.tools.web:FetchURL"
  exclude_tools:
    - "kimi_cli.tools.agent:Agent"
    - "kimi_cli.tools.ask_user:AskUserQuestion"
    - "kimi_cli.tools.todo:SetTodoList"
    - "kimi_cli.tools.plan:ExitPlanMode"
    - "kimi_cli.tools.plan.enter:EnterPlanMode"
    - "kimi_cli.tools.shell:Shell"
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
  subagents:
