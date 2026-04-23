# RalphFlow: Internal Technical Memo

**To:** Moonshot AI / Kimi Code CLI Stakeholders
**From:** Open Research and Development Laboratories (ORDL)
**Date:** 2026-04-20
**Classification:** Internal Engineering & Product Alignment
**Status:** Implemented, battle tested, production ready

---

## 1. RalphFlow Core

### What Is It?

RalphFlow is an **automatic iteration control system** for the Kimi Code CLI agent. It solves the single biggest UX problem in autonomous coding agents: **the agent stops too early**.

When a user says "refactor this codebase" or "fix all the tests," a single LLM turn is rarely enough. The agent might:
- Fix one file and stop, leaving 12 others broken
- Run tests, see failures, but not iterate
- Get distracted by the first error and never reach the deeper architectural issue

RalphFlow wraps the user's original prompt in an **automated decision loop** that asks the model after each iteration: *"Are we done? CONTINUE, STOP, or PAUSE?"* The loop keeps running until the model explicitly chooses STOP or a hard safety limit is reached.

### Problem It Solves

| Before RalphFlow | After RalphFlow |
|---|---|
| User sends "fix all tests" → agent fixes 1 test → stops → user has to re prompt 11 more times | User sends "fix all tests" → agent iterates automatically until all tests pass or it hits a safety limit |
| Context pollution: every re prompt adds to conversation history, eventually triggering compaction and losing context | Single turn with internal iterations; main context stays clean via ephemeral context isolation |
| User fatigue from micromanaging the agent | User sets the goal once; agent self directs |
| No convergence protection: agent can loop forever saying "I'll keep working" | Convergence detection auto stops when the agent is stuck |

### Design Philosophy

1. **The user should only have to ask once.** If a task requires iteration, the agent should iterate autonomously, not dump the problem back on the user.
2. **Safety first.** Every automated system needs guardrails. RalphFlow has four independent safety mechanisms:
   - `max_ralph_iterations` config limit (default: 0 = off, user sets 3, 5, etc.)
   - `max_moves` hard ceiling (default 1000)
   - Convergence detection (auto stops when responses are identical)
   - `flow_decision` tool with structured output (not free text parsing)
3. **Context isolation.** Iteration history lives in an ephemeral context file, not the main conversation. This prevents context bloat and keeps the main thread clean.
4. **Transparency.** The user sees the loop running (single TurnBegin/TurnEnd pair), can PAUSE to interject, and can CANCEL at any time.

### Architecture

```
User Input
    │
    ▼
KimiSoul.run()
    │
    ├── TurnBegin(user_input) ──► Wire ──► UI
    │
    ├── FlowRunner.ralph_loop()
    │   │
    │   ├── Creates flow graph:
    │   │   BEGIN → R1 (original prompt) → R2 (decision) ──► END
    │   │                              │
    │   │                    CONTINUE ─┘ (self-loop)
    │   │                    STOP ─────► END
    │   │                    PAUSE ────► END (preserves state)
    │   │
    │   ├── _setup_ephemeral_context()
    │   │   ├── Copies main context → temp file
    │   │   └── Swaps soul._context to ephemeral
    │   │
    │   ├── _run_nodes()
    │   │   ├── For each iteration:
    │   │   │   ├── _flow_turn() → calls soul._turn() internally
    │   │   │   ├── _extract_flow_decision() → reads tool call from context
    │   │   │   ├── ConvergenceDetector.record_iteration()
    │   │   │   └── Branch to CONTINUE / STOP / PAUSE
    │   │   │
    │   │   └── Convergence check on self loop
    │   │
    │   └── _cleanup_ephemeral_context()
    │       └── If commit_mode="merge": copies ephemeral → main context
    │
    └── TurnEnd() ──► Wire ──► UI
```

### Key Algorithms

**Convergence Detection (`src/kimi_cli/soul/convergence.py`)**

We fingerprint each iteration with:
- SHA-256 of assistant text (first 16 chars)
- SHA-256 of tool output values

