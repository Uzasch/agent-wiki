import { SCRATCH, mk, write } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseGlossary, splitAvoid, pickEntries, glossaryBlock, findGlossaries, glossaryFor, styleBlock } from '../lib/glossary.mjs';

const SAMPLE = `# Shop

A small shop.

## Language

### Orders

**Order**:
A request from a customer to buy one or more items. It has exactly one invoice.
_Avoid_: purchase, transaction, basket (the old cart screen, retired)

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: bill, payment request, receipt / voucher

**Parcel**:
One box that leaves the warehouse.
_Avoid_: package

## Relationships

- **Order** has one **Invoice**
`;

test('parseGlossary reads terms, definitions and _Avoid_ words (brackets and slashes handled)', () => {
  const e = parseGlossary(SAMPLE);
  assert.deepEqual(e.map((x) => x.term), ['Order', 'Invoice', 'Parcel']);
  assert.equal(e[0].def, 'A request from a customer to buy one or more items. It has exactly one invoice.');
  assert.deepEqual(e[0].avoid, ['purchase', 'transaction', 'basket']);
  assert.deepEqual(e[1].avoid, ['bill', 'payment request', 'receipt', 'voucher']);
  assert.deepEqual(splitAvoid('a, b (c, d), e / f'), ['b', 'e', 'f'].filter((x) => x.length >= 3));
});

test('only entries whose term or avoid word is in the text are picked, best first', () => {
  const e = parseGlossary(SAMPLE);
  const picked = pickEntries(e, 'We fixed the order screen. The order and the invoice now match.').map((x) => x.term);
  assert.deepEqual(picked, ['Order', 'Invoice']);
  assert.deepEqual(pickEntries(e, 'The Parcel is late.').map((x) => x.term), ['Parcel']);
  assert.deepEqual(pickEntries(e, 'The package is late.').map((x) => x.term), ['Parcel'], 'an avoid word still brings its entry');
  assert.deepEqual(pickEntries(e, 'Nothing here.'), []);
  assert.deepEqual(pickEntries(e, 'Orders and invoices').map((x) => x.term), ['Order', 'Invoice'], 'plural tolerant');
});

test('the block is capped and lists the Avoid words', () => {
  const many = Array.from({ length: 200 }, (_, i) => `**Term${i}**:\n${'Definition text. '.repeat(30)}\n_Avoid_: other${i}\n`).join('\n');
  const entries = parseGlossary(many);
  const text = entries.map((x) => x.term).join(' ');
  const block = glossaryBlock(entries, text, { cap: 3000 });
  assert.ok(block.length <= 3000 && block.length > 2000, `${block.length}`);
  assert.match(block, /\| Avoid: other\d+/);
  assert.match(glossaryBlock(parseGlossary(SAMPLE), 'order'), /^- Order: A request .* \| Avoid: purchase, transaction, basket$/);
});

test('findGlossaries walks up to the git root, follows GLOSSARY-MAP.md, stops at the root', () => {
  const root = mk('repo1', 'x'); const r = path.dirname(root);
  fs.mkdirSync(path.join(r, '.git')); fs.mkdirSync(path.join(r, 'svc', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(r, 'GLOSSARY.md'), SAMPLE);
  fs.writeFileSync(path.join(r, 'svc', 'GLOSSARY.md'), '**Widget**:\nA part.\n_Avoid_: gadget\n');
  assert.deepEqual(findGlossaries(path.join(r, 'svc', 'deep')), [path.join(r, 'svc', 'GLOSSARY.md'), path.join(r, 'GLOSSARY.md')]);
  // above the git root nothing is read
  fs.writeFileSync(path.join(path.dirname(r), 'GLOSSARY.md'), '**Outside**:\nx\n');
  assert.ok(!findGlossaries(r).includes(path.join(path.dirname(r), 'GLOSSARY.md')));
  fs.rmSync(path.join(path.dirname(r), 'GLOSSARY.md'));

  const m = mk('repo2', 'x'); const mr = path.dirname(m);
  fs.mkdirSync(path.join(mr, '.git')); fs.mkdirSync(path.join(mr, 'src', 'billing'), { recursive: true }); fs.mkdirSync(path.join(mr, 'src', 'ordering'), { recursive: true });
  fs.writeFileSync(path.join(mr, 'GLOSSARY-MAP.md'), '# Map\n\n- [Ordering](./src/ordering/GLOSSARY.md): orders\n- [Billing](./src/billing/GLOSSARY.md): invoices\n');
  fs.writeFileSync(path.join(mr, 'src', 'billing', 'GLOSSARY.md'), '**Invoice**:\nA bill request.\n_Avoid_: bill\n');
  fs.writeFileSync(path.join(mr, 'src', 'ordering', 'GLOSSARY.md'), '**Order**:\nA request.\n_Avoid_: purchase\n');
  assert.deepEqual(findGlossaries(path.join(mr, 'src', 'billing')), [path.join(mr, 'src', 'billing', 'GLOSSARY.md')], 'the context that holds the folder');
  assert.equal(findGlossaries(mr).length, 2, 'from the root every listed context is a candidate');
  assert.deepEqual(findGlossaries(mk('nowhere', 'a', 'b').replace(/\/b$/, '')), []);
});

test('glossaryFor and styleBlock build the prompt text', () => {
  const root = mk('repo3', 'x'); const r = path.dirname(root);
  fs.mkdirSync(path.join(r, '.git')); fs.writeFileSync(path.join(r, 'GLOSSARY.md'), SAMPLE);
  const terms = glossaryFor(r, 'we changed how an order is paid');
  assert.match(terms, /^- Order:/m);
  assert.doesNotMatch(terms, /Parcel/);
  const style = styleBlock(terms);
  assert.match(style, /ASD-STE100/);
  assert.match(style, /ONE line of context/);
  assert.match(style, /Never use the words after "Avoid"/);
  assert.match(style, /- Order:/);
  assert.match(styleBlock(''), /No project glossary was found/);
});
