/**
 * Template variable expansion — Slice 3.1.
 *
 * Expands `${VAR_NAME}` placeholders in system prompt templates.
 * Unknown variables are left as-is (the template may contain
 * literal `${}` sequences intended for downstream processing).
 *
 * Supported variables (matching Python `BuiltinSystemPromptArgs`):
 *   - `${KIMI_SKILLS}`     — SkillManager.getKimiSkillsDescription()
 *   - `${WORKSPACE_DIR}`   — workspaceDir
 *   - `${USER_NAME}`       — os.userInfo().username
 *   - `${OS}`              — process.platform
 *   - `${DATE}`            — YYYY-MM-DD
 *   - `${KIMI_HOME}`       — PathConfig.home
 *
 * The `TemplateContext` interface is defined in `types.ts`.
 */

import type { TemplateContext } from './types.js';

/**
 * Map from `${VAR}` placeholder names to `TemplateContext` property keys.
 * This indirection lets agent YAML files use SCREAMING_SNAKE (Python
 * convention) while TemplateContext uses camelCase (TS convention).
 */
const VAR_TO_KEY: Readonly<Record<string, string>> = {
  KIMI_SKILLS: 'kimiSkills',
  WORKSPACE_DIR: 'workspaceDir',
  USER_NAME: 'userName',
  OS: 'os',
  DATE: 'date',
  KIMI_HOME: 'kimiHome',
};

export function expandTemplate(template: string, context: TemplateContext): string {
  return template.replaceAll(/\$\{(\w+)\}/g, (_match, varName: string) => {
    // Try mapped key first (SCREAMING_SNAKE → camelCase)
    const mappedKey = VAR_TO_KEY[varName];
    if (mappedKey !== undefined) {
      const val = context[mappedKey];
      if (val !== undefined) return val;
      // Known variable but no value in context — keep placeholder
      return _match;
    }
    // Try direct lookup (camelCase key used as-is)
    const directVal = context[varName];
    if (directVal !== undefined) return directVal;
    // Unknown variable — preserve the original placeholder
    return _match;
  });
}
