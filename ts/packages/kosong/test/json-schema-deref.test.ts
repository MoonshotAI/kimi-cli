import { describe, expect, it } from 'vitest';

import { derefJsonSchema } from '../src/json-schema-deref.js';

describe('derefJsonSchema', () => {
  it('returns schema unchanged when there are no $ref', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };

    const result = derefJsonSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    });
  });

  it('resolves a simple $ref from $defs', () => {
    const schema = {
      type: 'object',
      properties: {
        address: { $ref: '#/$defs/Address' },
      },
      $defs: {
        Address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    };

    const result = derefJsonSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    });
    // $defs should be removed from the result.
    expect(result['$defs']).toBeUndefined();
  });

  it('preserves sibling keywords alongside $ref (e.g. description)', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          $ref: '#/$defs/User',
          description: 'Custom description on the ref site',
        },
      },
      $defs: {
        User: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
      },
    };

    const result = derefJsonSchema(schema);

    const user = (result['properties'] as Record<string, Record<string, unknown>>)['user']!;
    // Resolved definition fields are present.
    expect(user['type']).toBe('object');
    expect(user['properties']).toEqual({ name: { type: 'string' } });
    // Local sibling "description" is preserved.
    expect(user['description']).toBe('Custom description on the ref site');
  });

  it('local sibling fields override same-named fields from $defs', () => {
    const schema = {
      type: 'object',
      properties: {
        field: {
          $ref: '#/$defs/Widget',
          // Local override must win over the def's description.
          description: 'local override wins',
        },
      },
      $defs: {
        Widget: {
          type: 'string',
          description: 'description from $defs',
          default: 'hello',
        },
      },
    };

    const result = derefJsonSchema(schema);

    const field = (result['properties'] as Record<string, Record<string, unknown>>)['field']!;
    expect(field['type']).toBe('string');
    // Local sibling wins.
    expect(field['description']).toBe('local override wins');
    // Non-overlapping def fields still flow through.
    expect(field['default']).toBe('hello');
  });

  it('preserves sibling $ref keywords that themselves contain $ref (recursively resolved)', () => {
    const schema = {
      type: 'object',
      properties: {
        entry: {
          $ref: '#/$defs/Wrapper',
          extra: { $ref: '#/$defs/Inner' },
        },
      },
      $defs: {
        Wrapper: {
          type: 'object',
          properties: { a: { type: 'number' } },
        },
        Inner: {
          type: 'object',
          properties: { b: { type: 'boolean' } },
        },
      },
    };

    const result = derefJsonSchema(schema);

    const entry = (result['properties'] as Record<string, Record<string, unknown>>)['entry']!;
    expect(entry['type']).toBe('object');
    expect(entry['properties']).toEqual({ a: { type: 'number' } });
    // Sibling `extra` must have been recursively resolved (not left as a $ref).
    expect(entry['extra']).toEqual({
      type: 'object',
      properties: { b: { type: 'boolean' } },
    });
  });

  it('preserves $defs when cyclic refs remain unresolved', () => {
    // A references B, B references A — classic cycle. resolveNode() leaves
    // a `#/$defs/...` pointer on at least one side; the validator will need
    // $defs to stay around to resolve those dangling pointers.
    const schema = {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/A' },
      },
      $defs: {
        A: {
          type: 'object',
          properties: {
            next: { $ref: '#/$defs/B' },
          },
        },
        B: {
          type: 'object',
          properties: {
            back: { $ref: '#/$defs/A' },
          },
        },
      },
    };

    const result = derefJsonSchema(schema);

    // $defs must be preserved because cyclic refs still reference them.
    expect(result['$defs']).toBeDefined();
    const defs = result['$defs'] as Record<string, unknown>;
    expect(defs['A']).toBeDefined();
    expect(defs['B']).toBeDefined();

    // Walk the result and confirm at least one remaining $ref points at $defs —
    // i.e. the output is internally consistent, not dangling.
    const jsonText = JSON.stringify(result);
    expect(jsonText).toContain('"$ref":"#/$defs/');
  });

  it('still deletes $defs when there are no cyclic refs', () => {
    // Sanity: a non-cyclic schema with $defs should have its $defs removed
    // after dereferencing (existing behavior must not regress).
    const schema = {
      type: 'object',
      properties: {
        name: { $ref: '#/$defs/Name' },
      },
      $defs: {
        Name: { type: 'string' },
      },
    };

    const result = derefJsonSchema(schema);
    expect(result['$defs']).toBeUndefined();
    expect(result['properties']).toEqual({ name: { type: 'string' } });
  });

  it('resolves nested $ref from $defs', () => {
    const schema = {
      type: 'object',
      properties: {
        person: { $ref: '#/$defs/Person' },
      },
      $defs: {
        Person: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: { $ref: '#/$defs/Address' },
          },
        },
        Address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    };

    const result = derefJsonSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        person: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: {
              type: 'object',
              properties: {
                street: { type: 'string' },
                city: { type: 'string' },
              },
            },
          },
        },
      },
    });
    expect(result['$defs']).toBeUndefined();
  });
});
