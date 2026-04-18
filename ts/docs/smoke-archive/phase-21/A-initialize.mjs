#!/usr/bin/env node
// Phase 21 Section A.6.1 smoke: initialize methods >= 22 and contains 8 new methods.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const bin = resolve(process.cwd(), 'apps/kimi-cli/dist/index.mjs');
const child = spawn('node', [bin, '--wire'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const frames = [];
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line.length > 0) {
      try { frames.push(JSON.parse(line)); } catch {}
    }
  }
});

const killer = setTimeout(() => child.kill(), 8000);

child.stdin.write(JSON.stringify({
  id: 'req_smoke_init', time: Date.now(), session_id: '__process__',
  type: 'request', from: 'smoke', to: 'core', method: 'initialize',
}) + '\n');

await new Promise((r) => setTimeout(r, 1500));
clearTimeout(killer);
child.stdin.end();
child.kill();

const resp = frames.find((f) => f.request_id === 'req_smoke_init');
if (!resp) { console.error('FAIL: no response'); process.exit(1); }
if (resp.error) { console.error('FAIL:', JSON.stringify(resp.error)); process.exit(1); }
const methods = resp.data?.capabilities?.methods ?? [];
const need = [
  'session.setModel', 'session.setThinking', 'session.addSystemReminder',
  'session.registerTool', 'session.removeTool', 'session.listTools',
  'session.setActiveTools', 'session.unsubscribe',
];
const miss = need.filter((m) => !methods.includes(m));
if (miss.length) { console.error('FAIL missing:', miss.join(',')); process.exit(1); }
if (methods.length < 22) { console.error('FAIL methods count', methods.length, '< 22'); process.exit(1); }
console.log('PASS methods=' + methods.length);
console.log('includes: ' + need.join(', '));
