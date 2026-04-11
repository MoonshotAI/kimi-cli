import { CollectingSink, WIRE_PROTOCOL_VERSION } from '@moonshot-ai/core';

function main(): void {
  const sink = new CollectingSink();
  sink.emit({ type: 'step.begin', stepNumber: 0 });
  sink.emit({ type: 'step.end' });

  process.stdout.write(`kimi-cli (wire protocol ${WIRE_PROTOCOL_VERSION})\n`);
  process.stdout.write(`Events emitted: ${sink.events.length.toString()}\n`);
}

main();
