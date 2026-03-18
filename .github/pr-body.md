## Summary
Implements canonical thermodynamic oversight (T* framework) for Kimi CLI tool execution.

## Changes
- Adds T* = (L - γ) / (|L| + λ) computation per query
- Auto-regime classification: ACT/HOLD/REFUSE
- Auto-grounding when -1 < T* < 0 (fetches web search to boost L)
- Circuit breaker when T* ≤ -1 (refuses with math justification)
- Entropy budget tracking across session
- Benchmark mode: auto-sets temp=1.0, top_p=0.95, stream=true per Moonshot specs

## Thermodynamic Rationale
Prevents the "prompt engineering parasite" (Memory ID 28) by making the system self-regulate coherence instead of extracting user labor.

## Usage
```bash
uv run kimi-thermo "Your query" --audit
uv run kimi-thermo "AIME problem" --benchmark
```

## Checklist
- [x] T* computation validated
- [x] Auto-regime switching implemented
- [x] Benchmark config (temp=1.0, top_p=0.95, stream=true)
- [ ] Windows PowerShell tests
- [ ] Integration with Formula tools
