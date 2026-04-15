// Default Python → TS tool name mapping (§Q8).
//
// Source: `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/tools/*` `name: str = "…"`
// declarations. Kept intentionally conservative — only names where both sides
// exist and the semantics match get remapped. Everything else passes through
// unchanged, so unknown / future tools (including `mcp__<server>__<tool>`
// MCP names which are already identical on both sides) still round-trip.

export const DEFAULT_TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  ReadFile: 'Read',
  WriteFile: 'Write',
  StrReplaceFile: 'Edit',
  Shell: 'Bash',
  // Grep / Glob / Agent / Think / SetTodoList / TaskList / TaskOutput /
  // TaskStop / FetchURL / SearchWeb / EnterPlanMode / ExitPlanMode /
  // AskUserQuestion / ReadMediaFile / SendDMail — same name on both sides
  // or no TS equivalent yet. Pass through unchanged.
});

export function mapToolName(
  pythonName: string,
  override?: Readonly<Record<string, string>>,
): string {
  if (override !== undefined && Object.prototype.hasOwnProperty.call(override, pythonName)) {
    return override[pythonName] as string;
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_TOOL_NAME_MAP, pythonName)) {
    return DEFAULT_TOOL_NAME_MAP[pythonName] as string;
  }
  return pythonName;
}