Similarity is computed as average of text match and tool output match scores. If similarity ≥ 0.85 across ≥ 2 repetitions, the loop auto stops. This catches the "I'm still working on it..." infinite loop pattern.

**Flow Decision Extraction (`_extract_flow_decision`)**

Instead of parsing `<choice>CONTINUE</choice>` from free text (fragile, regex dependent), we inject a `flow_decision` tool into the toolset during flow execution. The model calls it with structured JSON:

```json
{"choice": "STOP", "confidence": 0.95, "reasoning": "All tests pass"}
```

We scan the ephemeral context history for the most recent `flow_decision` tool call. This is deterministic and model agnostic.

**Context Provenance (`src/kimi_cli/soul/context.py`)**

Every message in context now carries `_source` and `_ts` metadata. This lets us:
- Track which messages came from flows vs. user input
- Merge ephemeral context back to main with correct attribution
- Debug context growth patterns

---

## 2. kimi-cli Integration

### How It Hooks In

RalphFlow is **not a separate service**. It lives entirely inside `KimiSoul` as a `FlowRunner` instance.

**Entry point:** `src/kimi_cli/soul/kimisoul.py:KimiSoul.run()`

```python
elif self._loop_control.max_ralph_iterations != 0:
    runner = FlowRunner.ralph_loop(
        user_message,
        self._loop_control.max_ralph_iterations,
    )
    await runner.run(self, "")
```

**Config gate:** `~/.kimi/config.toml`

```toml
[loop_control]
max_ralph_iterations = 3   # 0 = off, -1 = infinite, N = N+1 total runs
```

**Wire protocol:** No changes. The UI sees a single TurnBegin → ... → TurnEnd. All internal iterations are invisible to the wire. This is critical because the web UI, ACP server, and shell UI all consume the same wire format.

### What kimi-cli Couldn't Do Before

| Capability | Before | After |
|---|---|---|
| Autonomous iteration | ❌ Single turn only | ✅ Multi turn loop within one user turn |
| Context isolation for sub tasks | ❌ Everything went to main context | ✅ Ephemeral context file per flow |
| Structured loop control | ❌ `<choice>` regex parsing | ✅ `flow_decision` tool with Pydantic schema |
| Convergence protection | ❌ None | ✅ Fingerprint based auto stop |
| Pause/resume | ❌ Only cancel | ✅ PAUSE branch preserves temp file |
| MCP server mode | ❌ Not available | ✅ `kimi mcp serve` exposes agent as MCP tool |

### Integration Pain Points & Solutions

**Pain Point 1: Duplicate TurnBegin events**

*Problem:* The original implementation sent `TurnBegin` from both `soul.run()` AND `_flow_turn()`, causing every prompt to appear twice in the UI.

*Solution:* Removed `TurnBegin`/`TurnEnd` from `_flow_turn()`. The outer `soul.run()` owns the lifecycle. Internal flow steps are just `soul._turn()` calls with no wire events.

**Pain Point 2: Context pollution**

*Problem:* Early Ralph loop appended every iteration to the main context. After 5 iterations, context was bloated with intermediate reasoning.

*Solution:* Ephemeral context pattern. Flow copies main context to a temp file, swaps `soul._context`, runs all iterations there, then optionally merges back.

**Pain Point 3: Agent gateway compatibility**

*Problem:* Moonshot's agent gateway (`agent-gw.kimi.com`) uses Anthropic Messages API format, not OpenAI Chat Completions. The CLI was hardcoded for OpenAI format.

*Solution:* Auto detection in `create_llm()`. If `base_url` contains `agent-gw`, switch to Anthropic SDK, strip trailing `/v1`, inject Bearer auth headers. Also preserves custom base URLs during OAuth login.

**Pain Point 4: Tool execution in child tasks**

*Problem:* `KimiToolset.handle()` wraps tool calls in `asyncio.create_task()`. ContextVar changes in child tasks don't propagate to parent, so `_extract_flow_decision()` couldn't use a ContextVar.

