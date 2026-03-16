#!/usr/bin/env python3
"""
Complete CLI - All Official Tools, Zero Friction
"""

import asyncio
import sys
import json
from .dynamic_complete import DynamicCompleteClient


async def main():
    args = sys.argv[1:]
    
    if not args or args[0] in ("-h", "--help"):
        print("Complete Kimi CLI - All Official Tools")
        print("\nUsage:")
        print('  python -m kimi_thermo.complete_cli "your query"')
        print("  python -m kimi_thermo.complete_cli --audit")
        print("  python -m kimi_thermo.complete_cli --tools")
        print("  python -m kimi_thermo.complete_cli --costs")
        print("\nExamples:")
        print('  Search:    "latest AI news"')
        print('  Code:      "write a python function to sort dicts"')
        print('  Convert:   "convert 100 USD to EUR"')
        print('  Excel:     "analyze this data.xlsx file"')
        print('  Cat:       "give me a cat blessing 🐱"')
        return
    
    if args[0] == "--tools":
        from .tools_complete import OFFICIAL_TOOLS
        print("All 13 Official Tools:")
        for name, meta in OFFICIAL_TOOLS.items():
            protected = "🔒" if meta.protected else "  "
            cost = {
                "web_search": "~$0.02", "fetch": "~$0.01", "code_runner": "~$0.01",
                "quickjs": "~$0.01", "excel": "~$0.01", "memory": "~$0.005"
            }.get(name, "~$0.001")
            print(f"  {protected} {name:20} γ={meta.base_gamma:.2f}  {cost:8}  {meta.description[:40]}...")
        return
    
    if args[0] == "--costs":
        # Show cost breakdown
        print("Estimated Costs (USD):")
        print("  web_search:    $0.02 per search")
        print("  fetch:         $0.01 per fetch")
        print("  code_runner:   $0.01 per execution")
        print("  excel:         $0.01 per file")
        print("  memory:        $0.005 per operation")
        print("  All others:    ~$0.001 per call")
        print("\nWith $200 budget: ~10,000 web searches or ~200,000 utility calls")
        return
    
    if args[0] == "--audit":
        client = DynamicCompleteClient()
        audit = client.get_full_audit()
        print(json.dumps(audit, indent=2))
        await client.close()
        return
    
    # Execute query
    query = " ".join(args)
    client = DynamicCompleteClient()
    
    print(f"[Processing: {query[:60]}...]", file=sys.stderr)
    
    result = await client.execute(query)
    
    # Output
    print(result["output"])
    
    # Audit footer
    if result.get("tools_used"):
        print(f"\n[Tools: {', '.join(result['tools_used'])}]", file=sys.stderr)
    print(f"[Cost: ${result['cost']:.4f} | Total: ${result['total_spent']:.2f} | Remaining: ${result['budget_remaining']:.2f}]", file=sys.stderr)
    
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
