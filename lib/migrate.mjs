// migrate-names: give old session pages (sessions/YYYY-MM-DD-<tool>-<id8>.md) a short title in the
// file name, and rewrite every link to them across the vault. No model: the short title comes from
// the page title.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter } from './vault.mjs';
import { OLD_NAME, shortFromTitle, sessionFileName } from './names.mjs';
import { mdFiles, brokenLinks } from './links.mjs';

// [{ from, to }] file names inside sessions/.
export function planRenames(dir) {
  const d = path.join(dir, 'sessions');
  if (!fs.existsSync(d)) return [];
  const taken = new Set(fs.readdirSync(d));
  const plan = [];
  for (const f of fs.readdirSync(d).sort()) {
    const m = f.match(OLD_NAME);
    if (!m) continue;
    const fm = readFrontmatter(path.join(d, f));
    const to = sessionFileName(m[1], shortFromTitle(fm.title || ''), m[3]);
    if (to === f || taken.has(to)) continue;
    taken.add(to);
    plan.push({ from: f, to });
  }
  return plan;
}

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

// Rename the files (git mv when the vault is a git repo) and rewrite links. Returns counts.
export function applyRenames(dir, plan) {
  const isGit = fs.existsSync(path.join(dir, '.git'));
  for (const { from, to } of plan) {
    const a = path.join(dir, 'sessions', from);
    const b = path.join(dir, 'sessions', to);
    if (isGit && git(dir, 'mv', a, b).status === 0) continue;
    fs.renameSync(a, b);
  }
  const map = new Map(plan.map(({ from, to }) => [from, to]));
  let files = 0;
  let links = 0;
  const bare = new RegExp(`\\]\\((${plan.map((p) => p.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)'})\\)`, 'g');
  for (const file of mdFiles(dir)) {
    let text = fs.readFileSync(file, 'utf8');
    const before = text;
    // Any path form: ../sessions/x.md, ../../sessions/x.md, sessions/x.md, frontmatter "sessions/x.md".
    text = text.replace(/(sessions\/)(\d{4}-\d{2}-\d{2}-[^/\s)"'\]]+?\.md)/g, (all, pre, name) => {
      if (!map.has(name)) return all;
      links++;
      return pre + map.get(name);
    });
    // Links written inside sessions/ itself without a folder: ](x.md)
    if (path.basename(path.dirname(file)) === 'sessions') {
      text = text.replace(bare, (all, name) => { links++; return `](${map.get(name)})`; });
    }
    if (text !== before) { fs.writeFileSync(file, text); files++; }
  }
  return { renamed: plan.length, files, links };
}

// Update the capture state (`page` of each session) after a rename.
export function renameInState(state, plan) {
  const map = new Map(plan.map(({ from, to }) => [`sessions/${from}`, `sessions/${to}`]));
  let n = 0;
  for (const v of Object.values(state)) if (v && map.has(v.page)) { v.page = map.get(v.page); n++; }
  return n;
}

export { brokenLinks };
