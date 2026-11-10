import os from 'node:os';
import path from 'node:path';

// What a limited guest run may use (see READER_TOOLS in src/claude.js). Called by the PreToolUse hook
// bin/slack-guard.js before every tool call; anything not allowed here is refused, and so is any error.
const SLACK = 'mcp__claude_ai_Slack__';
// Beyond Slack lookups (Mitchell, 2026-11-10): Gmail reads + drafts (no sending), Google files read and edit
// (no sharing or trashing), Calendar reads (creating events sends invites), and Melius except deletes and billing.
const G = 'mcp__claude_ai_';
export const GUEST_TOOLS = [
  ...['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft', 'create_draft', 'update_draft'].map((t) => `${G}Gmail__${t}`),
  ...['search_files', 'read_file_content', 'download_file_content', 'get_file_metadata', 'get_file_permissions', 'list_recent_files', 'list_shared_drives', 'get_shared_drive_metadata', 'create_file', 'copy_file', 'update_file'].map((t) => `${G}Google_Drive__${t}`),
  ...['read_doc', 'update_doc'].map((t) => `${G}Google_Docs__${t}`),
  ...['get_spreadsheet', 'get_values', 'update_values', 'append_values', 'update_formulas', 'insert_dimension', 'update_spreadsheet', 'batch_clear_values', 'copy_sheet_to_another_spreadsheet'].map((t) => `${G}Google_Sheets__${t}`),
  ...['read_presentation', 'read_slide_page', 'read_slide_page_thumbnail', 'update_presentation'].map((t) => `${G}Google_Slides__${t}`),
  ...['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'].map((t) => `${G}Google_Calendar__${t}`),
];
const MELIUS = `${G}Melius__`;
// Big tool results (a long Doc) are saved by Claude Code under the session's tool-results folder and paged with
// Read/Grep, so those two may open that folder of a limited run's session, and nothing else.
// Compared with forward slashes so the same check works on Windows.
const slashed = (p) => path.resolve(p).split(path.sep).join('/');
const TOOL_RESULTS = new RegExp(`^${slashed(path.join(os.homedir(), '.claude', 'projects')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]*-ai-slack-reader/[0-9a-f-]+/tool-results(/|$)`, process.platform === 'win32' ? 'i' : '');
const toolResult = (p) => typeof p === 'string' && TOOL_RESULTS.test(slashed(p));
const MELIUS_OFF = new Set(['canvas_delete', 'brand_kit_delete', 'cast_library_delete', 'delete_agent_team_skill', 'remove_agent_team_skill_asset', 'credits_upgrade']);
const NO_CHANNEL = new Set(['slack_search_public', 'slack_search_users', 'slack_read_user_profile']);
const CHANNEL_READS = new Set(['slack_read_channel', 'slack_read_thread']);

// slack: { info(channel) -> conversations.info channel or null, members(channel) -> member ids or null }.
// Returns null when the call is allowed, else the reason it's refused.
export async function slackGuard({ tool_name: name = '', tool_input: input = {} }, readers, slack) {
  if (name === 'ToolSearch' || GUEST_TOOLS.includes(name)) return null;
  if (name === 'Read' || name === 'Grep') return toolResult(input.file_path ?? input.path) ? null : `${name} only works on saved tool results here, not on files on this computer.`;
  if (name.startsWith(MELIUS)) return MELIUS_OFF.has(name.slice(MELIUS.length)) ? 'Deleting and billing in Melius are off in this thread.' : null;
  const tool = name.startsWith(SLACK) ? name.slice(SLACK.length) : '';
  // File search returns every file the owner can open, DMs included: messages only.
  if (tool === 'slack_search_public' && /file/i.test(String(input.content_types || ''))) return 'File search is off in this thread (it would include private files); search messages instead.';
  if (NO_CHANNEL.has(tool)) return null;
  if (!CHANNEL_READS.has(tool)) return `${name || 'That tool'} is not available in this thread.`;
  const id = String(input.channel_id || '');
  if (!/^[CG][A-Z0-9]+$/.test(id)) return 'DMs and group DMs are off limits in this thread; only channels can be read.';
  const ch = await slack.info(id);
  if (!ch || ch.is_im || ch.is_mpim) return 'That conversation is not a channel that can be read here (DMs and group DMs are off limits).';
  if (!ch.is_private) return null;
  const members = await slack.members(id);
  if (!readers.length || !members || !readers.every((u) => members.includes(u))) return 'That is a private channel the person asking is not in.';
  return null;
}
