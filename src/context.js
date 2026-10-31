// Thread context: what Claude sees of the Slack conversation around the ask, the way a person
// scrolling up would. Every run gets the messages it hasn't seen yet (the whole thread on the
// first run, then whatever was said since), including untagged chat between people and bot posts.
// Pure functions here; the Slack fetching lives in index.js.

// The bot's own progress lines carry no information once the run is over.
const STATUS_LINE = /^(yes, i'm on it|sorry for the wait|done (✅|:white_check_mark:)|finished, needs a look|nothing is running)/i;
const CONNECTOR_FOOTER = /\s*\*Sent using\* <@\w+(\|[^>]*)?>\s*$/;

// Bot posts (Lumen, Chadwick, …) often keep their real content in attachments or blocks, not text.
export function messageText(m) {
  const parts = [m.text || ''];
  for (const a of m.attachments || []) parts.push(a.pretext, a.title, a.text || a.fallback);
  if (!m.text) {
    for (const b of m.blocks || []) {
      if (b.text?.text) parts.push(b.text.text);
      for (const f of b.fields || []) parts.push(f.text);
      for (const e of b.elements || []) if (e.text?.text || typeof e.text === 'string') parts.push(e.text?.text ?? e.text);
    }
  }
  return parts.filter(Boolean).join('\n').trim();
}

// <@U123> -> @Name (<@U123>), so Claude can both read who was meant and tag them.
export function nameMentions(text, names) {
  return text.replace(/<@(\w+)(\|[^>]*)?>/g, (all, id) => (names[id] ? `@${names[id]} (<@${id}>)` : all));
}

const clock = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export function renderMessage(m, { names = {}, botUserId, ownerId, ownerName }) {
  const own = m.user === botUserId || (botUserId && m.bot_profile?.user_id === botUserId);
  let text = messageText(m);
  let who;
  if (own) who = 'you (your earlier reply)';
  else if (m.user === ownerId) {
    who = `${ownerName} (owner)`;
    if (CONNECTOR_FOOTER.test(text)) {
      who = `${ownerName} (sent from their account through the Slack connector, possibly by you)`;
      text = text.replace(CONNECTOR_FOOTER, '');
    }
  } else if (m.bot_id || m.subtype === 'bot_message') who = `${m.bot_profile?.name || m.username || 'a bot'} (bot)`;
  else who = names[m.user] ? `${names[m.user]} (<@${m.user}>)` : `<@${m.user}>`;
  const files = (m.files || []).map((f) => `[file: ${f.name || f.title || f.id}${f.permalink ? ` ${f.permalink}` : ''}]`);
  const body = [nameMentions(text, names), ...files].filter(Boolean).join('\n') || '(no text)';
  return `[${clock(m.ts)}] ${who}: ${body}`;
}

// The messages a run hasn't seen yet, oldest first. Skips the asks themselves (they're shown
// separately), the bot's status lines (or all its messages, once the session already has its
// replies), and anything at or before the cursor.
export function freshMessages(messages, { after = 0, skipTs = [], botUserId, skipOwn = false }) {
  const skip = new Set(skipTs);
  return messages
    .filter((m) => Number(m.ts) > Number(after || 0) && !skip.has(m.ts))
    .filter((m) => !(m.user === botUserId && (skipOwn || STATUS_LINE.test(m.text || ''))))
    .filter((m) => !['channel_join', 'channel_leave', 'reaction_added'].includes(m.subtype))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

// Keeps the thread's first message (it usually says what the thread is about) and the newest
// messages, dropping from the middle when it's too long.
export function renderContext(messages, opts, maxChars = 40_000) {
  const lines = messages.map((m) => renderMessage(m, opts));
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= maxChars) return lines.join('\n');
  const head = lines[0];
  const tail = [];
  let used = head.length + 200;
  for (let i = lines.length - 1; i > 0 && used + lines[i].length < maxChars; i--) {
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const dropped = lines.length - 1 - tail.length;
  return [head, `(${dropped} older message${dropped === 1 ? '' : 's'} left out for length: read the full thread with the Slack connector if you need them)`, ...tail].join('\n');
}
