#!/usr/bin/env node
// Run the daily lessons review now. Prints what it would DM; nothing is posted unless --post.
//   npm run lessons                 last 24 hours, print only
//   npm run lessons -- --hours 72   a longer window
//   npm run lessons -- --post       also DM it, like the nightly run
import fs from 'node:fs';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import { config } from '../src/config.js';
import { reviewLessons } from '../src/lessons.js';

const argv = process.argv.slice(2);
const hours = Number(argv[argv.indexOf('--hours') + 1]) || 24;
const post = argv.includes('--post');
const state = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'state.json'), 'utf8'));
const client = new WebClient(config.botToken);
const { user_id: botUserId } = await client.auth.test();
const res = await reviewLessons({ client, config, state, botUserId, since: Date.now() - hours * 3600_000, post, log: console.log });
console.log(res.text || '(no lessons)');
