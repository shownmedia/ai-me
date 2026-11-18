#!/usr/bin/env node
// Image files for limited guest runs, as a tiny stdio MCP server: render HTML to a PNG with headless Chrome,
// or save a generated image/video from an https link, straight into the thread's outbox (argv[2]), which the
// bot uploads after the reply. The run never gets a shell or file writes. The HTML is served from 127.0.0.1
// with a CSP that allows only itself, data: and https:, so a page can't pull in files or local services.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const MAX_HTML = 2 * 1024 * 1024;
const MAX_MEDIA = 500 * 1024 * 1024;
const CSP = "default-src 'self' data: https: 'unsafe-inline'";

// A plain file name inside the outbox with the given extension(s), or null.
export function safeName(name, exts) {
  const base = path.basename(String(name || '')).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  const ext = path.extname(base).slice(1).toLowerCase();
  return base && exts.includes(ext) ? base : null;
}

// https only, and never this computer or a private network.
export function publicHttps(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return u.protocol === 'https:' && !/^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1?$|f[cd][0-9a-f]{2}:|fe80:)/i.test(h);
}

export function chromePath(env = process.env, exists = fs.existsSync) {
  const candidates = [env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  return candidates.find((p) => p && exists(p)) || null;
}

function serve(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function renderImage(a, outbox) {
  const name = safeName(a.filename, ['png']);
  if (!name) throw new Error('filename must be a plain name ending in .png');
  const html = String(a.html || '');
  if (!html || Buffer.byteLength(html) > MAX_HTML) throw new Error('html is empty or over 2 MB');
  const width = Math.min(Math.max(Number(a.width) || 1080, 200), 4000);
  const height = Math.min(Math.max(Number(a.height) || 1080, 200), 4000);
  const chrome = chromePath();
  if (!chrome) throw new Error('Google Chrome is not installed on this computer (set CHROME_PATH).');
  const out = path.join(outbox, name);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const server = await serve(html);
  try {
    await new Promise((resolve, reject) => {
      const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--screenshot=${out}`, `http://127.0.0.1:${server.address().port}/`];
      execFile(chrome, args, { timeout: 60_000 }, (err) => (fs.existsSync(out) ? resolve() : reject(err || new Error('Chrome made no image'))));
    });
  } finally {
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return `Saved ${name} (${width}x${height}) at ${out}. It is uploaded into the thread after your reply; Read that path to check it first.`;
}

async function saveMedia(a, outbox) {
  const name = safeName(a.filename, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a']);
  if (!name) throw new Error('filename must be a plain name with an image, video or audio extension');
  if (!publicHttps(a.url)) throw new Error('url must be a public https link');
  const res = await fetch(a.url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !publicHttps(res.url)) throw new Error(`download failed (${res.status})`);
  if (!/^(image|video|audio)\/|^application\/octet-stream/.test(res.headers.get('content-type') || '')) throw new Error(`not an image, video or audio file (${res.headers.get('content-type')})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MEDIA) throw new Error('file is over 500 MB');
  const out = path.join(outbox, name);
  fs.writeFileSync(out, buf);
  return `Saved ${name} (${Math.round(buf.length / 1024)} KB) at ${out}. It is uploaded into the thread after your reply.`;
}

export const TOOLS = {
  render_image: { description: 'Render an HTML page (inline CSS, https images and fonts allowed) to a PNG screenshot in the thread outbox. Use it for charts, graphics and cards: build the layout in HTML, never let an image model draw numbers or text. Default 1080x1080.', props: { html: { type: 'string' }, filename: { type: 'string', description: 'e.g. seed-valuations.png' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['html', 'filename'], run: renderImage },
  save_media: { description: 'Download an image, video or audio file from a public https link (e.g. a Melius output) into the thread outbox so it is posted in the thread.', props: { url: { type: 'string' }, filename: { type: 'string' } }, required: ['url', 'filename'], run: saveMedia },
};

export async function handle(msg, outbox) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return ok({ protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'render', version: '1.0.0' } });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.required } })) });
  if (method === 'tools/call') {
    try {
      const tool = TOOLS[params.name];
      if (!tool) throw new Error(`Unknown tool ${params.name}`);
      if (!outbox || !fs.existsSync(outbox)) throw new Error('No outbox for this thread.');
      return ok({ content: [{ type: 'text', text: await tool.run(params.arguments || {}, outbox) }] });
    } catch (e) {
      return ok({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

if (process.argv[1]?.endsWith('render-mcp.js')) {
  const outbox = process.argv[2];
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const out = await handle(msg, outbox);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
