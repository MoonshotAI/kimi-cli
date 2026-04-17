---
'@moonshot-ai/core': minor
'@moonshot-ai/cli': patch
---

feat(core): wire AgentTool (Task tool) end-to-end

- Add optional `agentTypeRegistry` to `CreateSessionOptions` /
  `ResumeSessionOptions`; when provided, `SessionManager` builds a
  per-session `SubagentStore` and `SoulPlus` registers the `Agent`
  collaboration tool.
- Call `cleanupStaleSubagents` on `resumeSession` to mark residual
  `status='running'` subagent records as `'lost'` (v2 §8.2).
- Export `getBundledAgentYamlPath` helper so embedders can locate the
  default agent.yaml in both dev and bundled (`dist/`) layouts.
- Ship `agents/` in the published tarball so the helper resolves
  against the on-disk YAMLs after install.
