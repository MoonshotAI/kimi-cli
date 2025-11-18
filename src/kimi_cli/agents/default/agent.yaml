version: 1
agent:
  name: ""
  system_prompt_path: ./system.md
  system_prompt_args:
    ROLE_ADDITIONAL: ""
  tools:
    - "kimi_cli.tools.task:Task"
    # - "kimi_cli.tools.dmail:SendDMail"
    # - "kimi_cli.tools.think:Think"
    - "kimi_cli.tools.todo:SetTodoList"
    - "kimi_cli.tools.bash:Bash"
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.file:Glob"
    - "kimi_cli.tools.file:Grep"
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    # - "kimi_cli.tools.file:PatchFile"
    - "kimi_cli.tools.web:SearchWeb"
    - "kimi_cli.tools.web:FetchURL"
  subagents:
    coder:
      path: ./sub.yaml
      description: "Good at general software engineering tasks."
