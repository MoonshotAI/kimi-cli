#!/usr/bin/env node
// Phase 21 end-to-end review smoke — drive the production --wire server
// through a realistic session lifecycle using NO real LLM.
//
//   initialize → session.create → registerTool → listTools → addSystemReminder
//     → setThinking → setPlanMode → setYolo → unsubscribe → session.destroy
//
// The point is to confirm every method restored in Slice A actually
// round-trips through the production default-handlers (not the test
// helper), and that no wiring wart leaks after the setModel/picker
// hotfixes land.

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
      try { frames.push(JSON.parse(line)); } catch { /* malformed */ }
    }
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const killer = setTimeout(() => child.kill(), 20000);

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForResponse = async (reqId, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = frames.find((f) => f.request_id === reqId);
    if (resp) return resp;
    await wait(50);
  }
  throw new Error(`timeout waiting for ${reqId}`);
};

const failures = [];
const passes = [];

try {
  const init = await (async () => {
    send({
      id: 'req_init', time: Date.now(), session_id: '__process__',
      type: 'request', from: 'smoke', to: 'core', method: 'initialize',
    });
    return waitForResponse('req_init');
  })();
  if (init.error) failures.push(`initialize: ${JSON.stringify(init.error)}`);
  else {
    const m = init.data?.capabilities?.methods ?? [];
    if (m.length < 22) failures.push(`initialize methods<22 (got ${m.length})`);
    else passes.push(`initialize methods=${m.length}`);
  }

  send({
    id: 'req_create', time: Date.now(), session_id: '__process__',
    type: 'request', from: 'smoke', to: 'core', method: 'session.create',
    data: { model: 'kimi-k2-5' },
  });
  const create = await waitForResponse('req_create');
  if (create.error) {
    failures.push(`session.create: ${JSON.stringify(create.error)}`);
    throw new Error('cannot proceed without session');
  }
  const sid = create.data.session_id;
  passes.push(`session.create → ${sid}`);

  const probe = async (method, data, label = method) => {
    const id = `req_${method.replace(/\./g, '_')}_${Math.random().toString(16).slice(2, 6)}`;
    send({
      id, time: Date.now(), session_id: sid,
      type: 'request', from: 'smoke', to: 'core', method, ...(data !== undefined ? { data } : {}),
    });
    const resp = await waitForResponse(id);
    if (resp.error) {
      // Specifically flag -32601 as a regression.
      if (resp.error.code === -32601) failures.push(`${label}: -32601 Method not found (REGRESSION)`);
      else failures.push(`${label}: ${JSON.stringify(resp.error)}`);
    } else passes.push(label);
    return resp;
  };

  // Slice A restored methods
  await probe('session.registerTool', { name: 'smoke_echo', description: 'echo', input_schema: { type: 'object' } });
  const listResp = await probe('session.listTools', undefined, 'listTools#1');
  if (!listResp.error) {
    const tools = listResp.data?.tools ?? [];
    if (!tools.some((t) => t.name === 'smoke_echo')) failures.push('listTools#1 missing smoke_echo');
  }
  await probe('session.setActiveTools', { names: ['smoke_echo'] });
  await probe('session.removeTool', { name: 'smoke_echo' });
  const listResp2 = await probe('session.listTools', undefined, 'listTools#2');
  if (!listResp2.error) {
    const tools = listResp2.data?.tools ?? [];
    if (tools.some((t) => t.name === 'smoke_echo')) failures.push('listTools#2 still has smoke_echo');
  }
  await probe('session.addSystemReminder', { content: 'smoke-reminder' });
  await probe('session.setThinking', { level: 'high' });
  await probe('session.setPlanMode', { enabled: true });
  await probe('session.setYolo', { enabled: false });
  await probe('session.subscribe', { events: ['status.update', 'turn.begin'] });
  await probe('session.unsubscribe');
  await probe('session.setModel', { model: 'kimi-k2-0905-preview' });
  // After setModel ensure session.create (new session id) still round-trips.
  send({
    id: 'req_create2', time: Date.now(), session_id: '__process__',
    type: 'request', from: 'smoke', to: 'core', method: 'session.create',
    data: { model: 'kimi-k2-5' },
  });
  const create2 = await waitForResponse('req_create2');
  if (create2.error) failures.push(`session.create#2 after setModel: ${JSON.stringify(create2.error)}`);
  else passes.push(`session.create#2 after setModel → ${create2.data.session_id}`);
  // session.destroy is a process-scoped method (takes the target
  // session_id in `data`, not the envelope). Send directly.
  send({
    id: 'req_destroy', time: Date.now(), session_id: '__process__',
    type: 'request', from: 'smoke', to: 'core', method: 'session.destroy',
    data: { session_id: sid },
  });
  const destroy = await waitForResponse('req_destroy');
  if (destroy.error) failures.push(`session.destroy: ${JSON.stringify(destroy.error)}`);
  else passes.push('session.destroy');

} catch (err) {
  failures.push(`harness: ${err.message}`);
} finally {
  clearTimeout(killer);
  child.stdin.end();
  child.kill();
}

for (const p of passes) console.log('PASS', p);
for (const f of failures) console.error('FAIL', f);
if (stderr.length > 0) {
  console.log('--- stderr ---');
  process.stderr.write(stderr);
}
if (failures.length > 0) process.exit(1);
console.log('\nALL PASS');
