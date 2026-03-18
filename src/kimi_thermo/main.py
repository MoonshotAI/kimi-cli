#!/usr/bin/env python3
"""Workless CLI entry point"""
import asyncio
import argparse
from .thermo_executor import WorklessClient

async def async_main():
    parser = argparse.ArgumentParser(description="Thermodynamic Kimi CLI")
    parser.add_argument("query", help="Your query (system manages the rest)")
    parser.add_argument("--benchmark", action="store_true", help="Benchmark mode (temp=1.0)")
    parser.add_argument("--audit", action="store_true", help="Show thermodynamic audit")

    args = parser.parse_args()

    client = WorklessClient()
    result = await client.execute(args.query, mode="benchmark" if args.benchmark else "auto")

    if args.audit:
        print(f"[AUDIT] Regime: {result['regime']}")
        print(f"[AUDIT] T*: {result.get('T_star', 0):.2f}")
        print(f"[AUDIT] Entropy: {result.get('entropy', 0):.2f}")

    print(result['output'])

def main():
    """Sync wrapper for script entry point"""
    asyncio.run(async_main())

if __name__ == "__main__":
    main()
