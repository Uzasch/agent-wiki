// Project glossary for the writing style: find GLOSSARY.md (or GLOSSARY-MAP.md -> the right glossary),
// parse its entries, and pick ONLY the entries whose term or _Avoid_ words appear in a text.
// A glossary can be 200 KB, so the prompt block is capped (default 12 KB).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GLOSSARY_CAP = 12_000;
const DEF_CHARS = 280;

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// Glossary files for a folder: walk up from `cwd` to the git root (nearest first).
// A GLOSSARY.md is used as is. A GLOSSARY-MAP.md lists contexts as links to other GLOSSARY.md files;
// the context whose folder contains `cwd` wins, and when none does, every listed one is used.
export function findGlossaries(cwd, { maxLevels = 12 } = {}) {
  const found = [];
  const add = (f) => { if (f && fs.existsSync(f) && !found.includes(f)) found.push(f); };
  let dir = path.resolve(cwd || '.');
  for (let i = 0; i < maxLevels; i++) {
    add(path.join(dir, 'GLOSSARY.md'));
    const map = read(path.join(dir, 'GLOSSARY-MAP.md'));
    if (map) {
      const links = [...map.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => path.resolve(dir, m[1]))
        .filter((f) => path.basename(f).toLowerCase().includes('glossary') && fs.existsSync(f));
      const mine = links.filter((f) => path.resolve(cwd || '.').startsWith(path.dirname(f) + path.sep) || path.resolve(cwd || '.') === path.dirname(f));
      for (const f of mine.length ? mine : links) add(f);
    }
    if (fs.existsSync(path.join(dir, '.git')) || dir === os.homedir()) break;   // the repo root (or home) is the top
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return found;
}

// Split "a, b (c, d), e / f" into plain words to avoid; explanations in brackets are dropped.
export function splitAvoid(line) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of line) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.flatMap((x) => x.replace(/\([^)]*\)/g, '').split(/\s+\/\s+/)).map((x) => x.replace(/[`*_"]/g, '').trim())
    .filter((x) => x.length >= 3);
}

// Entries look like:   **Term**:\n<definition>\n_Avoid_: a, b, c
export function parseGlossary(text, source = '') {
  const entries = [];
  let cur = null;
  const flush = () => { if (cur) entries.push(cur); cur = null; };
  for (const line of String(text).split('\n')) {
    const head = line.match(/^\*\*([^*]+)\*\*:\s*(.*)$/);
    if (head) {
      flush();
      cur = { term: head[1].trim(), def: head[2].trim(), avoid: [], source };
      continue;
    }
    if (/^#{1,6}\s/.test(line)) { flush(); continue; }
    if (!cur) continue;
    const av = line.match(/^_Avoid_:\s*(.*)$/);
    if (av) { cur.avoid.push(...splitAvoid(av[1])); continue; }
    if (line.trim() && !cur.def.includes(line.trim())) cur.def += (cur.def ? ' ' : '') + line.trim();
  }
  flush();
  return entries.filter((e) => e.term);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word, case-insensitive, plural tolerant.
const wordRe = (w) => new RegExp(`(?<![A-Za-z0-9])${esc(w).replace(/\s+/g, '\\s+')}(?:s|es)?(?![A-Za-z0-9])`, 'gi');
const count = (text, w) => (text.match(wordRe(w)) || []).length;

const shortDef = (d) => {
  const t = d.replace(/\s+/g, ' ').trim();
  if (t.length <= DEF_CHARS) return t;
  const cut = t.slice(0, DEF_CHARS);
  const dot = cut.lastIndexOf('. ');
  return (dot > 80 ? cut.slice(0, dot + 1) : cut.replace(/\s+\S*$/, '')) + ' ...';
};

// Entries whose term (strong) or avoid word (weak) appears in `text`, best first.
export function pickEntries(entries, text) {
  const scored = [];
  for (const e of entries) {
    const termHits = count(text, e.term);
    const avoidHits = e.avoid.reduce((n, a) => n + (a.length >= 4 || /\s/.test(a) ? count(text, a) : 0), 0);
    if (!termHits && !avoidHits) continue;
    scored.push({ e, score: termHits * 4 + Math.min(avoidHits, 5) });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.e);
}

// The prompt block: only the matching entries, within `cap` characters.
export function glossaryBlock(entries, text, { cap = GLOSSARY_CAP } = {}) {
  const lines = [];
  let used = 0;
  for (const e of pickEntries(entries, text)) {
    const line = `- ${e.term}: ${shortDef(e.def)}${e.avoid.length ? ` | Avoid: ${e.avoid.join(', ')}` : ''}`;
    if (used + line.length + 1 > cap) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

// Everything for one session folder: find the glossary files, parse, pick. Returns '' when none.
export function glossaryFor(cwd, text, opts) {
  const entries = findGlossaries(cwd).flatMap((f) => parseGlossary(read(f) || '', f));
  return entries.length ? glossaryBlock(entries, text, opts) : '';
}

// Same, for several folders at once (a vault is mapped to folders): used where no session folder exists,
// e.g. the meeting importer. `text` = what the vault is about (recent page titles, project descriptions).
export function glossaryForFolders(folders, text, opts) {
  const files = [...new Set(folders.flatMap((f) => findGlossaries(f)))];
  const entries = files.flatMap((f) => parseGlossary(read(f) || '', f));
  return entries.length ? glossaryBlock(entries, text, opts) : '';
}

// Plain-language style rule. `terms` = glossaryFor() output (may be '').
export function styleBlock(terms) {
  return `Writing style. The reader is NOT an engineer and does not know this session. Follow these rules in every text field:
- Start the summary with ONE line of context: what this work is and why it matters, in plain words.
- Then write in ASD-STE100 Simplified Technical English: short sentences (about 20 words at most), one idea per sentence, active voice, simple common words, no jargon. If a technical word is needed, say what it means in a few words.
- Use the project's own domain words from the list below. Never use the words after "Avoid".${terms ? `\nDomain words (term: meaning | Avoid: words not to use):\n${terms}` : '\n(No project glossary was found: use plain, common words.)'}`;
}
