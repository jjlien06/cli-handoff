import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { acknowledge, exportHandoff, historyText, importHandoff } from '../src/engine.ts';
import { capture, codexHistory, identity, pages, readTranscript } from '../src/adapters.ts';
import { changes, snapshot } from '../src/evidence.ts';
import { doctor, hook, install, uninstall } from '../src/integrations.ts';
import { atomicJSON, checkpointFields, index, indexPath, locked, readJSON, selectRevision, validateCheckpoint } from '../src/store.ts';
import { callTool, toolDefinitions } from '../src/mcp.ts';
import { switchHandoff } from '../src/switch.ts';

let base: string, cwd: string, checkpoint: string;
let saved: Record<string, string | undefined>;
const envKeys = ['HANDOFF_HOME', 'HANDOFF_DATA_DIR', 'CODEX_HOME', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'HANDOFF_CONTROL_FILE', 'HANDOFF_CONTROL_TOKEN'];
function git(args: string[]) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; }
function fixture(provider: string, id: string, text: string, extra = '') {
  const file = path.join(base, provider + '-' + id + '.jsonl');
  const rows = provider === 'codex' ? [
    { type: 'session_meta', payload: { id, cwd, history_mode: 'legacy' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
  ] : [
    { type: 'user', sessionId: id, cwd, uuid: id + '-user', message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: id, cwd, uuid: id + '-assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: 'Continue with the migration.' }] } },
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n' + extra); return file;
}
async function exported(provider = 'claude', id = 'session-a', text = 'Keep the API backwards compatible.') {
  return await exportHandoff({ provider, cwd, session: id, transcript: fixture(provider, id, text), checkpoint });
}
beforeEach(() => {
  saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-')); cwd = path.join(base, 'project'); fs.mkdirSync(cwd);
  process.env.HANDOFF_HOME = path.join(base, 'home'); process.env.HANDOFF_DATA_DIR = path.join(base, 'data'); process.env.CODEX_HOME = path.join(base, 'home/.codex');
  delete process.env.CODEX_THREAD_ID; delete process.env.CLAUDE_SESSION_ID;
  delete process.env.HANDOFF_CONTROL_FILE; delete process.env.HANDOFF_CONTROL_TOKEN;
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'original\n'); git(['add', '.']); git(['commit', '-qm', 'initial']);
  checkpoint = path.join(base, 'checkpoint.json');
  atomicJSON(checkpoint, { title: 'Migration', goal: 'Migrate the app', ...Object.fromEntries(checkpointFields.map(k => [k, []])), constraints: ['Keep the API backwards compatible.'], next: ['Update app.txt and verify compatibility.'] });
});
afterEach(() => {
  for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(base, { recursive: true, force: true });
});

test('roundtrip maintains lineage, exact constraints, and historical evidence', async () => {
  const first = await exported();
  const imported = importHandoff('codex', cwd);
  assert.match(imported.packet, /Keep the API backwards compatible/); assert.deepEqual(imported.changes, []);
  await acknowledge('codex', cwd, first.id, 'target-codex');
  const second = await exported('codex', 'target-codex', 'Now also keep the CLI flag names.');
  assert.equal(second.taskId, first.taskId);
  const selected = selectRevision(cwd, 'claude', second.id);
  assert.equal(selected.manifest.parentRevision, first.id);
  assert.match(importHandoff('claude', cwd).packet, /Keep the API backwards compatible/);
  const history = await historyText(cwd, second.id);
  assert.ok(history.events.some(e => e.text.includes('CLI flag names')));
  assert.ok(history.events.some(e => e.text.includes('backwards compatible')));
  assert.ok(!history.events.some(e => e.text.includes('PRIVATE_REASONING')));
  await acknowledge('claude', cwd, second.id, 'target-claude');
  const third = await exported('claude', 'target-claude', 'Continue the same task.');
  assert.equal(third.taskId, first.taskId);
  assert.equal(selectRevision(cwd, undefined, third.id).manifest.parentRevision, second.id);
});
test('separate pending tasks require a choice instead of newest-session guessing', async () => {
  await exported('claude', 'session-a'); await exported('claude', 'session-b');
  assert.throws(() => importHandoff('codex', cwd), /Choose a handoff ID/);
  assert.throws(() => identity('claude', cwd), /Exact claude session ID is required/);
});
test('detects live source, instruction, and untracked-file changes', async () => {
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'Preserve names.');
  const r = await exported();
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'new'); fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'New rules.'); fs.writeFileSync(path.join(cwd, 'new.txt'), 'new');
  const imported = importHandoff('codex', cwd, r.id);
  assert.ok(imported.changes.includes('File changed: app.txt'));
  assert.ok(imported.changes.some(x => x.startsWith('Instruction changed:')));
  assert.ok(imported.changes.includes('File changed: new.txt'));
});
test('integrity checks prevent loading modified archives', async () => {
  const r = await exported(); fs.appendFileSync(path.join(r.directory, 'handoff.md'), 'injected');
  assert.throws(() => importHandoff('codex', cwd, r.id), /integrity check failed/);
});
test('ignores incomplete final JSONL record but rejects corruption in the middle', async () => {
  const file = fixture('claude', 'a', 'text', '{"incomplete":');
  const r = await readTranscript(file); assert.equal(r.records.length, 2); assert.ok(r.warnings.length);
  fs.writeFileSync(file, '{broken}\n' + JSON.stringify({ type: 'user' }) + '\n');
  await assert.rejects(readTranscript(file), /Corrupt transcript/);
});
test('rejects mismatched session/workspace and paginated transcript fallback', async () => {
  const file = fixture('codex', 'a', 'text');
  await assert.rejects(capture('codex', cwd, 'b', file), /does not match/);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('legacy', 'paginated'));
  await assert.rejects(capture('codex', cwd, 'a', file), /requires app-server/);
});
test('schema rejects malformed checkpoint fields', () => {
  const c = readJSON(checkpoint); c.constraints = 'oops'; assert.throws(() => validateCheckpoint(c), /array of strings/);
});
test('credential files are omitted from stored patches and fingerprints', () => {
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=before'); git(['add', '.env']); git(['commit', '-qm', 'fixture secret']); fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=after');
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'public edit');
  const s = snapshot(cwd); assert.ok(s.state.omitted.includes('.env')); assert.ok(!s.unstaged.includes('SECRET')); assert.match(s.unstaged, /public edit/); assert.ok(!s.state.files['.env']);
});
test('installer preserves unrelated settings, reinstalls once, and uninstalls owned entries', () => {
  const settings = path.join(process.env.HANDOFF_HOME!, '.claude/settings.json');
  atomicJSON(settings, { theme: 'test', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } });
  install(); install(); const d = readJSON(settings);
  assert.equal(d.theme, 'test'); assert.equal(d.hooks.SessionStart.length, 2);
  d.newSetting = true; atomicJSON(settings, d);
  const result = uninstall(); assert.ok(result.removed.length > 0);
  assert.deepEqual(readJSON(settings), { theme: 'test', newSetting: true, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } });
  assert.ok(!doctor().installed);
});
test('installer refuses to overwrite user-managed skills', () => {
  const file = path.join(process.env.CODEX_HOME!, 'skills/export-sync/SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'User content');
  assert.throws(() => install(), /user-managed file/); assert.equal(fs.readFileSync(file, 'utf8'), 'User content');
  assert.ok(!fs.existsSync(path.join(process.env.HANDOFF_HOME!, '.local/bin/handoff')));
});
test('hook binds the exact native session and advertises only this workspace', async () => {
  const r = await exported();
  const output = hook('codex', { session_id: 'hook-session', cwd, transcript_path: null, hook_event_name: 'SessionStart' });
  assert.match(output.hookSpecificOutput.additionalContext, /hook-session/);
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(r.id));
});
test('pagination exhausts all pages and detects repeated cursors', async () => {
  const calls: any[] = [];
  const rpc = { call: async (_: string, params: any) => { calls.push(params); return params.cursor ? { data: [2], nextCursor: null } : { data: [1], nextCursor: 'next' }; } };
  assert.deepEqual(await pages(rpc, 'thread/items/list', {}), [1, 2]); assert.equal(calls.length, 2);
  await assert.rejects(pages({ call: async () => ({ data: [], nextCursor: 'same' }) }, 'x', {}), /repeated a cursor/);
});
test('workspace lock prevents competing writes and cleans up on failure', async () => {
  await locked(cwd, async () => { await assert.rejects(locked(cwd, () => {}), /holds the workspace lock/); });
  await assert.rejects(locked(cwd, () => { throw new Error('failure'); }), /failure/);
  await locked(cwd, () => assert.ok(true));
});
test('history search supports paging across revisions without duplicating a native event', async () => {
  const a = await exported(); const b = await exported(); assert.equal(a.taskId, b.taskId);
  const h = await historyText(cwd, b.id, 'compatible', 1);
  assert.equal(h.total, 1); assert.equal(h.returned, 1); assert.equal(h.nextOffset, null);
});
test('short handoff IDs resolve uniquely and unsafe IDs never escape the store', async () => {
  const r = await exported(); assert.equal(selectRevision(cwd, undefined, r.id.slice(0, 8)).row.id, r.id);
  await assert.rejects(acknowledge('codex', cwd, r.id, '../../bad'), /Invalid ID/);
});
test('consuming the latest export does not resurrect earlier pending revisions', async () => {
  await exported(); const latest = await exported();
  await acknowledge('codex', cwd, latest.id, 'receiving-session');
  assert.throws(() => importHandoff('codex', cwd), /No pending handoff/);
  const context = hook('codex', { session_id: 'new-tab', cwd, hook_event_name: 'SessionStart' });
  assert.ok(!context.hookSpecificOutput.additionalContext.includes('is available'));
});
test('read-only Codex adapter reads all item pages and filters private reasoning', async () => {
  const binary = path.join(base, 'fake-codex.mjs');
  const source = `#!/usr/bin/env node\nimport {createInterface} from 'node:readline';\nconst lines=createInterface({input:process.stdin});\nlines.on('line',line=>{const d=JSON.parse(line);if(!d.id)return;let result;\nswitch(d.method){\ncase 'initialize':result={};break;\ncase 'thread/read':result={thread:{id:'native-session',cwd:${JSON.stringify(cwd)},historyMode:'paginated',cliVersion:'test'}};break;\ncase 'thread/turns/list':result={data:[{id:'turn-1',status:'completed'}],nextCursor:null};break;\ncase 'thread/items/list':result=d.params.cursor?{data:[{turnId:'turn-1',item:{type:'agentMessage',id:'b',text:'kept public reply'}},{turnId:'turn-1',item:{type:'reasoning',id:'private',content:['PRIVATE']}}],nextCursor:null}:{data:[{turnId:'turn-1',item:{type:'userMessage',id:'a',content:[{type:'text',text:'kept public goal'}]}}],nextCursor:'next-page'};break;\ndefault:process.exit(2);}\nprocess.stdout.write(JSON.stringify({id:d.id,result})+'\\n');});\n`;
  fs.writeFileSync(binary, source, { mode: 0o755 });
  const result = await codexHistory('native-session', cwd, binary);
  assert.equal(result.events.length, 2); assert.ok(result.raw.includes('kept public reply')); assert.ok(!result.raw.includes('PRIVATE'));
});
test('connected tools export inline checkpoints and maintain the same task on import/ack', async () => {
  const source = fixture('claude', 'mcp-source', 'Preserve the sentinel.');
  const native = path.join(process.env.HANDOFF_HOME!, '.claude/projects/project/mcp-source.jsonl');
  fs.mkdirSync(path.dirname(native), { recursive: true }); fs.copyFileSync(source, native);
  const r = await callTool('claude', 'handoff_export', { cwd, session: 'mcp-source', checkpoint: readJSON(checkpoint) });
  const imported = await callTool('codex', 'handoff_import', { cwd });
  assert.equal(imported.id, r.id); assert.match(imported.packet, /backwards compatible/);
  const bound = await callTool('codex', 'handoff_ack', { cwd, id: r.id, session: 'mcp-target' });
  assert.equal(bound.taskId, r.taskId);
  await assert.rejects(callTool('claude', 'handoff_import', { cwd, unexpected: true }), /Unknown argument/);
  await assert.rejects(callTool('claude', 'handoff_history', { cwd, id: r.id, limit: 0 }), /Invalid limit/);
});
test('stdio MCP handshake and tool errors use valid protocol messages only', () => {
  const messages = [
    null,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'handoff_history', arguments: { cwd, id: 'missing' } } },
  ];
  const r = spawnSync(process.execPath, [path.resolve('src/cli.ts'), 'mcp', '--provider', 'claude'], { cwd: path.resolve('.'), env: process.env, encoding: 'utf8', input: messages.map(m => JSON.stringify(m)).join('\n') + '\n' });
  assert.equal(r.status, 0, r.stderr);
  const replies = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(replies.length, 4);
  assert.equal(replies.find(d => d.id === null).error.code, -32600);
  assert.equal(replies.find(d => d.id === 1).result.protocolVersion, '2025-06-18');
  assert.equal(replies.find(d => d.id === 2).result.tools.length, toolDefinitions.length);
  assert.equal(replies.find(d => d.id === 3).result.isError, true);
});
test('CLI supports checkpoint JSON on stdin without creating a draft', () => {
  const source = fixture('claude', 'stdin-source', 'Preserve stdin constraints.');
  const r = spawnSync(process.execPath, [path.resolve('src/cli.ts'), 'export', '--provider', 'claude', '--session', 'stdin-source', '--checkpoint', '-', '--cwd', cwd, '--transcript', source], { encoding: 'utf8', env: process.env, input: JSON.stringify(readJSON(checkpoint)) });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout); assert.equal(result.source, 'claude'); assert.ok(result.id);
});
test('divergent sessions on one task remain explicit choices rather than last-writer wins', async () => {
  const origin = await exported();
  await acknowledge('codex', cwd, origin.id, 'branch-a');
  await acknowledge('codex', cwd, origin.id, 'branch-b');
  const a = await exported('codex', 'branch-a', 'Change A.');
  const b = await exported('codex', 'branch-b', 'Change B.');
  assert.equal(a.taskId, b.taskId);
  assert.equal(selectRevision(cwd, undefined, a.id).manifest.parentRevision, origin.id);
  assert.equal(selectRevision(cwd, undefined, b.id).manifest.parentRevision, origin.id);
  assert.throws(() => importHandoff('claude', cwd), /Choose a handoff ID/);
});
function controller(provider = 'claude') {
  process.env.HANDOFF_CONTROL_FILE = path.join(base, 'controller.json');
  process.env.HANDOFF_CONTROL_TOKEN = 'test-token';
  atomicJSON(process.env.HANDOFF_CONTROL_FILE, { version: 1, token: 'test-token', cwd, provider, pid: process.pid, state: 'active' });
  return process.env.HANDOFF_CONTROL_FILE;
}
test('switch publishes and validates a saved archive before queuing terminal transfer', async () => {
  const file = controller();
  const r = await switchHandoff('claude', { cwd, session: 'switch-source', checkpoint: readJSON(checkpoint), transcript: fixture('claude', 'switch-source', 'Keep constraints.') });
  const request = readJSON(file + '.request');
  assert.equal(request.handoff, r.id); assert.equal(request.target, 'codex');
  assert.equal(selectRevision(cwd, 'codex', request.handoff).manifest.id, r.id);
  assert.ok(!fs.existsSync(file + '.switch.lock'));
});
test('unmanaged or stale controllers cannot export or stop a native session', async () => {
  const args = { cwd, session: 'switch-source', checkpoint: readJSON(checkpoint) };
  await assert.rejects(switchHandoff('claude', args), /not launched by handoff start/);
  const file = controller(); process.env.HANDOFF_CONTROL_TOKEN = 'stale-token';
  await assert.rejects(switchHandoff('claude', args), /does not match/);
  assert.equal(index(cwd).revisions.length, 0); assert.ok(!fs.existsSync(file + '.request'));
});
test('failed switch export keeps controller active and never queues shutdown', async () => {
  const file = controller();
  const c = readJSON(checkpoint); c.goal = '';
  await assert.rejects(switchHandoff('claude', { cwd, session: 'a', checkpoint: c }), /nonempty goal/);
  assert.equal(readJSON(file).state, 'active'); assert.ok(!fs.existsSync(file + '.request')); assert.ok(!fs.existsSync(file + '.switch.lock'));
});
