import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { canonical, hash, home, now, readJSON, safeId, sessionPath } from './store.ts';

export function providerName(p: string) {
  if (!['codex', 'claude'].includes(p)) throw new Error('Provider must be codex or claude.');
  return p;
}
export function version(provider: string) {
  const r = spawnSync(provider, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : 'unavailable';
}
function* walk(dir: string, depth = 0): Generator<string> {
  if (!fs.existsSync(dir) || depth > 8) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}
function firstMetadata(file: string) {
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(256 * 1024);
  let n: number; try { n = fs.readSync(fd, b, 0, b.length, 0); } finally { fs.closeSync(fd); }
  for (const l of b.subarray(0, n).toString('utf8').split('\n')) {
    try {
      const d = JSON.parse(l);
      if (d.type === 'session_meta') return { id: d.payload.id || d.payload.session_id, cwd: d.payload.cwd, mode: d.payload.history_mode };
      if (d.cwd && d.sessionId) return { id: d.sessionId, cwd: d.cwd, mode: 'transcript' };
    } catch { /* A partial prefix is not session metadata. */ }
  }
  return null;
}
export function sessions(provider: string, cwd: string, id?: string) {
  providerName(provider); cwd = canonical(cwd); if (id) safeId(id);
  const root = provider === 'codex' ? path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'sessions') : path.join(home(), '.claude/projects');
  const result: any[] = [];
  for (const file of walk(root)) {
    if (id && !path.basename(file).includes(id)) continue;
    const m = firstMetadata(file);
    if (!m || (id && m.id !== id)) continue;
    try { if (canonical(m.cwd) !== cwd) continue; } catch { continue; }
    result.push({ ...m, transcript: file, modifiedAt: fs.statSync(file).mtime.toISOString() });
  }
  return result.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
export function identity(provider: string, cwd: string, explicit?: string) {
  providerName(provider);
  const id = explicit || (provider === 'codex' ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_SESSION_ID);
  if (!id) {
    const candidates = sessions(provider, cwd);
    throw new Error(`Exact ${provider} session ID is required; use --session ID.${candidates.length ? '\nCandidates:\n' + candidates.map(s => `  ${s.id}  ${s.modifiedAt}`).join('\n') : ''}`);
  }
  safeId(id);
  const registered = readJSON(sessionPath(provider, id), null);
  if (registered && canonical(registered.cwd) === canonical(cwd)) return { id, ...registered };
  return { id, ...sessions(provider, cwd, id)[0] };
}

// Only read-only protocol methods are permitted in this client.
export class CodexRPC {
  child: ReturnType<typeof spawn>;
  pending = new Map<number, any>();
  seq = 0;
  stderr = '';
  constructor(binary = 'codex') {
    this.child = spawn(binary, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on('line', line => {
      try {
        const d = JSON.parse(line); const entry = this.pending.get(d.id);
        if (!entry) return;
        this.pending.delete(d.id); clearTimeout(entry.timer);
        if (d.error) entry.reject(new Error(`${entry.method}: ${d.error.message}`)); else entry.resolve(d.result);
      } catch { /* Server log lines are not protocol messages. */ }
    });
    this.child.stderr!.on('data', b => { this.stderr = (this.stderr + b).slice(-2000); });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', code => this.fail(new Error(`Codex app-server exited (${code}). ${this.stderr}`)));
  }
  fail(e: Error) { for (const v of this.pending.values()) { clearTimeout(v.timer); v.reject(e); } this.pending.clear(); }
  async call(method: string, params: any) {
    if (!['initialize', 'thread/read', 'thread/turns/list', 'thread/items/list'].includes(method)) throw new Error('Non-read-only RPC denied.');
    return await new Promise<any>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out reading ${method}.`)); }, 12000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async init() {
    await this.call('initialize', { clientInfo: { name: 'cli-handoff', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.child.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  close() { this.fail(new Error('RPC closed.')); this.child.kill(); }
}
export async function pages(rpc: any, method: string, params: any) {
  const all: any[] = []; const seen = new Set(); let cursor: any;
  do {
    const page = await rpc.call(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error('Invalid paginated history response.');
    all.push(...page.data); cursor = page.nextCursor;
    if (cursor && seen.has(JSON.stringify(cursor))) throw new Error('History pagination repeated a cursor.');
    seen.add(JSON.stringify(cursor));
  } while (cursor);
  return all;
}
function event(provider: string, session: string, kind: string, data: any, id?: string, timestamp?: string) {
  return { id: id || hash(JSON.stringify(data)), provider, session, kind, timestamp: timestamp || null, data };
}
function publicEvent(provider: string, session: string, item: any, timestamp?: string) {
  const type = item.type || 'unknown';
  if (['reasoning', 'thinking', 'redacted_thinking'].includes(type)) return null;
  return event(provider, session, type, item, item.id || item.uuid, timestamp);
}
export async function codexHistory(id: string, cwd: string, binary?: string) {
  const rpc = new CodexRPC(binary); const capturedAt = now();
  try {
    await rpc.init();
    const { thread } = await rpc.call('thread/read', { threadId: id, includeTurns: false });
    if (thread.id !== id || canonical(thread.cwd) !== canonical(cwd)) throw new Error('Codex thread does not match the selected workspace/session.');
    let turns: any[]; let items: any[];
    if (thread.historyMode === 'paginated') {
      // Page both turns and items: a turn can itself contain more than one item page.
      turns = await pages(rpc, 'thread/turns/list', { threadId: id, limit: 100, sortDirection: 'asc', itemsView: 'notLoaded' });
      items = await pages(rpc, 'thread/items/list', { threadId: id, limit: 100, sortDirection: 'asc' });
    } else {
      const full = await rpc.call('thread/read', { threadId: id, includeTurns: true });
      turns = full.thread.turns;
      items = turns.flatMap(t => t.items.map((item: any) => ({ turnId: t.id, item })));
    }
    const warnings: string[] = [];
    if (turns.some(t => t.status === 'inProgress')) warnings.push('Source turn is active; export ends at the captured persisted history, before its future confirmation.');
    if (thread.forkedFromId) warnings.push(`Forked from ${thread.forkedFromId}; inherited history availability depends on the native store.`);
    if (items.some(x => x.item.type === 'contextCompaction')) warnings.push('Compaction is present; pre-compaction availability depends on the native store.');
    const events = items.map(x => { const e = publicEvent('codex', id, x.item, x.startedAtMs ? new Date(x.startedAtMs).toISOString() : undefined); return e ? { ...e, turnId: x.turnId } : null; }).filter(Boolean);
    warnings.push('Private reasoning is excluded. Linked Codex subagent histories and external attachments are referenced, not recursively captured.');
    return { events, source: { provider: 'codex', id, cliVersion: thread.cliVersion, method: 'app-server', historyMode: thread.historyMode }, capturedAt, warnings, raw: JSON.stringify({ thread: { id, cwd: thread.cwd, historyMode: thread.historyMode }, turns: turns.map(({ items, ...t }) => t), items: items.filter(x => x.item.type !== 'reasoning') }, null, 2) };
  } finally { rpc.close(); }
}
export async function readTranscript(file: string) {
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
  const records: any[] = []; let raw = ''; const warnings: string[] = [];
  const malformed: number[] = [];
  const stream = fs.createReadStream(file, { fd, autoClose: true, start: 0, ...(size ? { end: size - 1 } : {}) });
  if (!size) { stream.destroy(); return { records, raw, warnings, bytes: 0 }; }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lastEnded = false; stream.on('data', b => { lastEnded = b[b.length - 1] === 10; });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); records.push(d); raw += line + '\n'; }
    catch { malformed.push(lineNumber); }
  }
  if (malformed.some(n => n !== lineNumber) || (malformed.length && lastEnded)) throw new Error(`Corrupt transcript record at line ${malformed[0]}.`);
  if (malformed.length) warnings.push(`Incomplete or malformed final transcript record at line ${lineNumber} omitted.`);
  if (!lastEnded) warnings.push('Transcript ends without a newline; captured valid records through the initial byte cutoff.');
  return { records, raw, warnings, bytes: size };
}
function normalizeRecord(provider: string, id: string, record: any): any[] {
  if (provider === 'codex') {
    if (record.type === 'response_item') {
      const p = record.payload;
      if (p.role === 'system' || p.role === 'developer') return [];
      const e = publicEvent(provider, id, p, record.timestamp); return e ? [e] : [];
    }
    if (record.type === 'compacted') return [event(provider, id, 'compaction', record.payload, undefined, record.timestamp)];
    return [];
  }
  if (['user', 'assistant'].includes(record.type)) {
    const m = record.message;
    if (!m) return [];
    const content = Array.isArray(m.content) ? m.content.filter((c: any) => !['thinking', 'redacted_thinking'].includes(c.type)) : m.content;
    return [event(provider, id, record.type === 'user' ? 'userMessage' : 'agentMessage', { role: record.type, content }, record.uuid, record.timestamp)];
  }
  if (record.type === 'system' && record.subtype === 'compact_boundary') return [event(provider, id, 'compaction', record, record.uuid, record.timestamp)];
  if (record.type === 'attachment') return [event(provider, id, 'attachment', record.attachment, record.uuid, record.timestamp)];
  return [];
}
export async function transcriptHistory(provider: string, id: string, cwd: string, file: string) {
  const metadata = firstMetadata(file);
  if (!metadata || metadata.id !== id || canonical(metadata.cwd) !== canonical(cwd)) throw new Error('Transcript does not match the selected session and workspace.');
  if (provider === 'codex' && metadata.mode === 'paginated') throw new Error('Paginated Codex history requires app-server access; a legacy transcript would be incomplete.');
  const source = await readTranscript(file); const warnings = [...source.warnings];
  const events = source.records.flatMap(d => normalizeRecord(provider, id, d));
  // Preserve non-reasoning native records for version-specific inspection, stripping native system instructions.
  const rawRecords = source.records.filter(d => !(provider === 'codex' && ['turn_context', 'world_state'].includes(d.type))).map(d => {
    if (provider === 'codex' && d.type === 'session_meta') return { type: d.type, payload: metadata };
    if (provider === 'codex' && d.type === 'response_item' && ['reasoning'].includes(d.payload.type)) return null;
    if (provider === 'codex' && d.type === 'event_msg' && d.payload?.item?.type === 'reasoning') return null;
    if (provider === 'codex' && d.type === 'event_msg' && ['agent_reasoning', 'agent_reasoning_raw_content'].includes(d.payload?.type)) return null;
    if (provider === 'codex' && d.type === 'response_item' && ['system', 'developer'].includes(d.payload.role)) return null;
    if (d.message && Array.isArray(d.message.content)) return { ...d, message: { ...d.message, content: d.message.content.filter((c: any) => !['thinking', 'redacted_thinking'].includes(c.type)) } };
    return d;
  }).filter(Boolean);
  if (events.some(e => e.kind === 'compaction')) warnings.push('Compaction boundary present; available persisted records are archived, but deleted pre-compaction records cannot be recovered.');
  if (provider === 'claude') {
    const linked = path.join(path.dirname(file), id, 'subagents');
    for (const child of walk(linked)) {
      const sub = await readTranscript(child); warnings.push(...sub.warnings);
      const childId = path.basename(child, '.jsonl');
      events.push(...sub.records.flatMap(d => normalizeRecord(provider, childId, d)).map(e => ({ ...e, parentSession: id })));
    }
  }
  warnings.push('Private reasoning is excluded. External attachments are referenced rather than copied.');
  return { events, source: { provider, id, cliVersion: version(provider), method: 'transcript', transcript: file, historyMode: metadata.mode }, capturedAt: now(), cutoffBytes: source.bytes, warnings, raw: rawRecords.map(d => JSON.stringify(d)).join('\n') + '\n' };
}
export async function capture(provider: string, cwd: string, session?: string, transcript?: string) {
  const selected = identity(provider, cwd, session);
  if (provider === 'codex' && !transcript) {
    try { return await codexHistory(selected.id, cwd); }
    catch (e) {
      if (!selected.transcript) throw e;
      const fallback = await transcriptHistory(provider, selected.id, cwd, selected.transcript);
      fallback.warnings.push(`App-server unavailable; used legacy transcript: ${(e as Error).message}`);
      return fallback;
    }
  }
  const file = transcript || selected.transcript;
  if (!file) throw new Error(`No transcript found for ${selected.id}. Run handoff sessions --provider ${provider}, or supply --transcript PATH.`);
  return await transcriptHistory(provider, selected.id, cwd, file);
}
export function eventText(e: any): string {
  const d = e.data;
  if (e.kind === 'message') return `[${d.role}] ${contentText(d.content)}`;
  if (['userMessage', 'agentMessage'].includes(e.kind)) return `[${d.role || (e.kind === 'userMessage' ? 'user' : 'assistant')}] ${d.text || contentText(d.content)}`;
  if (e.kind === 'reasoning') return '';
  return `[${e.kind}] ${JSON.stringify(d)}`;
}
function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map(c => c.text || (['input_text', 'output_text', 'text'].includes(c.type) ? '' : JSON.stringify(c))).join('\n');
}
