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
sessions/YYYY-MM-DD-<tool>-<id8>.md   type: Session
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
outputs: [{kind, url, local}]
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

Safety:
- Loop guard: env `AGENT_WIKI_RUNNING=1` set on the summariser; every hook exits if set.
- Per-session `mkdir` lock (stale after 5 min); per-vault lock for git.
- Secret remover (token/key/JWT/PEM regexes) on every page before write.
- Git: pull --rebase, retry with a limit; on failure keep the page queued and report — never
  swallow.
- One writer per file (`log/<machine>/`, session pages per host+session).

## Meetings (Wispr Flow)
- Daily job, one machine per person. Pull meetings since last run; all meetings (operator choice).
- Dedupe by `wispr_id`; the same meeting from two teammates = one page.
- Page: date, attendees, summary, decisions, action items, link to Wispr.
- Linking both ways: sure (session opened/named the meeting) or likely (same project+topic within
  ~7 days). Action item done in a session → marked done with a link.
- Risk to verify first: Wispr is a claude.ai connector; check it works from a headless run.

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
  installs a user systemd timer (sweep + meetings). Re-runnable.
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
