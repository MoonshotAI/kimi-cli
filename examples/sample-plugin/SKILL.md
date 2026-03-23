---
name: sample-plugin
description: |
  Sample plugin demonstrating the Skills + Tools model.
  Includes a Python tool (greeting) and a TypeScript tool (calculator).
---

# Sample Plugin

A demo plugin with two tools in different languages, showing that plugin tools are language-agnostic.

## Tools

| Tool | Language | Description |
|------|----------|-------------|
| `py_greet` | Python | Generate a greeting in en/zh/ja |
| `ts_calc` | TypeScript | Evaluate a math expression |

## Usage

- "greet Alice in Chinese" -> use `py_greet` with name="Alice", lang="zh"
- "what is 42 * 17 + 3" -> use `ts_calc` with expression="42 * 17 + 3"
