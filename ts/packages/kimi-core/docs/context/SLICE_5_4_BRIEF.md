# Slice 5.4 — Runtime Switches + EnterPlanMode

**Gate 1**: D1=B (完整版 Question 对话), D2=A (SoulPlus 内部自动创建 DIM), D3=A (精简 scope)

---

## Scope (~200 lines)

| Task | Description | Est. |
|------|------------|------|
| T1 | EnterPlanModeTool (Question dialog, yolo auto-approve) | ~100 |
| T2 | DynamicInjectionManager wired into SoulPlus | ~15 |
| T3 | Tests | ~120 |
| **Total** | | **~235** |

---

## T1: EnterPlanModeTool

New file: `src/tools/enter-plan-mode.ts`

Python parity: `kimi_cli/tools/plan/enter.py`

### Input Schema
```typescript
interface EnterPlanModeInput {}  // empty — no parameters
```

### Behavior (Python parity)
1. Guard: if plan mode already active → return error
2. If yolo mode → auto-approve, toggle plan mode, return success
3. If interactive → send QuestionRequest via QuestionRuntime:
   - Question: "Enter plan mode? In plan mode I'll investigate and design a plan before making changes."
   - Options: ["Yes, enter plan mode", "No, proceed directly"]
4. On approval → `setPlanMode(true)`, return success with workflow instructions
5. On rejection → return decline message

### Dependencies (constructor-injected, same pattern as ExitPlanModeTool)
```typescript
interface EnterPlanModeDeps {
  isPlanModeActive(): boolean;
  setPlanMode(enabled: boolean): Promise<void>;
  isYoloMode(): boolean;
  questionRuntime: QuestionRuntime;
}
```

---

## T2: DynamicInjectionManager wiring

Modify: `src/soul-plus/soul-plus.ts`

In constructor, after creating TurnManager:
```typescript
const dim = createDefaultDynamicInjectionManager();
// Pass to TurnManager deps
```

TurnManager already accepts `dynamicInjectionManager?: DynamicInjectionManager` in its deps and calls `drainDynamicInjectionsIntoContext()` at `launchTurn()`. We just need to create and pass it.

---

## Not in scope
- Plan file persistence (plan.md)
- ExitPlanMode approval dialog upgrade
- /bug command
- New slash commands
