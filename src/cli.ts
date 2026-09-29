#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { exportHandoff, importHandoff, prepare, acknowledge, historyText } from './engine.ts';
import { doctor, hook, install, uninstall } from './integrations.ts';
import { providerName, sessions } from './adapters.ts';
import { canonical, dataRoot, index, selectRevision, unlock } from './store.ts';
import { serve } from './mcp.ts';

const help = `handoff — continue work between native Codex CLI and Claude Code\n\nUsage:\n  handoff install                     Install native skills and identity hooks\n  handoff prepare --provider NAME     Create a checkpoint draft for this exact session\n  handoff export --provider NAME --checkpoint FILE [--session ID]\n  handoff import [ID] --provider NAME  Read a pending handoff and compare live files\n  handoff ack ID --provider NAME [--session ID]\n  handoff open claude|codex [ID]       Launch the native CLI with an import prompt\n  handoff status                      List saved handoffs in this directory\n  handoff sessions --provider NAME     List exact native session IDs for this directory\n  handoff history ID [--query TEXT] [--offset N] [--limit N]\n  handoff doctor                      Check installation and native CLI availability\n  handoff unlock                      Remove a lock only if its owner process is gone\n  handoff uninstall                   Remove owned integration files; keep archives\n\nCommon options: --cwd PATH, --session ID, --json\nExport options: --transcript PATH (legacy/testing), --task ID (explicit existing task)\n\nClaude: /export-sync and /import-sync\nCodex: $export-sync and $import-sync (select the skill from the native picker)\nYou can also say “export-sync” or “continue from the synced conversation.”\n`;
function parse(args: string[]) {
  const flags: Record<string, any> = {}; const positional: string[] = [];
  const booleans = new Set(['json', 'help']);
  const known = new Set(['provider', 'cwd', 'session', 'checkpoint', 'transcript', 'task', 'query', 'offset', 'limit']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-h') { flags.help = true; continue; }
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (booleans.has(key)) flags[key] = true;
    else if (known.has(key)) { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing --${key} value.`); flags[key] = args[++i]; }
    else throw new Error(`Unknown option --${key}.`);
  }
  return { flags, positional };
}
function integer(value: string | undefined, fallback: number, max = 1000000) {
  if (value === undefined) return fallback;
  const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`Invalid number: ${value}`); return n;
}
function output(value: any) { console.log(JSON.stringify(value, null, 2)); }
async function main() {
  const { flags: f, positional: p } = parse(process.argv.slice(2)); const command = p.shift();
  if (!command || f.help || command === 'help') { console.log(help); return; }
  const cwd = canonical(f.cwd || process.cwd());
  switch (command) {
    case 'install': output(install()); break;
    case 'uninstall': output(uninstall()); break;
    case 'doctor': output(doctor()); break;
    case 'mcp': serve(providerName(f.provider)); break;
    case 'prepare': output(prepare(providerName(f.provider), cwd, f.session)); break;
    case 'export':
      if (!f.checkpoint) throw new Error('--checkpoint FILE is required. Run handoff prepare first.');
      output(await exportHandoff({ ...f, cwd })); break;
    case 'import': {
      const result = importHandoff(providerName(f.provider), cwd, p[0]);
      if (f.json) output(result); else console.log(result.packet); break;
    }
    case 'ack': if (!p[0]) throw new Error('A handoff ID is required.'); output(await acknowledge(providerName(f.provider), cwd, p[0], f.session)); break;
    case 'status': {
      const rows = index(cwd).revisions;
      if (f.json) output(rows);
      else console.log(rows.length ? rows.map((r: any) => `${r.id}  ${r.source.provider.padEnd(6)}  ${r.title}\n  ${r.capturedAt}  task=${r.taskId}  loaded=${Object.keys(r.consumed || {}).join(',') || 'none'}`).join('\n') : 'No handoffs in this directory. Run export-sync in a CLI conversation.');
      break;
    }
    case 'sessions': output(sessions(providerName(f.provider), cwd)); break;
    case 'history': {
      if (!p[0]) throw new Error('A handoff ID is required.');
      const result = await historyText(cwd, p[0], f.query, integer(f.limit, 30, 1000), integer(f.offset, 0));
      if (f.json) output(result);
      else console.log(`Events ${result.offset}–${result.offset + result.returned} of ${result.total}${result.nextOffset === null ? '' : `; next --offset ${result.nextOffset}`}\n\n` + result.events.map(e => `${e.provider}:${e.session}:${e.id}\n${e.text}`).join('\n\n'));
      break;
    }
    case 'unlock': console.log(unlock(cwd)); break;
    case 'hook': {
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      output(hook(providerName(f.provider), input)); break;
    }
    case 'open': {
      const provider = providerName(p[0]); const revision = selectRevision(cwd, provider, p[1]);
      const env = { ...process.env }; delete env.CODEX_THREAD_ID; delete env.CLAUDE_SESSION_ID; delete env.CLAUDECODE;
      const prompt = `Use the import-sync skill to continue handoff ${revision.row.id} in this directory. Load the packet, check the workspace, acknowledge it with this session's exact ID, and continue the task.`;
      const child = spawn(provider, [...(provider === 'codex' ? ['--add-dir', dataRoot()] : []), prompt], { cwd, env, stdio: 'inherit' });
      await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); resolve(); }); });
      break;
    }
    default: throw new Error(`Unknown command: ${command}. Run handoff --help.`);
  }
}
main().catch(e => { console.error(`handoff: ${e.message}`); process.exitCode = 1; });
