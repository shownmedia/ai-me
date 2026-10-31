// Optional add-ons (src/addons.js: launch recaps and the game tape). Only Mitchell's private repo has
// that file; the public ai-me copy doesn't, and then the bot runs without them.
import fs from 'node:fs';

const NONE = { scope: () => null, systemPrompt: () => '', start: () => {} };

export async function loadAddons(config, file = new URL('./addons.js', import.meta.url)) {
  if (!fs.existsSync(file)) return NONE;
  return (await import(file)).default(config);
}
