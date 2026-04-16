import { createInterface } from 'node:readline';

export function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

export async function* createStdinLineReader(): AsyncIterable<string> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    yield line;
  }
}
