// Export old claude-mem notes (SQLite, read-only) into history/claude-mem/<project>/YYYY-MM.md pages.
import fs from 'node:fs';
import path from 'node:path';
import { frontmatter } from './vault.mjs';
import { redact } from './redact.mjs';

const DEFAULT_DB = path.join(process.env.HOME || '', '.claude-mem', 'claude-mem.db');

// Observation types worth keeping. claude-mem's model invented ~700 one-off types
// ("wave-9-final-eslint-confirmation", "polling-deadlock", ...): nearly all are verification or
// polling chatter. Keep the real kinds; skip the long tail.
const KEEP = /^(discovery|change|feature|feature-implementation|bugfix|bug|bug-fix|fix|fix-applied|decision|decision-final|refactor|refactoring|gotcha|root-cause|root-cause-diagnosis|security_alert|security_note|milestone|implementation|enhancement|optimization|architecture|architectural-decision-record|finding|critical-finding|defect|regression|research|investigation|analysis|reconnaissance|documentation|documentation-update|integration|issue|error|failure|concern|blocker|resolution|reference|context|problem-solution|note|technical-note)$/;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown';
const one = (s, n = 220) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const hhmm = (iso) => iso.slice(11, 16);

// node:sqlite prints an "experimental" warning on load; hide it for this command only.
async function openDb(db) {
  const orig = process.emitWarning;
  process.emitWarning = (w, ...a) => (/SQLite/i.test(String(w)) ? undefined : orig.call(process, w, ...a));
  try { const { DatabaseSync } = await import('node:sqlite'); return new DatabaseSync(`file:${db}?mode=ro`, { readOnly: true }); }
  finally { process.emitWarning = orig; }
}

const MAX_PAGE = 300_000;

