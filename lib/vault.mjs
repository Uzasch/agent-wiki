// Write OKF pages into a vault and sync it with git.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';
import { withLock } from './lock.mjs';

const TYPE_DIRS = ['sessions', 'meetings', 'discussions', 'projects', 'howto'];
// history/ pages live one level deeper (history/<source>/<project>/YYYY-MM.md), so the index
// lists the per-source index pages, not every page.

const yamlValue = (v) => {
  if (Array.isArray(v)) return v.length ? '\n' + v.map((x) => `  - ${yamlValue(x)}`).join('\n') : '[]';
  if (v && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v ?? ''));
};
export const frontmatter = (obj) =>
  '---\n' + Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${yamlValue(v)}`).join('\n') + '\n---\n';

export function readFrontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    try { out[kv[1]] = JSON.parse(kv[2]); } catch { out[kv[1]] = kv[2]; }
  }
  return out;
}

const VAULT_README = `# Agent wiki

Pages are OKF: one markdown file per thing, YAML frontmatter with a required \`type\`, markdown links.
Agents: read \`index.md\` first, then open the pages it lists. Never write secrets here.

- \`sessions/\` — type: Session. One per agent session (Claude, Codex, …), written automatically.
- \`meetings/\` — type: Meeting. From Wispr Flow.
- \`discussions/\` — type: Discussion. Saved on request; anyone may continue one by adding a dated section.
- \`projects/\` — type: Project. Decisions over time, with links.
- \`howto/\` — type: Howto. Steps to redo a task.
- \`log/<machine>/YYYY-MM.md\` — one line per capture, one writer per file.
- \`_drive/\` — local copy of this vault's Drive images (not in git).
`;

export function initVault(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const d of [...TYPE_DIRS, 'log']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const put = (f, c) => { const p = path.join(dir, f); if (!fs.existsSync(p)) fs.writeFileSync(p, c); };
  put('README.md', VAULT_README);
  put('AGENTS.md', VAULT_README);
  put('.gitignore', '_drive/\n.obsidian/\n.trash/\n');
  for (const d of [...TYPE_DIRS, 'log']) put(`${d}/.gitkeep`, '');
  writeIndex(dir);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export function sessionPagePath(s) {
  const date = (s.events[0]?.ts || new Date().toISOString()).slice(0, 10);
  return `sessions/${date}-${s.tool}-${String(s.id).slice(0, 8)}.md`;
}

export function writeSessionPage(dir, s, sum, { machine, vaultName }) {
  const rel = sessionPagePath(s);
  const first = s.events[0]?.ts;
  const last = s.events.at(-1)?.ts;
  const fm = frontmatter({
    type: 'Session',
    title: sum.title,
    description: (sum.summary || '').split('\n')[0].replace(/^(.{200}).+$/, '$1…'),
    tool: s.tool,
    machine,
    project: sum.project || '',
    cwd: s.cwd,
    session_id: s.id,
    model: s.model,
    start: first,
    end: last,
    status: sum.status,
    anchor: s.events.at(-1)?.id,
    vault: vaultName,
    captured: new Date().toISOString(),
    capture: sum.how,
    tags: ['session', s.tool],
  });
  const sec = (h, body) => (body ? `\n## ${h}\n\n${body}\n` : '');
  const resume = s.tool === 'codex' ? `codex resume ${s.id}` : s.tool === 'agy' ? `agy --conversation ${s.id}` : `claude --resume ${s.id}`;
  const body = `# ${sum.title}\n\n${sum.summary || ''}\n`
    + sec('Decisions', sum.decisions)
    + sec('How to redo', sum.howto)
    + sec('Next', sum.next)
    + sec('Outputs', sum.outputs)
    + sec('Meetings', sum.meetings)
    + `\n---\nReopen on ${machine}: \`${resume}\` (from \`${s.cwd}\`)\n`;
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), redact(fm + '\n' + body));

  const month = new Date().toISOString().slice(0, 7);
  const logRel = `log/${machine}/${month}.md`;
  fs.mkdirSync(path.join(dir, path.dirname(logRel)), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(path.join(dir, logRel),
    redact(`- ${stamp} · ${s.tool} · ${sum.project || ''} · [${sum.title}](../../${rel}) · ${sum.status}\n`));
  return rel;
}

