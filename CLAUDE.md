# ai-me

Your own Claude Code in Slack ("AI <Name>"). README.md is the full guide (behavior, security, ops).

- **If you were opened with "Set up my AI bot." or someone asks to set up, fix, move or check their AI bot: follow SETUP.md step by step.** That's the whole job.
- Installed by `setup.sh` (Mac) / `setup.ps1` (Windows): one pasted command, no GitHub account. Re-running it updates and repairs.
- Runs locally as a login service (`bin/install.sh` → launchd `com.<user>.ai-me`; Windows `bin/install.ps1`, hidden Startup launcher). Restart: `launchctl kickstart -k gui/$(id -u)/com.$(whoami).ai-me` (**Win:** `bin\install.ps1 restart`). Logs: `logs/bot.log`.
- Everything person-specific is in `.env` (see `.env.example`); never edit code to personalize. `AUTO_UPDATE=1` makes the bot pull this repo while idle and restart on it, so local code edits block updates.
- Claude is spawned without a shell on purpose; never add `shell: true`. `npm test` before any change.
- This repo is published from Shown's private `ai-mitchell` (bin/export-public.sh there). Fixes go there, not here.
