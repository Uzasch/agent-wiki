// Per-machine settings: ~/.wiki/config.toml. Vault = name + GitHub repo + local path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

export const HOME = os.homedir();
export const WIKI_DIR = process.env.AGENT_WIKI_HOME || path.join(HOME, '.wiki');
export const CONFIG_PATH = path.join(WIKI_DIR, 'config.toml');
export const STATE_DIR = path.join(WIKI_DIR, 'state');

export const expand = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
const collapse = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

const DEFAULTS = {
  default: 'personal',
  machine: os.hostname(),
  idle_minutes: 50,
  min_turns: 3,
  include_headless: false,
  fallback_model: 'haiku',
  capture_mode: 'fresh',
  meetings_min_hours: 20,   // one machine imports Wispr meetings per this many hours
  vaults: {},
  folders: {},
};

export function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) raw = parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return { ...DEFAULTS, ...raw, vaults: raw.vaults || {}, folders: raw.folders || {} };
}

export function saveConfig(cfg) {
  fs.mkdirSync(WIKI_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, stringify(cfg) + '\n');
}

export function vaultPath(cfg, name) {
  const v = cfg.vaults[name];
  return v ? expand(v.path || `~/wikis/${name}`) : null;
}

// Folder → vault: the longest configured folder that contains cwd wins.
export function vaultForFolder(cfg, cwd) {
  let best = null;
  let bestLen = -1;
  for (const [folder, vault] of Object.entries(cfg.folders)) {
    const f = expand(folder).replace(/\/+$/, '');
    if ((cwd === f || cwd.startsWith(f + '/')) && f.length > bestLen) {
      best = vault;
      bestLen = f.length;
    }
  }
  return best;
}

// Priority: /set-wiki marker in the session → folder map → default.
export function resolveVault(cfg, cwd, marker) {
  if (marker) return marker;
  return vaultForFolder(cfg, cwd) || cfg.default;
}

export function rememberFolder(cfg, cwd, vault) {
  cfg.folders[collapse(cwd)] = vault;
  saveConfig(cfg);
}
