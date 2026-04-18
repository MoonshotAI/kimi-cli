#!/usr/bin/env node
// Phase 21 Section A.6.2 smoke: session.setModel round-trip must not return -32601.
// Launches --wire, inits, creates a session, flips the model, verifies ok.
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
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const killer = setTimeout(() => child.kill(), 15000);

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

send({ id: 'req_init', time: Date.now(), session_id: '__process__', type: 'request', from: 'smoke', to: 'core', method: 'initialize' });
await wait(500);
send({ id: 'req_create', time: Date.now(), session_id: '__process__', type: 'request', from: 'smoke', to: 'core', method: 'session.create', data: { model: 'kimi-k2-5' } });
await wait(1500);
const createResp = frames.find((f) => f.request_id === 'req_create');
if (!createResp) { console.error('FAIL: no session.create response. stderr:\n' + stderr); child.kill(); process.exit(1); }
if (createResp.error) { console.error('FAIL session.create:', JSON.stringify(createResp.error)); child.kill(); process.exit(1); }
const sid = createResp.data.session_id;

send({ id: 'req_setmodel', time: Date.now(), session_id: sid, type: 'request', from: 'smoke', to: 'core', method: 'session.setModel', data: { model: 'kimi-k2-0905-preview' } });
await wait(2500);

clearTimeout(killer);
child.stdin.end();
child.kill();

const setResp = frames.find((f) => f.request_id === 'req_setmodel');
if (!setResp) { console.error('FAIL: no session.setModel response. All frames:\n' + JSON.stringify(frames, null, 2)); process.exit(1); }
if (setResp.error) {
  console.error('FAIL session.setModel:', JSON.stringify(setResp.error));
  if (setResp.error.code === -32601) { console.error('-> still missing Method not found'); }
  process.exit(1);
}
console.log('PASS setModel response ok');
console.log('data=' + JSON.stringify(setResp.data));