export async function importClaudeMem({ db = DEFAULT_DB, vaultDir, dryRun = false }) {
  const d = await openDb(db);
  const obs = d.prepare(`select project, memory_session_id sid, type, title, subtitle, narrative, created_at
    from observations order by created_at`).all();
  const sums = d.prepare(`select project, memory_session_id sid, request, completed, learned, next_steps, created_at
    from session_summaries order by created_at`).all();
  d.close();

  const stats = { observations: obs.length, kept: 0, skipped: 0, skippedTypes: new Set(), summaries: sums.length };
  // project(base) -> month -> day -> sid -> { branch, sums[], obs[] }
  const tree = {};
  const slot = (project, created, sid) => {
    const base = project.split('/')[0];
    const branch = project.includes('/') ? project.slice(base.length + 1) : '';
    const month = created.slice(0, 7);
    const day = created.slice(0, 10);
    const m = ((tree[base] ??= {})[month] ??= {});
    const s = ((m[day] ??= {})[sid] ??= { branch, first: created, sums: [], obs: [] });
    return s;
  };
  for (const o of obs) {
    if (!KEEP.test(o.type)) { stats.skipped++; stats.skippedTypes.add(o.type); continue; }
    stats.kept++;
    slot(o.project, o.created_at, o.sid).obs.push(o);
  }
  for (const s of sums) slot(s.project, s.created_at, s.sid).sums.push(s);

  const pages = [];
  const mkPage = (rel, project, month, day, count, title, bodyLines, desc) => {
    const fm = frontmatter({ type: 'History', title, description: desc, project, month, ...(day ? { day } : {}),
      source: 'claude-mem', count, tags: ['history', 'claude-mem', slug(project)] });
    const page = { rel, project, month, day, count, text: redact(`${fm}\n# ${title}\n\n${bodyLines.join('\n')}`) };
    pages.push(page);
    return page;
  };
  const obsLine = (o) => {
    const note = one(o.narrative || o.subtitle, 200);
    return `- ${hhmm(o.created_at)} [${o.type}] ${one(o.title, 120)}${note ? ' — ' + note : ''}`;
  };
  for (const [project, months] of Object.entries(tree)) {
    const ps = slug(project);
    for (const [month, days] of Object.entries(months)) {
      const monthLines = ['## Days', ''];
      const sumLines = [];
      let count = 0;
      for (const day of Object.keys(days).sort()) {
        const sessions = Object.values(days[day]).sort((a, b) => a.first.localeCompare(b.first));
        // One time-ordered stream per day: full session summaries (as blocks) and observations.
        const sumBlock = (u, tag) => {
          const f = (k, v) => (v ? `  - **${k}:** ${one(v, 300)}` : null);
          return [`- ${hhmm(u.created_at)} **Session summary**${tag ? ` (${tag})` : ''}`, ...[f('Request', u.request), f('Completed', u.completed), f('Learned', u.learned), f('Next', u.next_steps)].filter(Boolean)].join('\n');
        };
        const obsAll = sessions.flatMap((s) => [
          ...s.obs.map((o) => ({ at: o.created_at, line: obsLine(o) + (s.branch ? ` (${s.branch})` : ''), isObs: true })),
          ...s.sums.map((u) => ({ at: u.created_at, line: sumBlock(u, s.branch), isObs: false })),
        ]).sort((a, b) => a.at.localeCompare(b.at));
        // Day page(s): split am/pm, then into numbered parts, if over MAX_PAGE.
        const lines = obsAll.map((e) => e.line);
        const size = (ls) => ls.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
        let chunks = [{ suffix: '', idx: lines.map((_, i) => i) }];
        if (size(lines) > MAX_PAGE) {
          chunks = [{ suffix: '-am', idx: [] }, { suffix: '-pm', idx: [] }];
          obsAll.forEach((e, i) => chunks[Number(hhmm(e.at).slice(0, 2)) < 12 ? 0 : 1].idx.push(i));
          chunks = chunks.flatMap((c) => {
            const out = []; let cur = []; let n = 0;
            for (const i of c.idx) {
              const l = Buffer.byteLength(lines[i]) + 1;
              if (n + l > MAX_PAGE && cur.length) { out.push(cur); cur = []; n = 0; }
              cur.push(i); n += l;
            }
            if (cur.length) out.push(cur);
            return out.length > 1 ? out.map((idx, k) => ({ suffix: `${c.suffix}-${k + 1}`, idx })) : out.map((idx) => ({ suffix: c.suffix, idx }));
          }).filter((c) => c.idx.length);
        }
        const links = [];
        for (const c of chunks) {
          if (!c.idx.length) continue;
          const name = `${day}${c.suffix}`;
          const body = c.idx.map((i) => lines[i]);
          const nObs = c.idx.filter((i) => obsAll[i].isObs).length;
          mkPage(`history/claude-mem/${ps}/${month}/${name}.md`, project, month, day, nObs,
            `${project} — ${name} (claude-mem)`, [`Back to [${month}](../${month}.md).`, '', ...body],
            `Observations claude-mem recorded for ${project} on ${day}${c.suffix}: ${nObs} notes plus session summaries.`);
          links.push(`[${name}](${month}/${name}.md) (${nObs})`);
          count += nObs;
        }
        monthLines.push(`- ${day}: ${links.join(', ') || 'summaries only'}`);
        for (const s of sessions) {
          for (const u of s.sums) sumLines.push(`- ${day} ${hhmm(u.created_at)}${s.branch ? ` (${s.branch})` : ''} — ${one(u.request, 140) || one(u.completed, 140)}`);
        }
      }
      mkPage(`history/claude-mem/${ps}/${month}.md`, project, month, undefined, count,
        `${project} — ${month} (claude-mem)`, [...monthLines, '', '## Sessions (one line each; full summaries are on the day pages)', '', ...sumLines],
        `Session list for ${project} in ${month}, with links to the day pages holding ${count} observations.`);
    }
  }
  pages.sort((a, b) => a.project.localeCompare(b.project) || b.month.localeCompare(a.month) || (a.day || '').localeCompare(b.day || ''));

  const idxLines = [];
  let cur = '';
  for (const p of pages.filter((x) => !x.day)) {
    if (p.project !== cur) { cur = p.project; idxLines.push('', `## ${cur}`, ''); }
    idxLines.push(`- [${p.month}](${p.rel.replace('history/claude-mem/', '')}) — ${p.count} notes in day pages`);
  }
  const index = redact(frontmatter({ type: 'Index', title: 'claude-mem history', description: 'Old claude-mem notes, one page per project per month.' })
    + `\n# claude-mem history\n\nExported from claude-mem. Read-only archive, newest month first per project.\n${idxLines.join('\n')}\n`);

  let bytes = index.length;
  for (const p of pages) bytes += Buffer.byteLength(p.text);
  if (!dryRun) {
    for (const p of pages) {
      const f = path.join(vaultDir, p.rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, p.text);
    }
    fs.writeFileSync(path.join(vaultDir, 'history/claude-mem/index.md'), index);
  }
  return { pages: pages.length, bytes, ...stats, skippedTypes: [...stats.skippedTypes] };
}
