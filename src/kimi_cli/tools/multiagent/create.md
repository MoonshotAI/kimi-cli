Create a dynamic subagent configuration on-the-fly.

**Use Case**: When you need specialized agent capabilities that aren't available in pre-configured subagents. You can define a custom system prompt tailored for specific tasks and create a subagent dynamically.

**Dynamic vs Pre-configured Subagents**:
- Dynamic subagents (created via CreateSubagent) are temporary and only exist for the current session
- Pre-configured subagents are defined in agent YAML files and persist across sessions

**Common Scenarios**:

1. Create a specialized "Java Expert" subagent when working with Java code:
    ```yaml
    name: java_expert
    system_prompt: "You are an expert Java developer specializing in Spring Boot..."
    tools: ["ReadFile", "WriteFile", "Grep", "SearchWeb", "Shell"]
    ```
2. Create a "Documentation Writer" subagent for generating documentation:
    ```yaml
    name: doc_writer
    system_prompt: "You excel at writing clear, concise technical documentation..."
    tools: ["ReadFile", "Shell", "SearchWeb"]
    ```

**Note**: The created subagent is immediately available for use with the Task tool.
