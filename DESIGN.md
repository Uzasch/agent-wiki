# agent-wiki — design

A shared, git-backed markdown wiki (OKF format, opens in Obsidian) that records what was done,
when, and why — across projects, agents (Claude Code, Codex, opencode, omp), machines, and the
team. Decided with the operator 2026-11-01. Replaces claude-mem.

## Goals
- Find what I did and when; see the decisions and reasons; redo a task from its page.
- One source across 4 machines and both personal and team work.
- A teammate can pick up any discussion and continue it.
- Every output (screenshots, Sheets, files, PRs) is visible from the page.

## Non-goals (for now)
- RAG / vector search. Add `qmd` only when `index.md` is too long to read or agents miss pages.
- Claude Code on the web (cloud sessions). Later: a `/set-wiki` push-at-end step.
- Capture on machine sleep. The catch-up sweep covers it.

## Vaults
A vault = a name + a GitHub repo (+ its Drive folder). Any number.

```toml
# ~/.wiki/config.toml (one per machine)
default = "personal"              # folder not mapped -> personal (safe side)

[vaults.personal]
repo  = "you/wiki-personal"
path  = "~/wikis/personal"

[vaults.work]
repo  = "your-org/wiki-work"
path  = "~/wikis/work"
drive = "<shared-drive-id>"
auth  = "gws"                      # or path to a service-account key

[folders]
"~/code/company-repo" = "work"
```

Vault choice for a session, first match wins: `/set-wiki` in the session → `[folders]` → `default`.
`/set-wiki off` = do not capture this session.

## Vault layout (OKF: .md + YAML frontmatter, `type` required, markdown links)
```
index.md                       one line per page; agents read this first
log/<machine>/YYYY-MM.md       dated line per session; one writer per file
sessions/YYYY-MM-DD-<short>-<id8>.md  type: Session (<short> = 2-5 word slug; <id8> = session id start)
meetings/YYYY-MM-DD-<slug>.md         type: Meeting
discussions/<slug>.md                 type: Discussion (status, owner, dated sections)
projects/<name>.md                    type: Project (decisions with dates + links)
howto/<task>.md                       type: Howto (steps to redo a task)
_drive/                        gitignored local copy of the vault's Drive images
.obsidian/                     gitignored
```
Links are markdown links (`[t](../x.md)`), not `[[wikilinks]]` — Obsidian setting
"Use [[Wikilinks]]" off.

### Session frontmatter
```yaml
type: Session
title: ...
tool: claude | codex | agy | opencode | omp
machine: my-pc
project: my-project
cwd: ...
session_id: ...          # resume on that machine only
start: ... / end: ...
status: done | in-progress
anchor: <uuid of last event covered>
meetings: [{path, link: sure|likely}]
outputs: [{kind, url}]   # found by scanning the raw record, not by the model
```

## Capture (automatic)
Triggers:
1. Session end (Claude SessionEnd; opencode idle event).
2. Idle 50 min after the last reply (before the ~1 h prompt cache expires).
3. Catch-up sweep every few minutes: any session whose record has events after its page's
   `anchor` and whose last reply finished (`stop_reason` end_turn). Covers sleep, crashes, Codex,
   omp.

Summariser:
- Preferred: resume a COPY of the same session with the same model so the cache is reused
  (`claude -p --resume <id> --fork-session`). Codex: to verify whether a copy is possible.
- Fallback: fresh cheap model reads the transcript text after `anchor` (prose + tool names only),
  fenced as data, not instructions.
- Output markers `@@TITLE@@ @@STATUS@@ @@LOG@@ @@DECISIONS@@ @@HOWTO@@ @@OUTPUTS@@`; one retry;
  `SKIP` allowed. Skip sessions under 3 turns.

Deterministic outputs (no model, no cost):
- The raw record (tool inputs, tool results, assistant text) is scanned for claude.ai artifact links,
  Google Docs/Sheets/Slides/Drive links, GitHub PR/issue/commit links, links a creating command
  printed, and absolute paths under `/mnt/`. Deduped, capped at 40, merged into `## Outputs`
  (model bullets kept; missing ones added as `- link:` / `- path:`) and the `outputs:` frontmatter.
- Image files (png/jpg/webp, 20 KB - 5 MB, still on disk) the session wrote or looked at: the newest 5
  go to the vault's Drive folder (when the vault has `drive`) and are embedded under `## Screenshots`.
  An upload error is logged; it never fails the capture.
- A recapture keeps the page's existing path (found by session id), so one session is one file.

Writing style: every page is written for a reader who is not an engineer. Line 1 gives context; then
ASD-STE100 Simplified Technical English; the project's domain words come from its `GLOSSARY.md`
(`GLOSSARY-MAP.md` -> the right one), found by walking up from the session folder to the git root.
Only the entries whose term or `_Avoid_` word appears in the session text go into the prompt (cap ~12 KB).

Safety:
- Loop guard: env `AGENT_WIKI_RUNNING=1` set on the summariser; every hook exits if set.
- Per-session `mkdir` lock (stale after 5 min); per-vault lock for git.
- Secret remover (token/key/JWT/PEM regexes) on every page before write.
- Git: pull --rebase, retry with a limit; on failure keep the page queued and report — never
  swallow.
- One writer per file (`log/<machine>/`, session pages per host+session).

## Meetings (Wispr Flow)
- Daily job on every machine that has a Wispr login; the first one to run does the work, the others skip.
  Timer: 08:00 plus `RandomizedDelaySec=30min` (`agent-wiki install` also rewrites an older timer without it).
