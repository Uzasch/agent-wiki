// A tiny reader for ~/.wiki/config.toml that needs no library, for the prompt hook (it runs on every
// prompt, and loading the TOML library costs more than the search). It understands only what the
// config file normally holds: `key = "string" | number | true | false`, and [section] headers.
// Anything else makes it return null, and the caller then uses the full reader (config.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WIKI_DIR = process.env.AGENT_WIKI_HOME || path.join(os.homedir(), '.wiki');
export const STATE_DIR = path.join(WIKI_DIR, 'state');
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const segments = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+)/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] ?? m[3]));

function value(raw) {
  const t = raw.trim();
  let m;
  if ((m = t.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/))) return JSON.parse(m[1]);
  if ((m = t.match(/^'([^']*)'\s*(?:#.*)?$/))) return m[1];
  const v = t.replace(/\s+#.*$/, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  throw new Error('unsupported');
}

export function quickConfig(file = path.join(WIKI_DIR, 'config.toml')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { default: 'personal', vaults: {}, folders: {} }; }
  const cfg = { default: 'personal', vaults: {}, folders: {} };
  let section = [];
  try {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const head = t.match(/^\[([^\[\]]+)\]\s*(#.*)?$/);
      if (head) { section = segments(head[1]); continue; }
      const kv = t.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (!kv) throw new Error('unsupported');
      const key = segments(kv[1])[0];
      const val = value(kv[2]);
      if (!section.length) cfg[key] = val;
      else if (section[0] === 'folders' && section.length === 1) cfg.folders[key] = val;
      else if (section[0] === 'vaults' && section.length === 2) (cfg.vaults[section[1]] ||= {})[key] = val;
    }
  } catch { return null; }
  return cfg;
}

// Same rules as config.mjs: a /set-wiki marker is not known here; longest matching folder wins; else the default.
export function quickVault(cfg, cwd) {
  let best = null;
  let bestLen = -1;
  for (const [folder, vault] of Object.entries(cfg.folders)) {
    const f = expand(folder).replace(/\/+$/, '');
    if ((cwd === f || cwd.startsWith(f + '/')) && f.length > bestLen) { best = vault; bestLen = f.length; }
  }
  return best || cfg.default;
}

export const quickVaultPath = (cfg, name) => (cfg.vaults[name] ? expand(cfg.vaults[name].path || `~/wikis/${name}`) : null);
