#!/usr/bin/env node
// Add one sales call to the owner's sales master doc (layout: src/concepts-doc.js):
//   node bin/master-entry.js <docId> <recap.json> <concepts.json> [--dry]
// Page 1 is a top-level tab named recap.tabTitle (e.g. "Cord · 5 Nov") with the call recap;
// page 2 is its child tab "Launch Concepts" with the three concepts. Re-running refills both
// (matched by title under the same parent), so an entry is never duplicated and other entries
// are never touched. Uses the gws CLI. Prints {"docId","recapTabId","recapUrl","conceptsTabId","tabUrl"}.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { conceptRequests, recapRequests, validateConcepts, validateRecap } from '../src/concepts-doc.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry') && args.splice(args.indexOf('--dry'), 1);
const [docId, recapFile, conceptsFile] = args;
if (!docId || !recapFile || !conceptsFile) {
  console.error('usage: master-entry.js <docId> <recap.json> <concepts.json> [--dry]');
  process.exit(2);
}
const recap = JSON.parse(fs.readFileSync(recapFile, 'utf8'));
const concepts = JSON.parse(fs.readFileSync(conceptsFile, 'utf8'));
const errs = [...validateRecap(recap).map((e) => `recap: ${e}`), ...validateConcepts(concepts).map((e) => `concepts: ${e}`)];
if (errs.length) {
  console.error(`not ready:\n- ${errs.join('\n- ')}`);
  process.exit(1);
}
if (dry) {
  console.log(JSON.stringify({ recap: recapRequests(recap, 't.recap'), concepts: conceptRequests(concepts, 't.concepts') }, null, 2));
  process.exit(0);
}

const gws = (cmd, params, body) => {
  const a = ['docs', 'documents', cmd, '--params', JSON.stringify(params)];
  if (body) a.push('--json', JSON.stringify(body));
  const out = execFileSync('gws', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  return JSON.parse(out.slice(out.indexOf('{')));
};
const read = () => gws('get', { documentId: docId, includeTabsContent: true, fields: 'revisionId,tabs' });

/** A tab titled `title` directly under `parentId` (top level when null), emptied, or a new one. */
function emptyTab(title, parentId) {
  let d = read();
  const siblings = parentId ? (function find(tabs) {
    for (const t of tabs || []) {
      if (t.tabProperties.tabId === parentId) return t.childTabs || [];
      const r = find(t.childTabs);
      if (r) return r;
    }
    return null;
  })(d.tabs) || [] : d.tabs;
  const tab = siblings.find((t) => t.tabProperties.title === title);
  if (tab) {
    const end = tab.documentTab.body.content.at(-1).endIndex;
    if (end > 2) gws('batchUpdate', { documentId: docId }, { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId: tab.tabProperties.tabId } } }], writeControl: { requiredRevisionId: d.revisionId } });
    return tab.tabProperties.tabId;
  }
  // New entries go right after the cover tab, so the newest call is first in the list.
  const props = { title, ...(parentId ? { parentTabId: parentId } : { index: 1 }) };
  const res = gws('batchUpdate', { documentId: docId }, { requests: [{ addDocumentTab: { tabProperties: props } }], writeControl: { requiredRevisionId: d.revisionId } });
  return res.replies[0].addDocumentTab.tabProperties.tabId;
}

function fill(tabId, requests) {
  const d = gws('get', { documentId: docId, fields: 'revisionId' });
  gws('batchUpdate', { documentId: docId }, { requests, writeControl: { requiredRevisionId: d.revisionId } });
}

const recapTabId = emptyTab(recap.tabTitle, null);
fill(recapTabId, recapRequests(recap, recapTabId));
const conceptsTabId = emptyTab('Launch Concepts', recapTabId);
fill(conceptsTabId, conceptRequests(concepts, conceptsTabId));
const url = (t) => `https://docs.google.com/document/d/${docId}/edit?tab=${t}`;
console.log(JSON.stringify({ docId, recapTabId, recapUrl: url(recapTabId), conceptsTabId, tabUrl: url(conceptsTabId) }));
