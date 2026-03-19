#!/usr/bin/env npx tsx
/** TypeScript tool: evaluate a math expression. */

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  const params = raw ? JSON.parse(raw) : {};
  const expression: string = params.expression ?? "0";

  // Safe evaluation: only allow numbers and basic operators
  if (!/^[\d\s+\-*/.()]+$/.test(expression)) {
    console.error(`Invalid expression: ${expression}`);
    process.exit(1);
  }

  try {
    const result = Function(`"use strict"; return (${expression})`)();
    console.log(`${expression} = ${result}`);
  } catch (e) {
    console.error(`Evaluation error: ${e}`);
    process.exit(1);
  }
});