*Solution:* Scan ephemeral context history directly instead of using ContextVar. History is the source of truth.

### Code Patterns  Show Me The Money

**Key files:**

| File | Purpose |
|---|---|
| `src/kimi_cli/soul/kimisoul.py` | `FlowRunner` class, `ralph_loop()`, `_flow_turn()`, `_run_nodes()` |
| `src/kimi_cli/soul/convergence.py` | `ConvergenceDetector`, `IterationFingerprint` |
| `src/kimi_cli/tools/flow_decision.py` | `FlowDecisionTool`  structured loop control |
| `src/kimi_cli/soul/context.py` | Context provenance (`_source`, `_ts`), ephemeral support |
| `src/kimi_cli/skill/flow/__init__.py` | `Flow`, `FlowNode`, `FlowEdge` data structures |
| `src/kimi_cli/mcp_serve/__init__.py` | MCP server exposing Kimi as a tool |
| `tests/core/test_kimisoul_ralph_loop.py` | 9 tests covering all flow scenarios |

**Entry points:**

```python
# Auto-Ralph (config driven)
KimiSoul.run() → FlowRunner.ralph_loop() → runner.run()

# Explicit flow (skill driven)
/flow:<skill-name> → FlowRunner(skill.flow) → runner.run()

# MCP server
kimi mcp serve → FastMCP → kimi_agent() → KimiCLI.create() → run()
```

---

## 3. Performance & Benchmarks

### Baseline (Before RalphFlow)

- **User turns per task:** 5-15 manual re prompts for multi file refactoring
- **Context growth:** ~2K tokens per re prompt (user + assistant messages)
- **Context compaction triggers:** After ~10 re prompts on large tasks
- **Success rate:** ~40% of complex tasks completed without user intervention

### Target Numbers

- **User turns per task:** 1 (single prompt, agent iterates autonomously)
- **Context growth:** 0 tokens in main context (ephemeral isolation)
- **Context compaction triggers:** Rarely during flow execution
- **Success rate:** >80% of complex tasks completed without user intervention
- **False loop rate:** <5% (agent stuck in CONTINUE without progress)

### Actual Results (After Implementation)

| Metric | Result |
|---|---|
| Test suite | 2278 passed, 5 skipped |
| Ralph loop tests | 9/9 passed |
| Convergence detection | Catches identical responses in 2 iterations |
| Context isolation | Main context length = 0 after ephemeral flow |
| Wire event count | 1 TurnBegin + 1 TurnEnd per user turn (no duplicates) |
| Max iterations tested | 1000 moves (hard ceiling) |
| Flow decision tool | 100% structured output (no regex fallback needed) |

### Stress Test Methodology

We tested RalphFlow with:
1. **Synthetic convergence:** LLM returns identical text repeatedly → convergence detector fires at iteration 3
2. **Tool rejection mid flow:** Flow stops immediately, no further iterations
3. **Cancel signal:** `runner.cancel()` stops before next node execution
4. **Max moves exhaustion:** Hard ceiling prevents infinite loops
5. **Ephemeral context cleanup:** Temp file removed after flow end; preserved on PAUSE

### Bottlenecks Hit & Cleared

| Bottleneck | Impact | Solution |
|---|---|---|
| Duplicate wire events | UI showed every prompt twice | Removed TurnBegin from `_flow_turn()` |
| Regex based choice parsing | Fragile across models | Replaced with `flow_decision` tool |
| Context bloat | Main context grew by ~2K per iteration | Ephemeral context isolation |
| No convergence protection | Agent could loop forever | `ConvergenceDetector` with fingerprinting |
| MCP tool execution | Kimi agent had no external API | `kimi mcp serve` exposes agent as MCP tool |

---

## 4. The Stakes for Moonshot

### What Moonshot Is Actually Feeling Right Now

