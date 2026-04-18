#!/usr/bin/env node
// Phase 21 Section A.6.3 smoke: registerTool / listTools / removeTool round-trip.
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
const fail = (msg) => { console.error('FAIL:', msg, '\nstderr:\n' + stderr); child.kill(); process.exit(1); };

send({ id: 'req_init', time: Date.now(), session_id: '__process__', type: 'request', from: 'smoke', to: 'core', method: 'initialize' });
await wait(400);

send({ id: 'req_create', time: Date.now(), session_id: '__process__', type: 'request', from: 'smoke', to: 'core', method: 'session.create', data: { model: 'kimi-k2-5' } });
await wait(800);
const createResp = frames.find((f) => f.request_id === 'req_create');
if (!createResp || createResp.error) fail('session.create ' + JSON.stringify(createResp?.error));
const sid = createResp.data.session_id;

// Step 1: registerTool
send({
  id: 'req_register', time: Date.now(), session_id: sid,
  type: 'request', from: 'smoke', to: 'core', method: 'session.registerTool',
  data: { name: 'smoke_echo', description: 'echo back args', input_schema: { type: 'object' } },
});
await wait(500);
const regResp = frames.find((f) => f.request_id === 'req_register');
if (!regResp) fail('no registerTool response');
if (regResp.error) fail('registerTool error ' + JSON.stringify(regResp.error));

// Step 2: listTools should contain smoke_echo
send({ id: 'req_list1', time: Date.now(), session_id: sid, type: 'request', from: 'smoke', to: 'core', method: 'session.listTools' });
await wait(500);
const list1 = frames.find((f) => f.request_id === 'req_list1');
if (!list1) fail('no listTools response (1)');
if (list1.error) fail('listTools (1) error ' + JSON.stringify(list1.error));
const has1 = (list1.data?.tools ?? []).some((t) => t.name === 'smoke_echo');
if (!has1) fail('smoke_echo missing after registerTool; tools=' + JSON.stringify(list1.data?.tools));

// Step 3: removeTool
send({
  id: 'req_remove', time: Date.now(), session_id: sid,
  type: 'request', from: 'smoke', to: 'core', method: 'session.removeTool',
  data: { name: 'smoke_echo' },
});
await wait(500);
const remResp = frames.find((f) => f.request_id === 'req_remove');
if (!remResp) fail('no removeTool response');
if (remResp.error) fail('removeTool error ' + JSON.stringify(remResp.error));

// Step 4: listTools should NOT contain smoke_echo
send({ id: 'req_list2', time: Date.now(), session_id: sid, type: 'request', from: 'smoke', to: 'core', method: 'session.listTools' });
await wait(500);
const list2 = frames.find((f) => f.request_id === 'req_list2');
if (!list2) fail('no listTools response (2)');
if (list2.error) fail('listTools (2) error ' + JSON.stringify(list2.error));
const has2 = (list2.data?.tools ?? []).some((t) => t.name === 'smoke_echo');
if (has2) fail('smoke_echo still present after removeTool; tools=' + JSON.stringify(list2.data?.tools));

clearTimeout(killer);
child.stdin.end();
child.kill();

console.log('PASS registerTool/listTools/removeTool round-trip');
console.log('- register: ok');
console.log('- listTools#1: contains smoke_echo (tools=' + list1.data.tools.length + ')');
console.log('- removeTool: ok');
console.log('- listTools#2: excludes smoke_echo (tools=' + list2.data.tools.length + ')');
