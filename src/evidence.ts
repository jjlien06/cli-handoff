import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonical, hash } from './store.ts';

export function git(cwd: string, args: string[], binary = false): any {
  const r = spawnSync('git', args, { cwd, encoding: binary ? undefined : 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}
const sensitive = (p: string) => /(^|\/)(\.env(?:\..*)?|\.aws|\.ssh|credentials(?:\..*)?|auth\.json|[^/]*\.(?:pem|key)|node_modules|\.git)(\/|$)/i.test(p);
function digestFile(p: string) {
  try {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink()) return { kind: 'symlink', hash: hash(fs.readlinkSync(p)) };
    if (!s.isFile()) return { kind: 'other' };
    if (s.size > 16 * 1024 * 1024) return { kind: 'large', size: s.size, mtimeMs: s.mtimeMs };
    return { kind: 'file', hash: hash(fs.readFileSync(p)) };
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }; throw e; }
}
export function snapshot(cwd: string, artifacts: string[] = []) {
  cwd = canonical(cwd);
  const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  const instructions: Record<string, any> = {};
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    for (const name of ['AGENTS.md', 'CLAUDE.md', '.codex/AGENTS.md', '.claude/CLAUDE.md']) {
      const p = path.join(dir, name); if (fs.existsSync(p)) instructions[p] = digestFile(p);
    }
    if (dir === path.dirname(dir)) break;
  }
  const files: Record<string, any> = {};
  const omitted: string[] = [];
  let staged = '', unstaged = '';
  if (root) {
    const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (listed === null) throw new Error('Unable to list Git files for the workspace snapshot.');
    const names = [...new Set<string>(listed.split('\0').filter(Boolean))].sort();
    for (const p of names) {
      if (sensitive(p)) { omitted.push(p); continue; }
      files[p] = digestFile(path.join(root, p));
    }
    // Exclude credential paths from stored patch text, including tracked .env files.
    const exclusions = names.filter(sensitive).map(p => `:(literal,exclude)${p}`);
    staged = git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.', ...exclusions]);
    unstaged = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--', '.', ...exclusions]);
    if (staged === null || unstaged === null) throw new Error('Unable to capture Git patches (possibly too large).');
  } else {
    for (const a of artifacts) {
      const p = path.resolve(cwd, a);
      const rel = path.relative(cwd, p);
      if (rel.startsWith('..') || path.isAbsolute(rel) || sensitive(rel)) { omitted.push(a); continue; }
      files[rel] = digestFile(p);
    }
    omitted.push('Non-Git directory: only instruction files and explicit artifact paths are fingerprinted.');
  }
  const state = {
    cwd, root: root || null,
    commonDir: root ? git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim() : null,
    head: root ? git(root, ['rev-parse', 'HEAD'])?.trim() || null : null,
    branch: root ? git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim() || null : null,
    files, instructions, stagedHash: hash(staged), unstagedHash: hash(unstaged), omitted,
  };
  return { state, fingerprint: hash(JSON.stringify(state)), staged, unstaged };
}
export function changes(before: any, after: any) {
  const result: string[] = [];
  for (const k of ['cwd', 'root', 'commonDir', 'head', 'branch', 'stagedHash', 'unstagedHash']) if (before[k] !== after[k]) result.push(`${k} changed`);
  for (const group of ['files', 'instructions']) {
    for (const p of new Set([...Object.keys(before[group]), ...Object.keys(after[group])])) {
      if (JSON.stringify(before[group][p]) !== JSON.stringify(after[group][p])) result.push(`${group === 'instructions' ? 'Instruction' : 'File'} changed: ${p}`);
    }
  }
  return result;
}
