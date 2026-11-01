---
name: keep-awake-charging
description: Set up a Mac so long Claude Code runs keep going while it's plugged in. On the charger the Mac never sleeps, and a quick press of the Touch ID / power button only locks it and turns the screen off instead of sleeping. Battery behavior stays normal. Use when the user says "keep my Mac awake while charging", "don't sleep when plugged in", "keep Claude running when I lock my laptop", "power button shouldn't sleep", or wants to check or undo these settings.
---

# Keep awake while charging

Two settings, both reversible. Neither touches battery sleep, so the laptop never dies from this.

| Setting | What it does | Needs sudo |
|---|---|---|
| `pmset -c sleep 0 disksleep 0` | On AC power the system never idle-sleeps. Display still turns off on its own timer. | yes |
| `defaults write com.apple.loginwindow PowerButtonSleepsSystem -bool false` | A short press of the Touch ID / power button locks and turns the display off, without sleeping the system. | no |

`pmset powerbutton` is NOT a valid key on Apple Silicon. Don't suggest it; it prints the usage error.

## Steps

1. **Check current state** (no sudo):
   ```bash
   pmset -g custom | sed -n '/AC Power/,$p' | grep -E ' sleep|disksleep|displaysleep'
   defaults read com.apple.loginwindow PowerButtonSleepsSystem 2>/dev/null || echo "PowerButtonSleepsSystem: not set (button sleeps the Mac)"
   ```
   Skip any step that's already applied.

2. **AC sleep off.** This needs the user's password, so Claude can't run it. Ask them to type it in the Claude Code prompt with the `!` prefix:
   ```
   ! sudo pmset -c sleep 0 disksleep 0
   ```
   Then re-run the check in step 1 and confirm `sleep 0` and `disksleep 0` under AC Power.

3. **Power button = lock only.** Claude runs this directly:
   ```bash
   defaults write com.apple.loginwindow PowerButtonSleepsSystem -bool false
   date "+%Y-%m-%d %H:%M:%S"   # note the time for the test
   ```

4. **Verify with a real test.** Ask the user to plug in, press the button once (short press), wait about 2 minutes, unlock and say "done". Then check the power log since the noted time:
   ```bash
   pmset -g log | awk -v d="$(date +%Y-%m-%d)" -v t="HH:MM:SS" '$1==d && $2>=t' | grep -E "Display is turned|Entering Sleep|\sSleep\s"
   ```
   Pass = "Display is turned off" then "Display is turned on" with no `Sleep` line in between. If it did sleep, have them log out and back in once, then test again.

## What still stops a run
- Closing the lid without an external display (forces sleep).
- Unplugging: battery settings take over and the Mac idle-sleeps as usual.
- Holding the power button down (shuts down).
- Apple menu → Sleep.

Ctrl+Cmd+Q and Apple menu → Lock Screen also lock without sleeping.

## Undo
```
! sudo pmset -c sleep 1 disksleep 10
defaults delete com.apple.loginwindow PowerButtonSleepsSystem
```
(`sleep 1` / `disksleep 10` are the defaults; use whatever step 1 showed before if different.)
