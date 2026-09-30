import { createInterface } from 'node:readline';
import { exportHandoff, importHandoff, acknowledge, historyText } from './engine.ts';
import { providerName, sessions } from './adapters.ts';
import { canonical, checkpointFields, index } from './store.ts';
import { switchHandoff } from './switch.ts';

const string = { type: 'string' };
const checkpoint = { type: 'object', additionalProperties: false, required: ['title', 'goal', ...checkpointFields], properties: { title: string, goal: string, ...Object.fromEntries(checkpointFields.map(k => [k, { type: 'array', items: string }])) } };
export const toolDefinitions = [
  { name: 'handoff_switch', description: 'Save this exact conversation and task checkpoint, then switch to the other native CLI in this same terminal. Requires handoff start. The source closes only after the archive is published and validated. Stop working when this succeeds; the target will import automatically.', properties: { cwd: string, session: string, checkpoint, target: { type: 'string', enum: ['codex', 'claude'] } }, required: ['cwd', 'session', 'checkpoint'], readOnly: false },
  { name: 'handoff_export', description: 'Export this exact native conversation and a structured task checkpoint to the local handoff store. Preserve user constraints verbatim. Only pending questions belong in approvals. Use the current workspace and exact native session ID. Returns the handoff ID and target command.', properties: { cwd: string, session: string, checkpoint }, required: ['cwd', 'session', 'checkpoint'], readOnly: false },
  { name: 'handoff_import', description: 'Load a pending conversation handoff in the current workspace, including its checkpoint and workspace differences. If more than one task is pending, request an ID. Does not acknowledge or consume the handoff.', properties: { cwd: string, id: string }, required: ['cwd'], readOnly: true },
  { name: 'handoff_ack', description: 'After reading a handoff, bind this exact native session to the imported task and mark it loaded. Future exports maintain task lineage.', properties: { cwd: string, id: string, session: string }, required: ['cwd', 'id', 'session'], readOnly: false },
  { name: 'handoff_history', description: 'Retrieve older conversation evidence across ancestor handoffs. Search and paginate without placing the entire archive in context.', properties: { cwd: string, id: string, query: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['cwd', 'id'], readOnly: true },
  { name: 'handoff_status', description: 'List local handoff IDs, task titles, and native source sessions for this exact workspace.', properties: { cwd: string }, required: ['cwd'], readOnly: true },
  { name: 'handoff_sessions', description: 'List native session candidates belonging to this exact workspace. Never choose a different session just because it is newer.', properties: { cwd: string }, required: ['cwd'], readOnly: true },
].map(t => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required, additionalProperties: false }, annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly || t.name === 'handoff_ack', openWorldHint: false } }));

export async function callTool(provider: string, name: string, args: any) {
  providerName(provider);
  const definition = toolDefinitions.find(t => t.name === name);
  if (!definition) throw new Error(`Unknown handoff tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  for (const field of definition.inputSchema.required) if (args[field] === undefined) throw new Error(`Missing ${field}.`);
  for (const field of Object.keys(args)) if (!(field in definition.inputSchema.properties)) throw new Error(`Unknown argument ${field}.`);
  for (const [field, schema] of Object.entries(definition.inputSchema.properties)) {
    if (args[field] === undefined) continue;
    if ((schema as any).type === 'string' && typeof args[field] !== 'string') throw new Error(`${field} must be a string.`);
    if ((schema as any).type === 'integer' && (!Number.isInteger(args[field]) || args[field] < (schema as any).minimum || args[field] > ((schema as any).maximum || 1000000))) throw new Error(`Invalid ${field}.`);
  }
  const cwd = canonical(args.cwd);
  switch (name) {
    case 'handoff_switch': return await switchHandoff(provider, args);
    case 'handoff_export': return await exportHandoff({ ...args, provider, cwd });
    case 'handoff_import': return importHandoff(provider, cwd, args.id);
    case 'handoff_ack': return await acknowledge(provider, cwd, args.id, args.session);
    case 'handoff_history': return await historyText(cwd, args.id, args.query, args.limit ?? 30, args.offset ?? 0);
    case 'handoff_status': return index(cwd).revisions;
    case 'handoff_sessions': return sessions(provider, cwd);
  }
}
export function serve(provider: string) {
  providerName(provider);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message: any) => process.stdout.write(JSON.stringify(message) + '\n');
  lines.on('line', async line => {
    let message: any;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    if (message.id === undefined) return; // Notifications do not receive responses.
    try {
      let result: any;
      switch (message.method) {
        case 'initialize': {
          const requested = message.params?.protocolVersion;
          result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(requested) ? requested : '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cli-handoff', version: '0.2.0' }, instructions: 'Use exact native session IDs and the current project directory. Capture and continue local conversation handoffs with explicit user intent.' }; break;
        }
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: toolDefinitions }; break;
        case 'tools/call': {
          try {
            const value = await callTool(provider, message.params.name, message.params.arguments || {});
            const text = message.params.name === 'handoff_import' ? value.packet : JSON.stringify(value, null, 2);
            result = { content: [{ type: 'text', text }] };
          } catch (e) { result = { isError: true, content: [{ type: 'text', text: (e as Error).message }] }; }
          break;
        }
        default: send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch (e) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: (e as Error).message } }); }
  });
}