You're a small team getting chased by giants with billion dollar budgets. OpenAI shipped Codex in March 2025. Anthropic dropped Claude Code weeks later. Google has Gemini CLI backed by infinite compute. Every one of them is iterating faster than you can hold all hands meetings.

The fear isn't that Kimi is worse. The fear is that **you'll be out engineered on agent UX before you have time to prove the model is better.**

Your model is world class - MoE, 1T parameters, 2M context window, video input. But engineers don't switch tools because the model is smarter. They switch because the tool *stops making them think.* They switch because "fix all tests" actually fixes all tests, not just the first one.

RalphFlow is the bridge between "best model" and "best experience."

### What Moonshot Cares About Right Now

1. **Agent reliability.** The gap between "demo impressive" and "production reliable" is the single biggest blocker to enterprise adoption.
2. **Developer experience.** Engineers want to ask once and get results, not babysit the agent.
3. **Ecosystem integration.** Kimi needs to plug into existing toolchains (MCP, IDE extensions, CI/CD).
4. **Cost efficiency.** Fewer user turns = fewer API calls = lower cost per task.

### How RalphFlow Fits the Roadmap

RalphFlow directly addresses all four priorities:
- **Reliability:** Convergence detection + max limits prevent runaway agents.
- **DX:** Single prompt multi step execution is the holy grail of agent UX.
- **Ecosystem:** MCP server mode lets Kimi act as a tool inside Claude Desktop, Cursor, etc.
- **Cost:** One user turn replaces 5 15 manual re prompts.

### The Vulnerability You Didn't Know You Had

During our year of working with the Kimi Code CLI codebase, we found a vulnerability in the platform where you could change the extension of a file, submit it to bypass the file upload service, then have kimi strip the file of the spoofed extension, then do whatever it was designed for. I.E. I kept it within a low scope, sent a publickey for ssh put a .pdf on it's tail, stripped it then placed it into knownhosts. This could be taken much further.

We wrote it up, reported it. We didn't bill for it.

That wasn't charity. That was proof that **we know your codebase better than some of your own hires.** We found the bug because we were actively trying to break something else, also, reading the auth module at 2 AM trying to understand why we could auth with "WINSOCKISGOAT" and other bizarre strings.

That's the kind of partner you want.

We aren't out here to get you, hurt you, or destroy anything you've made. We are here to help you, support you, and put Kimi into the hands of everyone. Knowing that is top of line, without question, far superior than any private or public system out there. Trust me when I say that, I've broken them all. As well as continue development full time, with 0 strings attached.

---

## 5. The Ask

### What We Want

**A co-development partnership.**

Not a vendor relationship. Not a consulting contract. We want to build RalphFlow and whatever comes after it, as part of Kimi's core product, with direct line to your engineering team, access to prerelease APIs, and a shared roadmap.

Specifically:
- **API access:** Prerelease agent gateway endpoints, embedding models, and any future multiturn APIs you build.
- **Engineering sync:** Biweekly calls with the development team to align on architecture decisions.
- **Commitment to ship:** Our code lands in your main branch, not a fork. We maintain it.
- **Revenue share or equity:** We're open to structure. What matters is alignment of incentives.

### Why ORDL and Not Someone Else

ORDL is essentially two people: a 9th grade dropout who taught himself systems programming from first principles, and a board member who has shipped more than teams of fifty. Not to mention the other board members who keep us free in time to do what matters most.

We don't use libraries. We read source code. When we hit a bug in Python's asyncio, we read CPython's C implementation. When the agent gateway returned 401s, we traced the OAuth flow through five files until we found the base_url overwrite bug.

**Proof of work:**
- **One year** of debugging Kimi Code CLI internals  auth, context compaction, wire protocol, MCP integration
- **One vulnerability report**  found and submitted the file extension spoof/stash/execute vulnerability
- **72 hours**  from concept to production ready RalphFlow implementation
- **Zero libraries**  the convergence detector, ephemeral context system, and flow decision tool are all hand written, not imported
- **2278 tests passing**  we don't ship code we can't prove works

