import type { ContentPart, ToolCall } from './message.js';
import { compileToolArgsValidator, validateToolArgs } from './simple-toolset.js';
import {
  toolNotFoundError,
  toolParseError,
  toolRuntimeError,
  toolValidateError,
} from './tool-errors.js';
import type { JsonType, Tool, ToolResult, ToolReturnValue, Toolset } from './tool.js';

interface MCPToolEntry {
  tool: Tool;
  validator: ReturnType<typeof compileToolArgsValidator>;
}

/**
 * A content block as returned by an MCP tool call (`tools/call`).
 *
 * This is a structural subset of the MCP protocol `ContentBlock` union,
 * covering the shapes that {@link MCPToolset} knows how to convert into
 * kosong {@link ContentPart}s. Additional fields are ignored.
 */
export interface MCPContentBlock {
  // Known values: 'text' | 'image' | 'audio' | 'resource' | 'resource_link'.
  // Declared as `string` to also accept future MCP content types without a
  // type assertion.
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  [key: string]: unknown;
}

/**
 * Result of a single MCP tool invocation.
 *
 * Matches the shape returned by the MCP protocol's `tools/call` method.
 */
export interface MCPToolResult {
  content: MCPContentBlock[];
  isError: boolean;
}

/**
 * An MCP tool definition as returned by an MCP server's `tools/list` method.
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Minimal MCP client interface required by {@link MCPToolset}.
 *
 * This is a transport-agnostic seam: implementations can wrap
 * `@modelcontextprotocol/sdk`, a bespoke stdio client, an HTTP SSE client,
 * or a mock for testing. Keeping the surface small lets tests inject fakes
 * without pulling in the full SDK type graph.
 */
export interface MCPClient {
  /** List the tools advertised by the MCP server. */
  listTools(): Promise<MCPToolDefinition[]>;
  /** Invoke a tool by name with the given JSON arguments. */
  callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>;
}

/**
 * Convert a single MCP content block into a kosong {@link ContentPart}.
 *
 * Returns `null` for block types that cannot be represented (e.g. unknown
 * resource shapes) so the caller can drop them.
 */
export function convertMCPContentBlock(block: MCPContentBlock): ContentPart | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'image/png';
    return {
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  if (block.type === 'audio' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'audio/mpeg';
    return {
      type: 'audio_url',
      audioUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  // EmbeddedResource with an inline blob.
  if (block.type === 'resource' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image_url',
        imageUrl: { url: `data:${mimeType};base64,${block.data}` },
      };
    }
    if (mimeType.startsWith('audio/')) {
      return {
        type: 'audio_url',
        audioUrl: { url: `data:${mimeType};base64,${block.data}` },
      };
    }
    if (mimeType.startsWith('video/')) {
      return {
        type: 'video_url',
        videoUrl: { url: `data:${mimeType};base64,${block.data}` },
      };
    }
    return null;
  }

  // ResourceLink: URL reference, not an inline blob.
  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = block.mimeType ?? 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
      return { type: 'image_url', imageUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('audio/')) {
      return { type: 'audio_url', audioUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('video/')) {
      return { type: 'video_url', videoUrl: { url: block.uri } };
    }
    return null;
  }

  return null;
}

/**
 * A {@link Toolset} backed by an MCP server.
 *
 * Construct an instance via {@link MCPToolset.connect}, which performs a
 * `tools/list` against the supplied {@link MCPClient} and caches the result.
 * Tool invocations are forwarded over the same client and the MCP content
 * blocks are converted back into kosong {@link ContentPart}s.
 */
export class MCPToolset implements Toolset {
  readonly tools: Tool[];

  private constructor(
    private readonly client: MCPClient,
    private readonly toolMap: Map<string, MCPToolEntry>,
  ) {
    this.tools = [...toolMap.values()].map((entry) => entry.tool);
  }

  /**
   * Connect to an MCP server and discover its tools.
   *
   * The returned toolset holds a snapshot of the tool list at connection
   * time; re-connect to pick up tools added or removed afterwards.
   */
  static async connect(client: MCPClient): Promise<MCPToolset> {
    const mcpTools = await client.listTools();
    const toolMap = new Map<string, MCPToolEntry>();

    for (const mcpTool of mcpTools) {
      const tool: Tool = {
        name: mcpTool.name,
        description: mcpTool.description,
        parameters: mcpTool.inputSchema,
      };
      toolMap.set(mcpTool.name, {
        tool,
        validator: compileToolArgsValidator(mcpTool.inputSchema),
      });
    }

    return new MCPToolset(client, toolMap);
  }

  async handle(toolCall: ToolCall): Promise<ToolResult> {
    const entry = this.toolMap.get(toolCall.function.name);
    if (entry === undefined) {
      return {
        toolCallId: toolCall.id,
        returnValue: toolNotFoundError(toolCall.function.name),
      };
    }

    let args: Record<string, unknown>;
    try {
      const raw = toolCall.function.arguments ?? '{}';
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          toolCallId: toolCall.id,
          returnValue: toolParseError('Tool arguments must be a JSON object'),
        };
      }
      args = parsed as Record<string, unknown>;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        toolCallId: toolCall.id,
        returnValue: toolParseError(`Failed to parse tool arguments: ${msg}`),
      };
    }

    const validationError = validateToolArgs(entry.validator, args as unknown as JsonType);
    if (validationError !== null) {
      return {
        toolCallId: toolCall.id,
        returnValue: toolValidateError(validationError),
      };
    }

    let mcpResult: MCPToolResult;
    try {
      mcpResult = await this.client.callTool(toolCall.function.name, args);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        toolCallId: toolCall.id,
        returnValue: toolRuntimeError(`MCP tool call failed: ${msg}`),
      };
    }

    const parts: ContentPart[] = [];
    for (const block of mcpResult.content) {
      const part = convertMCPContentBlock(block);
      if (part !== null) {
        parts.push(part);
      }
    }

    // Collapse a single text part to a plain string output; otherwise pass
    // the ContentPart[] through so the model sees rich content.
    let output: string | ContentPart[];
    if (parts.length === 1 && parts[0]?.type === 'text') {
      output = parts[0].text;
    } else {
      output = parts;
    }

    const returnValue: ToolReturnValue = {
      isError: mcpResult.isError,
      output,
      message: '',
      display: [],
    };

    return { toolCallId: toolCall.id, returnValue };
  }
}
