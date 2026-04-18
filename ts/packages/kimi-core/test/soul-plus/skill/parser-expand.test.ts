/**
 * Skill parameter expansion — Phase 18 Section C.2 tests.
 *
 * Pins the template-variable expansion contract declared by
 * v2 §15.3. `expandSkillParameters` (to be implemented in
 * `src/soul-plus/skill/parser.ts`) takes a skill body, the raw user
 * args string, and a context (skill directory, session id, skill-
 * declared argument names) and returns the body with placeholders
 * expanded:
 *
 *   | Variable            | Expands to                              |
 *   | ------------------- | --------------------------------------- |
 *   | `$ARGUMENTS`        | Full user-supplied args string          |
 *   | `$1`, `$2`, ...     | Positional tokens (shell-ish)           |
 *   | `$arg_name`         | Named arg (declared in frontmatter)     |
 *   | `${KIMI_SKILL_DIR}` | Directory containing SKILL.md           |
 *   | `${KIMI_SESSION_ID}`| Current session ID                      |
 *
 * Edge cases:
 *   - undefined variables remain as-is (defense in depth; §15.3 does
 *     not mandate error semantics for unknowns in Phase 1)
 *   - escaped `\$1` preserves the literal `$1`
 *   - positional tokens respect quoted strings
 *
 * These tests are RED until C.2 is implemented.
 */

import { describe, expect, it } from 'vitest';

// Symbol is added in Phase 18 C.2 implementation.
import { expandSkillParameters } from '../../../src/soul-plus/skill/parser.js';

interface ExpandContext {
  readonly skillDir: string;
  readonly sessionId: string;
  readonly argumentNames?: readonly string[];
}

describe('expandSkillParameters — $ARGUMENTS', () => {
  it('replaces $ARGUMENTS with the full raw args string', () => {
    const body = 'Commit message: $ARGUMENTS';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      '-m "fix login bug"',
      { skillDir: '/tmp/skills/commit', sessionId: 'ses_1' },
    );
    expect(out).toBe('Commit message: -m "fix login bug"');
  });

  it('replaces $ARGUMENTS multiple times in the body', () => {
    const body = 'First: $ARGUMENTS. Again: $ARGUMENTS.';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      'hello',
      { skillDir: '/x', sessionId: 's' },
    );
    expect(out).toBe('First: hello. Again: hello.');
  });

  it('replaces $ARGUMENTS with empty string when args is empty', () => {
    const body = 'args=[$ARGUMENTS]';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      '',
      { skillDir: '/x', sessionId: 's' },
    );
    expect(out).toBe('args=[]');
  });
});

describe('expandSkillParameters — positional $1 $2 $3', () => {
  it('replaces $1, $2, $3 with space-split tokens', () => {
    const body = 'first=$1 second=$2 third=$3';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      'alpha beta gamma',
      { skillDir: '/x', sessionId: 's' },
    );
    expect(out).toBe('first=alpha second=beta third=gamma');
  });

  it('preserves quoted tokens as a single positional argument', () => {
    const body = 'message=$1';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      '"fix login bug"',
      { skillDir: '/x', sessionId: 's' },
    );
    expect(out).toBe('message=fix login bug');
  });

  it('leaves $1 empty when the user supplied fewer args', () => {
    const body = '[$1]';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      '',
      { skillDir: '/x', sessionId: 's' },
    );
    expect(out).toBe('[]');
  });
});

describe('expandSkillParameters — named $arg_name', () => {
  it('replaces $message when frontmatter declares arguments: [message]', () => {
    const body = 'Commit with message: $message';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      'fix the login bug',
      { skillDir: '/x', sessionId: 's', argumentNames: ['message'] },
    );
    expect(out).toBe('Commit with message: fix the login bug');
  });

  it('binds multiple named args positionally in declaration order', () => {
    const body = 'title=$title body=$body';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      'MyTitle SomeBodyText',
      { skillDir: '/x', sessionId: 's', argumentNames: ['title', 'body'] },
    );
    expect(out).toBe('title=MyTitle body=SomeBodyText');
  });
});

describe('expandSkillParameters — ${KIMI_SKILL_DIR} / ${KIMI_SESSION_ID}', () => {
  it('replaces ${KIMI_SKILL_DIR} with the skill directory', () => {
    const body = 'Read ${KIMI_SKILL_DIR}/helper.md';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      '',
      { skillDir: '/home/user/.kimi/skills/commit', sessionId: 'ses_1' },
    );
    expect(out).toBe('Read /home/user/.kimi/skills/commit/helper.md');
  });

  it('replaces ${KIMI_SESSION_ID} with the current session ID', () => {
    const body = 'Session: ${KIMI_SESSION_ID}';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      '',
      { skillDir: '/x', sessionId: 'ses_abc123' },
    );
    expect(out).toBe('Session: ses_abc123');
  });
});

describe('expandSkillParameters — edge cases', () => {
  it('leaves undefined placeholders as-is (no throw in Phase 1)', () => {
    const body = 'unknown=$NOT_DEFINED other=$ARGUMENTS';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      'value',
      { skillDir: '/x', sessionId: 's' },
    );
    // $ARGUMENTS expands; $NOT_DEFINED left untouched
    expect(out).toContain('other=value');
    expect(out).toContain('$NOT_DEFINED');
  });

  it('preserves literal $1 when escaped as \\$1', () => {
    const body = 'literal=\\$1 actual=$1';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      'hello',
      { skillDir: '/x', sessionId: 's' },
    );
    expect(out).toContain('literal=$1');
    expect(out).toContain('actual=hello');
  });

  it('does not expand a $ surrounded by non-word characters (word-boundary guard)', () => {
    const body = 'price is $5, not $1';
    const out = (expandSkillParameters as (b: string, a: string, c: ExpandContext) => string)(
      body,
      'abc def',
      { skillDir: '/x', sessionId: 's' },
    );
    // `$1` expands to `abc`, `$5` remains literal because no 5th token
    expect(out).toContain('not abc');
    // `$5` should remain — we asked for no 5th positional
    expect(out).toContain('$5');
  });
});
