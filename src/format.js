// Claude writes GitHub markdown; Slack speaks mrkdwn. Convert the common bits
// and split long replies so nothing gets truncated.

// Slack has no tables: show a markdown table as an aligned monospace block instead.
function tableToBlock(lines) {
  const rows = lines
    .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\*\*(.+?)\*\*/g, '$1')));
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] || '').length)));
  return '```\n' + rows.map((r) => r.map((c, i) => (c || '').padEnd(widths[i])).join('  ').trimEnd()).join('\n') + '\n```';
}

function convertProse(part) {
  // Pull tables out first so the inline rules below don't touch them.
  const lines = part.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; ) {
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const table = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) table.push(lines[i++]);
      out.push({ code: tableToBlock(table) });
    } else out.push(lines[i++]);
  }
  return out
    .map((l) =>
      typeof l === 'object'
        ? l.code
        : l
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
            .replace(/^#{1,6}\s+(.+)$/, '*$1*')
            .replace(/\*\*(.+?)\*\*/g, '*$1*')
            .replace(/__(.+?)__/g, '*$1*')
            .replace(/~~(.+?)~~/g, '~$1~')
            .replace(/^(\s*)[-*]\s+/, '$1• '),
    )
    .join('\n');
}

export function toMrkdwn(md) {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith('```') ? part.replace(/^```[\w-]*\n/, '```\n') : convertProse(part)))
    .join('');
}

// Splits long replies on line breaks. A code block cut in two is closed at the end of one
// message and reopened at the start of the next, so both halves still render as code.
export function chunk(text, max = 3500) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max - 4);
    if (cut < max * 0.5) cut = max - 4;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, '');
    if ((piece.match(/```/g) || []).length % 2) {
      piece += '\n```';
      rest = '```\n' + rest;
    }
    out.push(piece);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

// EDIT_IN_PLACE: a thread's one bot message gets each new answer added under what it already says.
// When that won't fit in one Slack message, the old text stays as it was and the answer goes in new
// message(s); the last one becomes the message later answers are added to.
export function editedReply(base, answer, max = 3500) {
  const full = base ? `${base}\n\n${answer}` : answer;
  if (full.length <= max) return { edit: full, extra: [] };
  const parts = chunk(answer, max);
  return base ? { edit: base, extra: parts } : { edit: parts[0], extra: parts.slice(1) };
}

export function describeTool(name, input = {}) {
  const short = (s, n = 80) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const file = (p) => short(String(p ?? '').replace(/^\/Users\/[^/]+\//, '~/'), 70);
  switch (name) {
    case 'Bash': return `Running \`${short(input.description || input.command, 70)}\``;
    case 'Read': return `Reading ${file(input.file_path)}`;
    case 'Edit':
    case 'Write': return `Editing ${file(input.file_path)}`;
    case 'Grep':
    case 'Glob': return `Searching for ${short(input.pattern, 50)}`;
    case 'WebFetch':
    case 'WebSearch': return `Looking up ${short(input.query || input.url, 60)}`;
    case 'Agent':
    case 'Task': return `Delegating: ${short(input.description, 60)}`;
    default: return `Using ${name.replace(/^mcp__[^_]+__/, '')}`;
  }
}

// Lowercases prose but leaves code, links, mentions and channel tags exactly as they are,
// since changing their case would break them.
export function lowercase(text) {
  return String(text ?? '')
    .split(/(```[\s\S]*?```|`[^`\n]*`|<[^>\s]+>|https?:\/\/\S+)/)
    .map((part, i) => (i % 2 ? part : part.toLowerCase()))
    .join('');
}

// `label|url;label|url` -> [{ label, url }]. Entries without a url are dropped.
export function parseLinks(spec = '') {
  return String(spec || '')
    .split(';')
    .map((part) => {
      const i = part.lastIndexOf('|');
      return { label: part.slice(0, i).trim(), url: part.slice(i + 1).trim() };
    })
    .filter((l) => /^https?:\/\//.test(l.url))
    .map((l) => ({ label: l.label || l.url, url: l.url }));
}

// One link stays a bare link; several become a bulleted list. An intro, if set, goes on top.
export function commsText(links, intro = '') {
  const md = links.map((l) => `<${l.url}|${l.label}>`);
  const list = md.length === 1 ? md[0] : md.map((m) => `• ${m}`).join('\n');
  return intro ? `${intro}\n${list}` : list;
}

// `!comms` only counts as the command when the message is just that: the command, optionally the
// people to remind, and optionally which reminder (`dm` / `thread`). A sentence that merely mentions
// !comms ("can you change how !comms works") is a normal ask, not the command.
// Returns { users, kind } (kind: 'dm' | 'thread' | null for "work it out") or null.
export function parseComms(text = '', botUserId = '') {
  let rest = String(text || '')
    .replace(/\s*\*Sent using\* <@\w+(\|[^>]*)?>\s*$/, '')
    .replace(botUserId ? new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g') : /$^/, ' ')
    .trim();
  const m = rest.match(/^!comms\b([\s\S]*)$/i);
  if (!m) return null;
  rest = m[1];
  const users = [...rest.matchAll(/<@(\w+)(\|[^>]*)?>/g)].map((u) => u[1]).filter((u, i, a) => a.indexOf(u) === i);
  const words = rest.replace(/<@\w+(\|[^>]*)?>/g, ' ').toLowerCase().match(/[a-z]+/g) || [];
  const kinds = { dm: 'dm', dms: 'dm', channel: 'dm', channels: 'dm', thread: 'thread', threads: 'thread' };
  if (words.some((w) => !kinds[w])) return null;
  return { users, kind: words.length ? kinds[words[words.length - 1]] : null };
}

// The !comms reply. In a DM or group DM the nudge is "take this to a channel"; in a channel it is
// "reply in threads". Tagged people are greeted by name, and with one link the reminder itself is the link.
export function commsReply({ users = [], kind = null, channel = '', channelType = '' }, comms) {
  const k = kind || (channelType === 'im' || channelType === 'mpim' || String(channel).startsWith('D') ? 'dm' : 'thread');
  const { text, links } = comms[k];
  const hey = users.length ? `Hey ${users.map((u) => `<@${u}>`).join(' ')}, quick reminder that` : 'Hey, quick reminder that';
  if (!links.length) return `${hey} ${text}`;
  if (links.length === 1) return `${hey} <${links[0].url}|${text}>`;
  return commsText(links, `${hey} ${text}`);
}

// Threads that got new replies since `since` (a Slack ts) and are not tracked yet. Live events can be
// lost while the machine is offline; channel history only lists thread parents, so a reply tagging the
// bot in a thread it has never been in would otherwise never be seen.
export function threadsWithNewReplies(msgs = [], since, tracked = () => false) {
  return msgs.filter((m) => m.reply_count && Number(m.latest_reply) > Number(since) && !tracked(m.ts)).map((m) => m.ts);
}

// Guest threads (guests.json): the entry for a thread, and whether a given user may task the bot there.
export function guestThread(guests, channel, threadTs) {
  return (Array.isArray(guests) ? guests : []).find((g) => g.channel === channel && g.thread_ts === threadTs) || null;
}
export function guestFor(guests, channel, threadTs, user) {
  const g = guestThread(guests, channel, threadTs);
  return g && (g.users || []).includes(user) ? g : null;
}
