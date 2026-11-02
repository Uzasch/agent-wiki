---
name: wiki
description: Personal/team agent wiki (agent-wiki). Use when the user says /set-wiki or "set wiki", asks to save or continue a discussion or meeting points, asks what was decided or done before ("what did I do about X", "when did we decide Y"), or asks to add a vault.
---

# wiki

Sessions are saved automatically to a git-backed markdown wiki (a "vault") when they end or go
idle. This skill handles the parts the user asks for. Vault paths: `agent-wiki vault list`.

## Choose the vault for this session — `/set-wiki <name>`

Run exactly one of these (the capture job reads this command from the session record):

- `agent-wiki set <name>` — this session goes to vault `<name>` (e.g. `personal`, `work`).
- `agent-wiki set <name> --remember` — also save this folder → `<name>` for future sessions.
- `agent-wiki set off` — do not save this session.
- `agent-wiki set` — show where this session goes.

New vault: `agent-wiki vault new <name> <owner/repo>` (clones the repo to `~/wikis/<name>`).

## Look something up

1. Read `<vault>/index.md` (one line per page, newest first).
2. Open the matching pages. For a broad question, `grep -ril "<term>" <vault>` as well.
3. Answer with the date, the decision and the reason, and link the page path.

## Save a discussion / meeting points

When the user asks to save a discussion or types meeting points, write
`<vault>/discussions/<kebab-slug>.md` (the `work` vault unless the user says otherwise):

```markdown
---
type: Discussion
title: "<short title>"
description: "<one line>"
project: "<existing slug>"   # see below; may be left empty
status: open            # open | in-progress | done
owner: "<name>"
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [discussion]
---
# <title>

## <YYYY-MM-DD> — <who>
- Points: …
- Decisions: … — reason
- Open questions: …
- Next steps: … (owner)
- Outputs: links (Sheets: link + a small table of the key rows; images: Drive link)
```

Before writing, list `<vault>/projects/` (one page per project; the slug is the file name, the
title and description are in its frontmatter). Set `project:` to the slug of the project this
belongs to. If none fits, leave `project:` empty: `agent-wiki organize` assigns it (and creates a
new project when needed). Never ask the user which project; never invent a slug.

Then run `agent-wiki sync <vault>` (or `agent-wiki organize --vault <vault>` to assign the project now).

## Continue a discussion

Read the page, do the work, then add a new `## <date> — <who>` section at the bottom (never
rewrite earlier sections), update `status` and `updated`, and run `agent-wiki sync <vault>`.

## Images and screenshots

Never commit images to the vault. Run `agent-wiki image add <vault> <file> [--name N]`: it uploads
to the vault's Drive folder, keeps a local copy in `_drive/`, and prints a snippet
(`![…](../_drive/…)` + Drive link) — paste it into the page. Other machines fetch missing images
with `agent-wiki drive pull <vault>`.

## Rules

- Session pages are named `sessions/YYYY-MM-DD-<short-title>-<id8>.md`. Never rename one by hand:
  `agent-wiki migrate-names` renames old pages and fixes every link to them.
- Never write secrets (keys, tokens, passwords) into the wiki.
- Links are markdown links `[text](../path.md)`, not `[[wikilinks]]`.
- Large media: link the NAS path or Drive link, never copy the file in.
