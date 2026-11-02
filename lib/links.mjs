// Relative markdown links inside a vault: find the ones that point to a file that does not exist.
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', '.obsidian', '.trash', '_drive', 'node_modules']);

export function* mdFiles(dir, base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* mdFiles(p, base);
    else if (e.name.endsWith('.md')) yield p;
  }
}

// [{ file, link }] for every `](relative/path.md)` whose target is missing. Anchors and queries are ignored.
export function brokenLinks(vaultDir) {
  const bad = [];
  for (const file of mdFiles(vaultDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)/g)) {
      const link = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('#')) continue;
      const target = path.resolve(path.dirname(file), decodeURIComponent(link));
      if (!fs.existsSync(target)) bad.push({ file: path.relative(vaultDir, file), link });
    }
  }
  return bad;
}
