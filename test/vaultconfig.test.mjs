import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('vault drive/auth come from <vault>/.agent-wiki/vault.toml, local config overrides', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
  const vault = path.join(home, 'v');
  fs.mkdirSync(path.join(vault, '.agent-wiki'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.agent-wiki', 'vault.toml'), 'drive = "SHARED"\nauth = "gws"\n');
  fs.writeFileSync(path.join(home, 'config.toml'), `[vaults.w]\npath = "${vault}"\n[vaults.o]\npath = "${vault}"\ndrive = "LOCAL"\n`);
  process.env.AGENT_WIKI_HOME = home;
  const { loadConfig, saveConfig } = await import('../lib/config.mjs?t=' + Date.now());
  const cfg = loadConfig();
  assert.equal(cfg.vaults.w.drive, 'SHARED');
  assert.equal(cfg.vaults.w.auth, 'gws');
  assert.equal(cfg.vaults.o.drive, 'LOCAL');
  saveConfig(cfg);
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /SHARED/);
});
