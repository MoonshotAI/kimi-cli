import { z } from 'zod';

import { toolValidateError } from './tool-errors.js';
import { validateToolSchema } from './tool.js';
import type { JsonType, Tool, ToolReturnValue } from './tool.js';

/**
 * Configuration for a typed tool.
 */
export interface TypedToolConfig<TParams> {
  /** Unique tool name used to match invocations. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** Zod schema describing the parameter shape. The JSON Schema fed to the
   * model is generated from this schema, and incoming arguments are validated
   * against it at runtime. */
  params: z.ZodType<TParams>;
  /** Handler invoked with parsed, type-checked parameters. */
  handler: (params: TParams) => Promise<ToolReturnValue>;
}

/**
 * Result of {@link createTypedTool}: a Tool definition plus a wrapped handler
 * that performs runtime parameter validation via the provided zod schema.
 *
 * Use with `SimpleToolset.add(tool, handler)`.
 */
export interface TypedTool {
  /** The tool definition to advertise to the model. */
  tool: Tool;
  /** A handler suitable for {@link SimpleToolset.add}. Validates incoming
   * arguments against the zod schema before delegating to the user handler. */
  handler: (args: JsonType) => Promise<ToolReturnValue>;
}

/**
 * Create a type-safe tool from a zod schema.
 *
 * The handler receives parameters with the type inferred from the zod schema.
 * Runtime validation ensures arguments from the LLM match the schema before
 * the handler is called; validation failures return `toolValidateError`.
 *
 * @example
 * ```ts
 * const addTool = createTypedTool({
 *   name: 'add',
 *   description: 'Adds two numbers',
 *   params: z.object({ a: z.number(), b: z.number() }),
 *   handler: async (params) => toolOk({ output: String(params.a + params.b) }),
 * });
 *
 * const toolset = new SimpleToolset();
 * toolset.add(addTool.tool, addTool.handler);
 * ```
 */
export function createTypedTool<TParams>(config: TypedToolConfig<TParams>): TypedTool {
  const runtimeSchema =
    config.params instanceof z.ZodObject
      ? (config.params.strict() as z.ZodType<TParams>)
      : config.params;

  // Generate JSON Schema from the zod schema using zod 4's built-in converter.
  // This produces a plain JSON Schema object suitable for wire transmission to
  // OpenAI/Anthropic/Google function-calling APIs.
  const jsonSchema = z.toJSONSchema(runtimeSchema) as Record<string, unknown>;

  // Strip the $schema metadata field — providers don't need it and it just
  // pollutes the wire format.
  delete jsonSchema['$schema'];

  const tool: Tool = {
    name: config.name,
    description: config.description,
    parameters: jsonSchema,
  };

  // Belt-and-braces meta-schema check: while zod normally produces valid
  // JSON Schema, unusual zod schema compositions can emit structures ajv
  // rejects. Throw `ToolDefinitionError` at createTypedTool() time rather
  // than on first tool invocation.
  validateToolSchema(tool);

  const handler = async (args: JsonType): Promise<ToolReturnValue> => {
    // Runtime validation via zod.
    const result = runtimeSchema.safeParse(args);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => {
          const path = issue.path.join('.');
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join('; ');
      return toolValidateError(`Tool parameter validation failed: ${issues}`);
    }
    return config.handler(result.data);
  };

  return { tool, handler };
}
