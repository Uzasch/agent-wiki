# agent-wiki

A git-backed markdown wiki of what you did with coding agents — Claude Code, Codex, Antigravity
(agy), with opencode/omp next — across projects, machines and a team. Pages use the OKF format
(markdown + YAML frontmatter) and open in Obsidian.

- **Automatic capture:** when a session ends or goes idle, a cheap model writes a page: what was
  done, decisions and reasons, how to redo it, next steps, outputs. Background/headless runs are
  skipped.
- **Vaults:** any number of git repos (e.g. personal, work). `/set-wiki <vault>` per session, or a
  folder → vault map.
- **Projects organize themselves:** pages are assigned to projects automatically, with one hub page
  per project (timeline, decisions, open items).
- **Meetings:** daily import from Wispr Flow, linked to the sessions they relate to. Any machine with a
  Wispr login can run it; a record in the vault makes the first one do the work and the others skip.
- **Links and screenshots, automatically:** artifact, Sheets/Docs, GitHub and `/mnt/` links are found in
  the raw record, and the newest screenshots go to Drive. No model needed.
- **Agents read the wiki on their own:** a prompt hook shows related past pages (Claude Code and Codex).
- **Plain writing:** pages use simple technical English and the project's own glossary words.
- **Images:** stored on Google Drive, embedded from a local copy.
- **Secrets** are redacted before anything is written.

## Install

```sh
git clone https://github.com/Uzasch/agent-wiki && cd agent-wiki && npm install
node bin/agent-wiki.mjs install --dry-run   # see what it will change
node bin/agent-wiki.mjs install
agent-wiki vault new work your-org/wiki-work
```

`agent-wiki migrate-names [--vault N] [--dry-run]` gives old session pages a short title in the file
name and fixes every link to them.

Settings live in `~/.wiki/config.toml`. Design and decisions: [DESIGN.md](DESIGN.md).

Status: early, used daily on Linux. MIT licence.
