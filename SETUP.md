# Setting up AI <Name> (instructions for Claude Code)

You're helping a Shown teammate get their own Slack bot, "AI <First name>". When they DM or tag it, the Claude Code on their computer does the task with all their connectors and replies in the thread. The installer already put this repo in `~/ai-me`, installed Node and Claude Code, and opened you here. Your job is the rest, start to finish.

The person is usually not technical. Do every step yourself. Ask them only for clicks you can't make, and when you do, say exactly what to click, one step at a time, in plain words (no code, no jargon). Keep messages short. Never print a token.

Work out the OS first (`uname` / `$env:OS`). Windows commands are marked **Win**.

## 0. Already have a bot?

- `~/ai-me/.env` with `SLACK_BOT_TOKEN`: this is a re-run. Pull updates (`git -C ~/ai-me pull --ff-only`), reinstall the service (step 4), then do steps 3, 5 and 6 as checks. Skip the Slack app.
- An older copy (a `~/ai-<name>` folder with a `.env` that has `SLACK_BOT_TOKEN`, cloned from `shownmedia/ai-mitchell`): move them over and keep their Slack app. Copy that `.env` into `~/ai-me/.env`, add `AUTO_UPDATE=1`, run the old copy's `bin/install.sh uninstall` (**Win:** `powershell -ExecutionPolicy Bypass -File bin\install.ps1 uninstall`), then step 4. Leave the old folder where it is and tell them they can delete it later.

## 1. Who they are

- Claude login: they're signed in if you're running. Check it's their Shown account (`/status` shows the org); if it isn't, have them type `/login` and pick the Shown one. No Shown seat? Dylan Crispin sorts that out.
- Their Slack identity: use the Slack connector (`slack_read_user_profile` with no user gives the current user) for their member ID and first name. If the Slack connector isn't available yet, do step 3 first.
- Bot name: `AI <First name>`. Ask once, in one message, whether they want a different name, and whether they want an emoji reaction when a task finishes (optional, any emoji in Shown's Slack).

## 2. Slack app (about 2 minutes of clicking)

1. `node bin/slack-link.js "AI <First>" "<First>"` prints a link that opens Slack's "Create from a manifest" with everything filled in. Open it for them (`open "<url>"`, **Win:** `Start-Process "<url>"`).
   - If Claude in Chrome is connected (try `tabs_context_mcp`), drive the pages yourself in a new tab. Otherwise walk them through it.
2. They pick **Shown Media** if asked, click **Next**, then **Create**.
3. App-level token: on the app page, under **App-Level Tokens** click **Generate Token and Scopes**, name it `socket`, **Add Scope** → `connections:write`, **Generate**, then **Copy**. Run `node bin/save-token.js SLACK_APP_TOKEN` (it reads the clipboard into `.env` and never prints the token). If it says the clipboard is wrong, have them click Copy again.
4. Install: left sidebar **OAuth & Permissions** → **Install to Shown Media** → **Allow**. Then **Copy** the **Bot User OAuth Token** and run `node bin/save-token.js SLACK_BOT_TOKEN`. (Never the "Create and Install" shortcut on the manifest screen; it errors.)
5. Check it: `node --env-file=.env -e "fetch('https://slack.com/api/auth.test',{method:'POST',headers:{Authorization:'Bearer '+process.env.SLACK_BOT_TOKEN}}).then(r=>r.json()).then(j=>console.log(j.ok,j.user,j.user_id))"` should print `true`. Note the bot user ID.
6. If Slack's page shows an error the first time, wait a few seconds and reload. If the workspace won't let them create apps, stop and tell them to DM Gabriela.

## 3. Their tools (what makes the bot useful)

The bot can use whatever their Claude Code can. Connectors come from their Claude account, so they're added once on claude.ai and work in every run.

1. Run `claude mcp list`. Want these connected: **Slack** (required), **Fathom**, **Shownroom**, **Melius**, **Google Drive**, **Gmail**, **Google Calendar**. Figma if they design.
2. For anything missing or "Needs authentication", open `https://claude.ai/settings/connectors` for them:
   - Slack, Fathom, Google Drive, Gmail, Google Calendar, Figma: **Browse connectors**, find it, **Connect**, approve.
   - Shownroom and Melius are custom: **Add custom connector**, name and URL, then **Connect**:
     - Shownroom: `https://room-mcp.shownmedia.com/mcp`
     - Melius: `https://mcp.melius.com/mcp`
   - Run `claude mcp list` again to confirm.
3. Claude in Chrome (lets the bot use sites they're logged into): if it isn't connected, have them install it from `https://claude.ai/chrome` in the Chrome they use for work and sign in with the same Claude account. Optional, but the bot is much more capable with it.

## 4. Install and start

Write the rest of `.env` (keep the two tokens already there):

```
OWNER_SLACK_ID=U…
OWNER_NAME="<First>"
BOT_NAME="AI <First>"
AUTO_UPDATE=1
```

Plus `DONE_EMOJI=<name>` if they picked one (check it exists with the Slack connector's emoji search). Then `bin/install.sh` (**Win:** `powershell -ExecutionPolicy Bypass -File bin\install.ps1`). Look for `[boot] AI <First> connected as …` in `logs/bot.log`. A missing `files:write` warning means they skipped Allow; redo step 2.4.

## 5. Prove it works

Send the bot a DM as them with the Slack connector (`slack_send_message` to the bot's user ID): "reply with the word pong". Within a minute you should see 👀, "Yes, I'm on it", then a reply tagging them and ✅. Read the DM with `slack_read_channel` to confirm. Nothing after 2 minutes: read `logs/bot.log` and fix it. Without the Slack connector, ask them to send that DM and tell you what came back.

## 6. Keep it awake

It only works while the computer is on and awake (it catches up on missed messages within 5 minutes of waking).

- Mac: ask them to type `! sudo pmset -c sleep 0 disablesleep 1` here and enter their Mac password (on the charger it never sleeps, even with the lid closed; battery is unchanged).
- **Win:** run `powercfg /change standby-timeout-ac 0` (never sleep while plugged in).

## 7. Tell them (keep it this short)

- "Done. DM **AI <First>** anything you'd ask me here. It only takes tasks from you."
- Keep it in your DMs; I'd skip adding it to channels. Use it like a superpowered search engine that can also work on your computer: find a Slack thread, the right Google Doc or SOP, or the answer to a question.
- In a thread: reply to keep going, `stop` to cancel, "use opus" for harder work.
- It updates itself. If it ever acts up, open Terminal (**Win:** PowerShell) and run the same setup command again; it repairs and re-checks everything.
- Questions: Gabriela. Claude account: Dylan Crispin.
