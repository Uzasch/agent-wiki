// Session page names: sessions/YYYY-MM-DD-<short>-<id8>.md
// <short> = 2-5 word kebab slug from the summariser (@@SHORT@@), or derived from the title.
// <id8> = first 8 characters of the session id: it keeps the name unique and findable.

// Words that carry no meaning in a file name.
const FILLER = new Set(('a an the and or of to for in on at by with from into onto as is are was were be been being it its this that '
  + 'these those then than so but not no do does did done make makes made get gets got set sets run runs ran use uses used '
  + 'new old my our your their his her we you they i me us up out off over under about after before between through '
  + 'how what why when where which who whom also just only again still very more most some any all each every other '
  + 'including include includes using via per vs can could should would will may might must have has had '
  + 'session work task stuff thing things').split(/\s+/));

// Verbs that start many titles ("Design and build ...", "Stop the ..."): they say nothing in a file name.
const LEAD_VERB = new Set(('design designed build built ship shipped stop resolve resolved merge merged add added fix fixed rebuild rebuilt '
  + 'research researched hand handed run ran compile compiled grill grilled write wrote create created update updated check checked '
  + 'make made set find found remove removed delete deleted move moved plan planned review reviewed investigate investigated '
  + 'implement implemented improve improved carry draft drafted finish finished continue continued test tested').split(/\s+/));

const words = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

const MAX_LEN = 40;

// Join words into a slug of at most 5 words and MAX_LEN characters.
const join = (ws, max = 5) => {
  const out = [];
  for (const w of ws.slice(0, max)) {
    if ([...out, w].join('-').length > MAX_LEN) break;
    out.push(w);
  }
  return out.join('-');
};

// A short slug from a title, no model: drop filler words, keep the first 5 words.
export function shortFromTitle(title) {
  // Drop bracketed asides and everything after the first clause break.
  const head = String(title || '').replace(/\([^)]*\)/g, ' ').split(/\s+[—–]\s+|:\s|;\s|,\s+(?:then|and then|so|but)\s+|\s+then\s+/i)[0];
  const ws = words(head).filter((w) => w.length > 1);
  const kept = ws.filter((w) => !FILLER.has(w));
  while (kept.length > 2 && LEAD_VERB.has(kept[0])) kept.shift();
  return join(kept.length ? kept : ws) || 'session';
}

// Accept the model's @@SHORT@@ if it is a usable slug; otherwise derive one from the title.
export function cleanShort(raw, title) {
  const first = String(raw || '').split('\n')[0].replace(/^["'`@\s]+|["'`\s]+$/g, '');
  const ws = words(first);
  if (ws.length >= 1 && ws.length <= 8 && ws.join('-').length <= 60) return join(ws);
  return shortFromTitle(title);
}

export const idPart = (id) => String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();

export const sessionFileName = (date, short, id) => `${date}-${short}-${idPart(id)}.md`;

// Old names: YYYY-MM-DD-<tool>-<id8>.md (the tool word instead of a short title).
export const OLD_NAME = /^(\d{4}-\d{2}-\d{2})-(claude|codex|agy|opencode|omp)-([0-9a-z]{8})\.md$/;
