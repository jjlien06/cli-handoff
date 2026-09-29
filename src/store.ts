import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const home = () => process.env.HANDOFF_HOME || os.homedir();
export const dataRoot = () => process.env.HANDOFF_DATA_DIR || path.join(home(), '.local/share/cli-handoff');
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const canonical = (p: string) => fs.realpathSync(p);
export const workspaceId = (p: string) => hash(canonical(p)).slice(0, 24);
export const now = () => new Date().toISOString();
export function mkdir(p: string) { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); }
export function write(p: string, data: string | Buffer) { mkdir(path.dirname(p)); fs.writeFileSync(p, data, { mode: 0o600 }); }
export function readJSON(p: string, fallback?: any): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && arguments.length > 1) return fallback; throw e; }
}
export function atomicJSON(p: string, data: any) {
  const tmp = `${p}.${randomUUID()}.tmp`;
  write(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, p);
}
export function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid ID. Use the ID printed by handoff.');
  return id;
}
export const workspaceDir = (cwd: string) => path.join(dataRoot(), 'workspaces', workspaceId(cwd));
export const indexPath = (cwd: string) => path.join(workspaceDir(cwd), 'index.json');
export const sessionPath = (provider: string, id: string) => path.join(dataRoot(), 'sessions', provider, `${safeId(id)}.json`);
export function index(cwd: string) { return readJSON(indexPath(cwd), { version: 1, revisions: [], bindings: {} }); }
export async function locked<T>(cwd: string, fn: () => Promise<T> | T): Promise<T> {
  const dir = workspaceDir(cwd); mkdir(dir);
  const lock = path.join(dir, 'write.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const owner = readJSON(path.join(lock, 'owner.json'), null);
    throw new Error(`Another handoff operation holds the workspace lock${owner ? ` (PID ${owner.pid})` : ''}. Retry after it finishes; if it crashed, use handoff unlock.`);
  }
  try { atomicJSON(path.join(lock, 'owner.json'), { pid: process.pid, createdAt: now() }); return await fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export function unlock(cwd: string) {
  const lock = path.join(workspaceDir(cwd), 'write.lock');
  if (!fs.existsSync(lock)) return 'No lock exists.';
  const owner = readJSON(path.join(lock, 'owner.json'), null);
  if (!owner) throw new Error('Lock owner is unknown; inspect the lock directory before removing it.');
  try { process.kill(owner.pid, 0); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') { fs.rmSync(lock, { recursive: true }); return 'Removed stale lock.'; }
    throw e;
  }
  throw new Error(`PID ${owner.pid} is still running; refusing to remove its lock.`);
}
export function pendingRevisions(rows: any[], provider?: string) {
  const parents = new Set(rows.map(r => r.parentRevision).filter(Boolean));
  return rows.filter(r => !parents.has(r.id) && (!provider || r.source.provider !== provider) && (!provider || !r.consumed?.[provider]));
}
export function selectRevision(cwd: string, provider?: string, id?: string) {
  const idx = index(cwd);
  const rows = idx.revisions.filter((r: any) => !id || r.id === id || r.id.startsWith(id));
  let candidates = rows;
  if (!id) {
    // Only DAG heads are current; divergent sessions remain separate choices.
    candidates = pendingRevisions(rows, provider);
  }
  if (!candidates.length) throw new Error(id ? `No handoff matches ${id} in this workspace.` : 'No pending handoff here. Export from the other CLI first, or run handoff status.');
  if (candidates.length !== 1) throw new Error(`Choose a handoff ID:\n${candidates.map((r: any) => `  ${r.id}  ${r.source.provider}  ${r.title}`).join('\n')}`);
  const row = candidates[0];
  const dir = path.join(workspaceDir(cwd), 'tasks', safeId(row.taskId), 'revisions', safeId(row.id));
  const manifest = readJSON(path.join(dir, 'manifest.json'));
  if (manifest.version !== 1) throw new Error('Unsupported handoff schema version.');
  for (const [file, checksum] of Object.entries(manifest.files)) {
    if (file.includes('..') || path.isAbsolute(file)) throw new Error('Unsafe archive path.');
    if (hash(fs.readFileSync(path.join(dir, file))) !== checksum) throw new Error(`Archive integrity check failed: ${file}`);
  }
  return { row, dir, manifest };
}
export const checkpointFields = ['constraints', 'decisions', 'completed', 'active', 'next', 'questions', 'approvals', 'artifacts', 'running', 'tests'];
export function validateCheckpoint(c: any) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Checkpoint must be a JSON object.');
  for (const field of ['title', 'goal']) if (typeof c[field] !== 'string' || !c[field].trim()) throw new Error(`Checkpoint requires nonempty ${field}.`);
  for (const field of checkpointFields) {
    if (!Array.isArray(c[field]) || c[field].some((x: any) => typeof x !== 'string')) throw new Error(`Checkpoint ${field} must be an array of strings (use [] if empty).`);
  }
  return c;
}