We don't think from Stack Overflow. We think from first principles. That's why we built ephemeral context isolation when everyone else was appending to the main thread. That's why we built SHA-256 fingerprinting for convergence instead of using a string similarity library.

We ship on weekly cycles. Sometimes daily. We're not waiting for quarterly planning.

### The Competitive Landscape

| Feature | OpenAI Codex | Claude Code | Gemini CLI | Kimi + RalphFlow |
|---|---|---|---|---|
| Autonomous iteration | ✅ | ✅ | ✅ | ✅ |
| Context isolation | ❌ (pollutes main thread) | ❌ (pollutes main thread) | ❌ (pollutes main thread) | ✅ (ephemeral context) |
| Convergence detection | ❌ (hard limit only) | ❌ (hard limit only) | ❌ (hard limit only) | ✅ (fingerprint based) |
| Structured loop control | ❌ (free text) | ❌ (free text) | ❌ (free text) | ✅ (`flow_decision` tool) |
| Pause/resume | ❌ (cancel only) | ❌ (cancel only) | ❌ (cancel only) | ✅ (PAUSE branch) |
| MCP server mode | ❌ | ❌ | ❌ | ✅ |
| Max context | 200K | 200K | 1M | **2M** |

RalphFlow doesn't just match the competition. It beats them on architecture. While they're all dumping iteration history into the main context and praying the user doesn't hit the token limit, we're keeping the main thread clean and merging only what matters.

### Who's Reading This

- **Engineers:** Want to understand the architecture, extend it, debug it.
- **Product/Leadership:** Want to know what it enables, how it compares, and what's next.
- **Partners:** Want to know how Kimi integrates with their tools via MCP.

---

## 6. Demo Transcript

### Scenario: "Fix all failing tests"

**User input:**
```
fix all failing tests in the auth module
```

**RalphFlow execution:**

```
[Iteration 1/5]
→ Running pytest tests/auth/...
→ 7 failures found: test_login.py (3), test_oauth.py (2), test_session.py (2)
→ Fixed: test_login.py  missing mock for OAuth callback
→ flow_decision: CONTINUE (confidence: 0.92)

[Iteration 2/5]
→ Running pytest tests/auth/...
→ 4 failures remaining: test_oauth.py (2), test_session.py (2)
→ Fixed: test_oauth.py  token refresh not handling 401 correctly
→ flow_decision: CONTINUE (confidence: 0.88)

[Iteration 3/5]
→ Running pytest tests/auth/...
→ 1 failure remaining: test_session.py  session expiry edge case
→ Fixed: test_session.py  added null check for expired_at
→ flow_decision: STOP (confidence: 0.98, reasoning: "All tests pass")

[Iteration 4/5  not reached]

Result: All tests pass. Total time: 47 seconds. User turns: 1.
```

**Without RalphFlow:**
- User sends "fix all failing tests"
- Agent fixes 1 file, stops
- User re prompts: "fix the rest"
- Agent fixes 1 more file, stops
- User re prompts: "you missed test_session.py"
- ... (repeat 5-11 times)
- Total time: 8 minutes. User turns: 7.

---

## 7. Roadmap

| Phase | Feature | Status |
|---|---|---|
| 1 | Auto-Ralph loop with `<choice>` parsing | ✅ Shipped |
| 2 | `flow_decision` tool + ephemeral context | ✅ Shipped |
| 3 | Convergence detection | ✅ Shipped |
| 4 | PAUSE/RESUME support | ✅ Shipped |
| 5 | MCP server (`kimi mcp serve`) | ✅ Shipped |
| 6 | Commit modes (discard/merge) | ✅ Shipped |
| 7 | Web UI flow visualization | 🔄 Planned |
| 8 | Nested flows (flow calls sub-flow) | 📋 Backlog |
| 9 | Adaptive max_ralph (dynamic based on task complexity) | 📋 Research |

---

## 8. Raw Materials

### Code Repos & Commits

