#!/usr/bin/env node
// Read-only Attio (CRM) tools for limited guest runs, as a tiny stdio MCP server. The key never reaches the
// model: it comes from ATTIO_API_TOKEN or ~/.shown/env. Only GETs and the two query endpoints (POST, read-only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export function attioToken(env = process.env, file = path.join(os.homedir(), '.shown', 'env')) {
  if (env.ATTIO_API_TOKEN) return env.ATTIO_API_TOKEN;
  try {
    return fs.readFileSync(file, 'utf8').match(/^ATTIO_API_TOKEN=["']?([^"'\r\n]+)/m)?.[1] || null;
  } catch {
    return null;
  }
}

const seg = (v) => encodeURIComponent(String(v ?? ''));
const page = (a) => ({ limit: Math.min(Number(a.limit) || 50, 500), offset: Number(a.offset) || 0 });
const obj = { type: 'string', description: 'Object slug or id, e.g. companies, people, deals' };
const list = { type: 'string', description: 'List slug or id' };
const query = { filter: { type: 'object', description: 'Attio filter, e.g. {"stage":"Won"}' }, sorts: { type: 'array' }, limit: { type: 'number' }, offset: { type: 'number' } };

export const TOOLS = {
  list_objects: { description: 'List CRM objects (companies, people, deals, ...).', props: {}, req: () => ['GET', '/objects'] },
  list_attributes: { description: "List an object's or list's attributes (field names, select options, stages).", props: { object: obj, list }, req: (a) => ['GET', a.list ? `/lists/${seg(a.list)}/attributes` : `/objects/${seg(a.object)}/attributes`] },
  query_records: { description: 'Query records of an object with an optional filter and sort.', props: { object: obj, ...query }, required: ['object'], req: (a) => ['POST', `/objects/${seg(a.object)}/records/query`, { filter: a.filter, sorts: a.sorts, ...page(a) }] },
  get_record: { description: 'Get one record by id.', props: { object: obj, record_id: { type: 'string' } }, required: ['object', 'record_id'], req: (a) => ['GET', `/objects/${seg(a.object)}/records/${seg(a.record_id)}`] },
  list_lists: { description: 'List CRM lists (pipelines).', props: {}, req: () => ['GET', '/lists'] },
  query_list_entries: { description: 'Query entries of a list (pipeline) with an optional filter and sort.', props: { list, ...query }, required: ['list'], req: (a) => ['POST', `/lists/${seg(a.list)}/entries/query`, { filter: a.filter, sorts: a.sorts, ...page(a) }] },
  list_notes: { description: 'List notes, optionally for one record.', props: { parent_object: obj, parent_record_id: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, req: (a) => ['GET', `/notes?${new URLSearchParams(Object.entries({ parent_object: a.parent_object, parent_record_id: a.parent_record_id, ...page(a) }).filter(([, v]) => v !== undefined && v !== ''))}`] },
};

async function call(name, args, token) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Unknown tool ${name}`);
  if (!token) throw new Error('No Attio key on this computer (ATTIO_API_TOKEN).');
  const [method, p, body] = tool.req(args || {});
  const res = await fetch(`https://api.attio.com/v2${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Attio ${res.status}: ${text.slice(0, 500)}`);
  return text;
}

export async function handle(msg, token) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notifications
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return ok({ protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'attio', version: '1.0.0' } });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: `Attio CRM (read only). ${t.description}`, inputSchema: { type: 'object', properties: t.props, required: t.required || [] } })) });
  if (method === 'tools/call') {
    try {
      return ok({ content: [{ type: 'text', text: await call(params.name, params.arguments, token) }] });
    } catch (e) {
      return ok({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

if (process.argv[1]?.endsWith('attio-mcp.js')) {
  const token = attioToken();
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const out = await handle(msg, token);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
