---
name: set-wiki
description: Choose which agent-wiki vault this session is saved to. Use when the user types /set-wiki, "$set-wiki", or says "save this session to <vault>", "this one is personal/work", or "don't save this session".
---

# set-wiki

Run exactly one command with the shell tool, then confirm the result in one line:

- `/set-wiki <name>` → `agent-wiki set <name>`
- `/set-wiki <name> remember` → `agent-wiki set <name> --remember` (this folder always uses `<name>`)
- `/set-wiki off` → `agent-wiki set off` (this session is not saved)
- `/set-wiki` → `agent-wiki set` (show where this session goes and the known vaults)
- `/set-wiki new <name> <owner/repo>` → `agent-wiki vault new <name> <owner/repo>`

If `agent-wiki` says the vault is unknown, show the user its message; do not create a vault
unless they asked for `new`.