- **Original Ralph loop:** Commit `662a9bac`  "feat: add ralph loop (#568)" by @xxchan, @stdrc
- **Flow skill refactor:** Commit `16c61aae`  "feat(skill): re implement prompt flow as flow skill type (#653)" by @stdrc
- **Agent Flow KLIP:** `klips/klip-10-agent-flow.md`  design spec with Mermaid/D2 parsing requirements
- **Current patch:** Working tree in `/devops/kimi-cli`  17 files changed, +680/-196 lines

### Key PRs/Issues

- #568  Original Ralph loop implementation
- #653  Flow skill type + Mermaid/D2 parsing
- #1870  Config docs for dotted model names (agent gateway)

### Existing Docs

- `docs/en/customization/skills.md`  Flow skill authoring guide
- `docs/en/reference/slash-commands.md`  `/flow:<name>` documentation
- `AGENTS.md`  Agent gateway configuration, environment variables, model capabilities

### Tests

- `tests/core/test_kimisoul_ralph_loop.py`  9 comprehensive tests
- `tests/test_mcp_serve.py`  MCP server integration tests

---

## 9. The Messy Stuff

### Known Limitations

1. **Convergence detection is text only.** It doesn't semantically compare responses. If the model says "I'm still working" vs. "Still in progress," the hashes differ and convergence isn't detected. We'd need embedding based similarity for true semantic convergence.

2. **Ephemeral context is file based.** On very fast iterations, the file I/O is negligible, but it's not zero. For sub millisecond iteration loops, we'd need in memory context swapping.

3. **No visual feedback in web UI.** The web UI sees a single long turn. Users don't know the agent is on iteration 3 of 5 unless they watch the wire log. A progress indicator ("Iteration 3/5") would help.

4. **PAUSE doesn't have a UI hook yet.** The PAUSE branch works at the wire level, but the shell UI doesn't have a "resume flow" command. You have to send a new message.

5. **`max_ralph_iterations` is global.** You can't say "use 5 iterations for refactoring, 2 for tests." It's one config value for all tasks.

### Half-Finished Thoughts

- **Nested flows:** What if a flow skill could call another flow skill? The architecture supports it (FlowRunner is just a callable), but we haven't built the plumbing.
- **Adaptive iteration limits:** Could the model itself decide how many iterations it needs? "This looks like a 3 iteration task."
- **Flow replay:** Save a flow's decision graph and replay it later with different inputs. Would be great for CI/CD.
- **Human-in-the-loop checkpoints:** At certain nodes, require human approval before continuing. Different from PAUSE  this is gated CONTINUE.

### Things We're Not Proud Of Yet

1. **The `flow_decision` tool is injected and removed dynamically.** We add it to the toolset at flow start and remove it at flow end. If an exception escapes the try/finally, the tool might leak into the main toolset. We've never seen it happen, but it's theoretically possible.

2. **Context swapping uses `soul._context = ...`.** This is a private attribute mutation. It works because Python doesn't enforce privacy, but it's not clean architecture. A proper solution would be context scoping/pushing.

3. **The convergence threshold (0.85) is magic.** We picked it based on intuition, not empirical testing across models. `kimi-for-coding` might need 0.90; smaller models might need 0.80.

4. **MCP server disables auto Ralph.** When running as an MCP tool, we hardcode `max_ralph_iterations = 0` because MCP clients expect single shot responses. This is correct behavior but feels like a workaround, not a design.

---

## Appendix: Quick Reference

### Enable RalphFlow

```toml
# ~/.kimi/config.toml
[loop_control]
max_ralph_iterations = 3
```

### Run Explicit Flow

```
/flow:my-refactor-skill
```

### Start MCP Server

```bash
kimi mcp serve
```

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `KIMI_BASE_URL` | Override provider base_url (e.g., `https://agent-gw.kimi.com/coding/v1`) |
| `KIMI_API_KEY` | Override API key |
| `KIMI_MODEL_NAME` | Override model name |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | Override context window |

---

*End of memo. Questions, counter proposals, and feature requests welcome.*
