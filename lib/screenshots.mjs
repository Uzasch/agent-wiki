// Screenshots on a session page: upload the session's image files to the vault's Drive folder
// and build the `## Screenshots` markdown. Never throws: an upload error is logged and skipped.
import path from 'node:path';
import { addImage } from './drive.mjs';
import { idPart } from './names.mjs';

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
const stem = (f) => f.replace(/\.[^.]*$/, '');

// Blocks already on the page: { stem-of-name → markdown }, so a recapture does not upload twice.
export function existingBlocks(pageText) {
  const m = String(pageText || '').match(/\n## Screenshots\n([\s\S]*?)(?=\n## |\n---\n|$)/);
  const out = new Map();
  if (!m) return out;
  for (const block of m[1].trim().split(/\n\n+/)) {
    const img = block.match(/!\[[^\]]*\]\([^)]*\/_drive\/[^/)]+\/([^)/]+)\)/);
    if (img) out.set(stem(decodeURIComponent(img[1])), block.trim());
  }
  return out;
}

// images: [{ file }] from pickImages. Returns the section body ('' when nothing to show).
export async function buildScreenshots({ images, vault, vaultName, vaultDir, session, existing = '', upload = addImage, log = () => {} }) {
  if (!vault?.drive || !images?.length) return '';
  const date = (session.events[0]?.ts || new Date().toISOString()).slice(0, 10);
  const have = existingBlocks(existing);
  const blocks = [];
  for (const img of images) {
    const base = path.basename(img.file);
    const name = `${date}-${idPart(session.id)}-${safe(base)}`;
    if (have.has(stem(name))) { blocks.push(have.get(stem(name))); continue; }
    try {
      const r = await upload({ vault, vaultName, vaultDir, file: img.file, name });
      blocks.push(`![${base}](../_drive/${r.month}/${encodeURIComponent(r.name)})\n[Drive](${r.link})`);
    } catch (e) {
      log(`screenshot upload failed for ${base}: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  return blocks.join('\n\n');
}
