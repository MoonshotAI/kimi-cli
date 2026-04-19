import type { WireClient } from '../wire/client.js';
import type { SessionErrorData, TurnEndData } from '../wire/events.js';
import type { InputFormat, OutputFormat } from '../cli/options.js';
import { ExitCode, classifySessionError, createPrinter } from './printers.js';
import { readStdinText, createStdinLineReader } from '../utils/stdin.js';

// ── Types ──────────────────────────────────────────────────────────

export interface PrintModeParams {
  wireClient: WireClient;
  sessionId: string;
  prompt: string | undefined;
  inputFormat: InputFormat;
  outputFormat: OutputFormat;
  finalMessageOnly: boolean;
}

// ── stream-json input parser ───────────────────────────────────────

async function readNextStreamJsonCommand(
  lines: AsyncIterator<string>,
): Promise<string | null> {
  while (true) {
    const { value, done } = await lines.next();
    if (done) return null;
    const trimmed = (value as string).trim();
    if (!trimmed) continue;

    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      if (data['role'] === 'user') {
        const content = data['content'];
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return (content as Array<Record<string, unknown>>)
            .filter((p) => p['type'] === 'text' && typeof p['text'] === 'string')
            .map((p) => p['text'] as string)
            .join('\n');
        }
        return String(content);
      }
      process.stderr.write(`warning: ignoring message with role "${String(data['role'])}"\n`);
    } catch {
      process.stderr.write(`warning: ignoring invalid JSON line\n`);
    }
  }
}

// ── Execute one turn ───────────────────────────────────────────────

async function executeTurn(
  wireClient: WireClient,
  sessionId: string,
  command: string,
  outputFormat: OutputFormat,
  finalMessageOnly: boolean,
): Promise<number> {
  const printer = createPrinter(outputFormat, finalMessageOnly);

  await wireClient.prompt(sessionId, command);

  let exitCode: number = ExitCode.SUCCESS;

  for await (const msg of wireClient.subscribe(sessionId)) {
    if (msg.method === 'session.error') {
      const errorData = msg.data as SessionErrorData;
      process.stderr.write(`error: ${errorData.error}\n`);
      exitCode = classifySessionError(errorData);
      break;
    }

    printer.feed(msg);

    if (msg.method === 'turn.end') {
      const turnData = msg.data as TurnEndData;
      if (!turnData.success) {
        exitCode = ExitCode.FAILURE;
      }
      break;
    }
  }

  printer.flush();
  return exitCode;
}

// ── Main entry point ───────────────────────────────────────────────

export async function runPrintMode(params: PrintModeParams): Promise<number> {
  const {
    wireClient,
    sessionId,
    prompt,
    inputFormat,
    outputFormat,
    finalMessageOnly,
  } = params;

  // SIGINT cancels the current turn
  let cancelled = false;
  const onSigint = () => {
    cancelled = true;
    void wireClient.cancel(sessionId);
  };
  process.on('SIGINT', onSigint);

  try {
    // Print mode implies yolo — auto-approve all actions
    await wireClient.setYolo(sessionId, true);

    let command: string | undefined | null = prompt;

    // Read initial command from stdin for text mode
    if (command === undefined && !process.stdin.isTTY && inputFormat === 'text') {
      command = await readStdinText();
    }

    if (inputFormat === 'text') {
      // Single execution mode
      if (!command) return ExitCode.SUCCESS;
      const exitCode = await executeTurn(wireClient, sessionId, command, outputFormat, finalMessageOnly);
      return cancelled ? ExitCode.FAILURE : exitCode;
    }

    // stream-json: loop reading JSON lines
    const lineIterator = createStdinLineReader()[Symbol.asyncIterator]();

    // If a prompt was given via --prompt, execute it first
    if (command) {
      const exitCode = await executeTurn(wireClient, sessionId, command, outputFormat, finalMessageOnly);
      if (exitCode !== ExitCode.SUCCESS || cancelled) return cancelled ? ExitCode.FAILURE : exitCode;
    }

    // Read subsequent commands from stdin
    while (!cancelled) {
      const nextCommand = await readNextStreamJsonCommand(lineIterator);
      if (nextCommand === null) return ExitCode.SUCCESS;
      if (!nextCommand) continue;
      const exitCode = await executeTurn(wireClient, sessionId, nextCommand, outputFormat, finalMessageOnly);
      if (exitCode !== ExitCode.SUCCESS || cancelled) return cancelled ? ExitCode.FAILURE : exitCode;
    }

    return ExitCode.FAILURE;
  } finally {
    process.off('SIGINT', onSigint);
  }
}