// "title — description — N pages" per project hub, biggest first.
function projectGroup(dir) {
  const p = path.join(dir, 'projects');
  if (!fs.existsSync(p)) return [];
  const count = {};
  for (const d of ['sessions', 'meetings', 'discussions', 'howto']) {
    const q = path.join(dir, d);
    if (!fs.existsSync(q)) continue;
    for (const f of fs.readdirSync(q).filter((x) => x.endsWith('.md'))) {
      const pr = readFrontmatter(path.join(q, f)).project;
      if (pr) count[pr] = (count[pr] || 0) + 1;
    }
  }
  return fs.readdirSync(p).filter((f) => f.endsWith('.md')).map((f) => {
    const fm = readFrontmatter(path.join(p, f));
    const n = count[f.slice(0, -3)] || 0;
    return { n, line: `- [${fm.title || f}](projects/${f}) — ${fm.description || ''} — ${n} page${n === 1 ? '' : 's'}` };
  }).sort((a, b) => b.n - a.n || a.line.localeCompare(b.line)).map((r) => r.line);
}

// index.md is derived from the pages, so it is rebuilt, never merged.
export function writeIndex(dir) {
  const groups = [];
  const projectRows = projectGroup(dir);
  if (projectRows.length) groups.push(`## Projects\n\n${projectRows.join('\n')}\n`);
  for (const d of TYPE_DIRS) {
    if (d === 'projects') continue;
    const p = path.join(dir, d);
    if (!fs.existsSync(p)) continue;
    const rows = fs.readdirSync(p).filter((f) => f.endsWith('.md')).map((f) => {
      const fm = readFrontmatter(path.join(p, f));
      const date = fm.start || fm.date || fm.updated || f.slice(0, 10);
      const meta = [String(date).slice(0, 10), fm.tool, fm.project, fm.status].filter(Boolean).join(' · ');
      return { date: String(date), line: `- [${fm.title || f}](${d}/${f}) — ${meta}` };
    }).sort((a, b) => b.date.localeCompare(a.date));
    if (rows.length) groups.push(`## ${d[0].toUpperCase() + d.slice(1)}\n\n${rows.map((r) => r.line).join('\n')}\n`);
  }
  const hist = path.join(dir, 'history');
  if (fs.existsSync(hist)) {
    const rows = fs.readdirSync(hist, { withFileTypes: true }).filter((e) => e.isDirectory()
      && fs.existsSync(path.join(hist, e.name, 'index.md'))).map((e) => {
      const fm = readFrontmatter(path.join(hist, e.name, 'index.md'));
      return `- [${fm.title || e.name}](history/${e.name}/index.md) — ${fm.description || ''}`.trimEnd();
    });
    if (rows.length) groups.push(`## History\n\n${rows.join('\n')}\n`);
  }
  const text = frontmatter({ type: 'Index', title: 'Index' })
    + '\n# Index\n\nOne line per page, newest first. Read this first.\n\n' + groups.join('\n');
  fs.writeFileSync(path.join(dir, 'index.md'), text);
}

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
};

// Commit everything (pages + manual Obsidian edits), rebase on the remote, rebuild the index, push.
// On failure the commits stay local and are pushed by the next sync.
export function syncVault(dir, message) {
  if (!fs.existsSync(path.join(dir, '.git'))) { writeIndex(dir); return { ok: true, note: 'no git' }; }
  const res = withLock(`git-${dir}`, () => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
    const hasRemote = git(dir, 'remote').out.trim().length > 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (hasRemote) {
        const pull = git(dir, 'pull', '--rebase', '--autostash', '-q');
        if (!pull.ok) {
          git(dir, 'rebase', '--abort');
          return { ok: false, error: `pull failed: ${pull.out.slice(0, 400)}` };
        }
      }
      writeIndex(dir);
      git(dir, 'add', 'index.md');
      const madeIndex = git(dir, 'commit', '-q', '-m', 'index').ok;
      if (!hasRemote) return { ok: true, note: 'no remote' };
      const push = git(dir, 'push', '-q');
      if (push.ok) return { ok: true };
      if (madeIndex) {
        git(dir, 'reset', '-q', '--soft', 'HEAD~1');
        git(dir, 'restore', '--staged', '--worktree', 'index.md');
      }
      if (attempt === 3) return { ok: false, error: `push failed: ${push.out.slice(0, 400)}` };
    }
    return { ok: false, error: 'unreachable' };
  }, { staleMs: 10 * 60_000 });
  return res.locked ? { ok: false, error: 'vault busy (another sync running)' } : res.value;
}
