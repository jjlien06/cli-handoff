import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { isatty } from 'node:tty';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exportHandoff } from './engine.ts';
import { providerName } from './adapters.ts';
import { atomicJSON, canonical, dataRoot, mkdir, readJSON, selectRevision } from './store.ts';

export function switchController(provider: string, cwd: string) {
  const file = process.env.HANDOFF_CONTROL_FILE;
  const token = process.env.HANDOFF_CONTROL_TOKEN;
  if (!file || !token) throw new Error('This CLI was not launched by handoff start. Export remains available; start your next session with handoff start codex or handoff start claude to enable automatic switching.');
  const c = readJSON(file);
  if (c.version !== 1 || c.token !== token || c.provider !== provider || canonical(c.cwd) !== canonical(cwd) || c.state !== 'active') throw new Error('The terminal controller does not match this active session. No CLI was stopped.');
  try { process.kill(c.pid, 0); } catch { throw new Error('The terminal controller is no longer running. No CLI was stopped.'); }
  return { file, token, controller: c };
}
export async function switchHandoff(provider: string, args: any) {
  providerName(provider); const cwd = canonical(args.cwd);
  const target = providerName(args.target || (provider === 'codex' ? 'claude' : 'codex'));
  if (target === provider) throw new Error('The switch target must be the other CLI.');
  const control = switchController(provider, cwd); const lock = `${control.file}.switch.lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A terminal switch is already being saved.'); throw e; }
  try {
    if (fs.existsSync(`${control.file}.request`)) throw new Error('A terminal switch is already queued.');
    // Publish the archive before requesting any source shutdown. Failed exports keep the CLI open.
    const saved = await exportHandoff({ provider, ...args, cwd });
    switchController(provider, cwd);
    selectRevision(cwd, target, saved.id); // Validate the published archive before terminal transfer.
    atomicJSON(`${control.file}.request`, { version: 1, token: control.token, source: provider, target, cwd, handoff: saved.id, session: args.session });
    return { ...saved, switchingTo: target, terminal: 'same terminal', instruction: 'Handoff is saved. Stop working now; the terminal launcher will close this CLI and open the receiving CLI with this handoff selected.' };
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export async function startTerminal(provider: string, cwd: string, nativeArgs: string[] = []) {
  providerName(provider);
  if (!isatty(0) || !isatty(1)) throw new Error('handoff start requires an interactive terminal. Run it directly in your terminal, not inside an assistant tool or a pipe.');
  const dir = path.join(dataRoot(), 'controllers'); mkdir(dir);
  const control = path.join(dir, `${randomUUID()}.json`);
  const script = fileURLToPath(new URL('./terminal.py', import.meta.url));
  const env = { ...process.env }; delete env.CODEX_THREAD_ID; delete env.CLAUDE_SESSION_ID; delete env.CLAUDECODE;
  const python = (env.PATH || '').split(path.delimiter).map(p => path.join(p, 'python3')).find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (!python) throw new Error('Python 3 is required for same-terminal switching.');
  const args = [python, script, '--provider', provider, '--cwd', canonical(cwd), '--control', control, '--data', dataRoot(), '--', ...nativeArgs];
  const execEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (typeof process.execve === 'function') { process.execve(python, args, execEnv); return; }
  const child = spawn(python, args.slice(1), { cwd, env, stdio: [0, 1, 2] });
  const onTerm = () => child.kill('SIGTERM'); const onInt = () => child.kill('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try { await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', code => { process.exitCode = code ?? 1; resolve(); }); }); }
  finally { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); }

}
