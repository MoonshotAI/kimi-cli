/**
 * Dereference all `$ref` references in a JSON Schema by inlining definitions
 * from `$defs`. The top-level `$defs` key is removed from the result when all
 * refs are fully resolved.
 *
 * Circular references are detected and left as `$ref` to avoid infinite
 * recursion; in that case `$defs` is preserved so the remaining local `$ref`
 * pointers stay resolvable to a JSON Schema validator.
 */
export function derefJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = (schema['$defs'] ?? {}) as Record<string, unknown>;
  const visited = new Set<string>();
  const result = resolveNode(schema, defs, visited) as Record<string, unknown>;

  // Only delete $defs if no `#/$defs/...` refs remain in the result. Cyclic
  // refs are intentionally preserved by resolveNode() and still need $defs to
  // resolve; dropping $defs in that case would leave dangling pointers.
  if (!hasUnresolvedDefsRef(result)) {
    delete result['$defs'];
  }
  return result;
}

function hasUnresolvedDefsRef(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasUnresolvedDefsRef);
  }
  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      return true;
    }
    for (const [key, value] of Object.entries(obj)) {
      // Skip the top-level $defs container itself when walking the result —
      // we only care about `$ref` pointers living elsewhere in the schema.
      if (key === '$defs') continue;
      if (hasUnresolvedDefsRef(value)) return true;
    }
    return false;
  }
  return false;
}

function resolveNode(node: unknown, defs: Record<string, unknown>, visited: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveNode(item, defs, visited));
  }

  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;

    // Handle $ref
    if (typeof obj['$ref'] === 'string') {
      const ref = obj['$ref'];
      const prefix = '#/$defs/';
      if (ref.startsWith(prefix)) {
        const defName = ref.slice(prefix.length);
        if (visited.has(defName)) {
          // Circular reference — return the $ref as-is to avoid infinite recursion
          return obj;
        }
        const defValue = defs[defName];
        if (defValue !== undefined) {
          visited.add(defName);
          const resolved = resolveNode(defValue, defs, visited);
          visited.delete(defName);
          // Preserve sibling keywords (JSON Schema 2020-12 semantics):
          // a node may contain `$ref` alongside other fields like
          // `description`, `default`, or local constraints. Python's deref
          // implementation merges these with the resolved definition;
          // sibling keys on the local node take precedence. (Codex P2 fix.)
          if (typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)) {
            const merged: Record<string, unknown> = { ...(resolved as Record<string, unknown>) };
            for (const [key, value] of Object.entries(obj)) {
              if (key === '$ref') continue;
              merged[key] = resolveNode(value, defs, visited);
            }
            return merged;
          }
          return resolved;
        }
      }
      // Unknown $ref — return as-is
      return obj;
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveNode(value, defs, visited);
    }
    return resolved;
  }

  return node;
}