- Login check first: `claude mcp list` (60 s limit) must show a connected server whose URL contains
  `wisprflow.ai/connect/mcp` — the claude.ai connector (`claude.ai Wispr Flow`) or one added by hand (e.g. `wispr`).
  None, or "Needs authentication" → log "meetings: no Wispr login on this machine, skipped", exit 0. If several are
  connected, a direct server wins over the connector. A server that is listed but still connecting is re-checked 3 times,
  45 s apart. The tool names come from that server's name: `mcp__` + name with every character that is not a letter, digit,
  `_` or `-` turned into `_` (`claude.ai Wispr Flow` → `mcp__claude_ai_Wispr_Flow__`, `wispr` → `mcp__wispr__`).
  Config key `wispr_tool_prefix` overrides it.
- Who is the user? Each person has their own Wispr login, so the run record is per person, not per vault. The name is needed
  before the import (the record is checked first), so it cannot come from the import's own model call. Order: config key
  `wispr_user`, else `git config --global user.email`, else the OS user name. It is slugged (lowercase, `a-z0-9-`) for file
  names. `agent-wiki status` shows the name and where it came from.
- Run record per user: `.agent-wiki/meetings/<user>.json` in the vault, tracked in git:
  `{last_run, machine, last_meeting_start}` (plus `claim_by`, `claim_at` while an import runs).
  Flow: pull; if `last_run` is under `meetings_min_hours` (default 20) old → skip ("already imported by <machine> at <time>");
  if another machine's claim is under 2 h old → skip; else commit + push our claim. A rejected push means another machine was
  faster: pull and check again. After the import: write `last_run`, `machine`, `last_meeting_start`, clear the claim, push.
  A failed import only clears the claim. `--force` ignores the hour rule (never a fresh claim of another machine);
  `--dry-run` only reads the record. Two users never block each other (they write different files); two machines of the same
  user do.
- Old vaults have one record for everybody, `.agent-wiki/meetings.json`. The first user to run, who has no file yet, takes it
  over: its content moves to that user's file and the old file is removed (`git rm`), in the same commit as the claim (also
  when the answer is "skip", so the next user does not inherit it). If it holds a fresh claim (an import in the old format is
  running), nothing moves and the user skips. The old file is never removed in any other case.
- Pull meetings that started after `last_meeting_start` minus one day (a late-edited meeting is re-read). The point comes from
  the user's record, so every machine of that user reads from the same place; a user with no record yet falls back to this
  machine's state.
  A run with unreadable meetings, `--limit` or `--since` does not move it.
- Dedupe by `wispr_id`; the same meeting from two teammates = one page. The page lists who recorded it in frontmatter
  `recorded_by: [<user>, …]`. When a second person imports a meeting that already has a page, she is added to that list and
  the page is not rewritten. The same person reading a meeting again (a late edit) rewrites it, keeping the list. A page from
  an older version has no list: it is rewritten once and gets one.
- Page: date, attendees, summary, decisions, action items, link to Wispr.
- Linking both ways: sure (session opened/named the meeting) or likely (same project+topic within
  ~7 days). Action item done in a session → marked done with a link.
- Wispr is a claude.ai connector; a headless run can start before it is connected ("still
  connecting"). The list call is retried 3 times, 45 s apart; then the import fails with a clear
  reason kept in state, and `agent-wiki status` shows "meetings: last import failed <time>: <reason>".
- `agent-wiki status` also shows which user this machine imports as, the last import of that user and its machine (read from
  the vault record, no pull) and whether this machine has a Wispr login (`claude mcp list`, about 10 s).

## Reading the wiki (automatic)
`agent-wiki hook claude-prompt` / `codex-prompt` run on every prompt (UserPromptSubmit; same JSON in
and out for both agents). A model-free keyword search over page titles, descriptions, projects and
tags prints up to 3 related pages as `additionalContext`. It prints nothing for slash commands,
prompts under 4 words, weak matches, or the session's own page. A small cache (page size + mtime)
keeps it fast on a big vault.

## Discussions (manual, via the skill)
"save this discussion" → `discussions/<slug>.md` (points, decisions, open questions, next steps,
owner, status). "continue discussion X" → read it, work, append a dated section + session link.

## Outputs
- Images/screenshots → the vault's Drive folder; page embeds `_drive/...` (local copy, synced by
  the job via gws/SA) + the Drive link.
- Google Sheets → link + snapshot (key rows as a table + screenshot).
- Files, PRs, artifacts → links. Large media → NAS path only.

## Packaging
- npm package `agent-wiki`, CLI `agent-wiki` (core, agent-agnostic).
- `npx agent-wiki install` — detects agents, wires adapters, writes config, clones vaults,
  installs a user systemd timer (sweep + meetings). Re-runnable; it updates an older meetings timer.
- One `wiki` skill (Agent Skills format) for all agents: `set-wiki`, save/continue discussion,
  lookup.
- Adapters: Claude Code (marketplace plugin: skill + hooks), Codex (`hooks.json` + skill), opencode
  (JS plugin), omp (skill; sweep reads its sessions).

## Build order (this machine first, test each step)
1. Repos `you/wiki-personal`, `your-org/wiki-work` (private).
2. Config + `set-wiki` skill (Claude, Codex).
3. Capture: hook, idle timer, sweep; prove cache-reuse fork works.
4. Wispr import + links.
5. Drive images.
6. Export claude-mem notes to the personal vault; uninstall claude-mem.
7. Install script; roll out to the other 3 machines; opencode/omp adapters.

## Borrowed from (read 2026-11-01)
- takashito/claude-obsidian-chronicle — loop guard, mkdir lock, anchor, SKIP/markers.
- AlexanderMakarov/llm-wiki — secret regexes, session-ready check, Codex file format.
- yvoolab/claude-code-session-sharing — per-host file names; its silent git errors are avoided.
