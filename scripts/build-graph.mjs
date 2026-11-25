// Turns data/pages.json into public/graph.json (nodes + links). Run: npm run graph
import fs from 'node:fs/promises';
import { groupOf } from './lib.mjs';

const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
let pages;
try {
  pages = JSON.parse(await fs.readFile('data/pages.json', 'utf8'));
} catch {
  console.error('✗ data/pages.json not found. Run: npm run sync');
  process.exit(1);
}

const byId = new Map(pages.map((p) => [p.id, p]));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build a regex for a term. A trailing * means "prefix" (e.g. transparen*).
function termRegex(term) {
  const prefix = term.endsWith('*');
  const core = esc(term.replace(/\*$/, '').toLowerCase());
  return new RegExp(`(^|[^a-z0-9])${core}${prefix ? '' : '($|[^a-z0-9])'}`, 'g');
}
const countHits = (text, term) => (text.match(termRegex(term)) || []).length;

// Databases and empty container pages are structural scaffolding: hide them and
// connect their children straight to the nearest visible ancestor.
const hidden = new Set(
  pages.filter((p) => p.object === 'database' || (!(p.title || '').trim() && !(p.text || '').trim()) || /template/i.test(p.title || '')).map((p) => p.id)
);
function visibleParent(p) {
  let cur = p.parentId ? byId.get(p.parentId) : null;
  const guard = new Set();
  while (cur && hidden.has(cur.id) && !guard.has(cur.id)) {
    guard.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return cur && !hidden.has(cur.id) ? cur.id : null;
}

const nodes = pages.filter((p) => !hidden.has(p.id)).map((p) => ({
  id: p.id,
  title: p.title || (p.object === 'database' ? 'Database' : 'Untitled'),
  kind: p.object === 'database' ? 'database' : typeof p.props?.type === 'string' ? p.props.type.toLowerCase() : 'page',
  group: groupOf(p, byId, cfg),
  url: p.url,
  date: p.date || null,
  snippet: (p.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  _text: (p.text || '').toLowerCase(),
}));
const nodeById = new Map(nodes.map((n) => [n.id, n]));

const links = [];
const seen = new Set();
function addLink(a, b, kind) {
  if (!a || !b || a === b) return;
  const key = kind === 'parent' ? `${a}>${b}` : [a, b].sort().join('~') + kind;
  if (seen.has(key)) return;
  seen.add(key);
  links.push({ source: a, target: b, kind });
}

// 1. Structure: parent -> child
for (const p of pages) {
  if (hidden.has(p.id)) continue;
  const parent = visibleParent(p);
  if (parent && nodeById.has(parent)) addLink(parent, p.id, 'parent');
}

// 2. Explicit @mentions and links between pages in Notion
for (const p of pages) for (const t of p.mentions || []) if (nodeById.has(t)) addLink(p.id, t, 'mention');

// 3. Notes that name a reading, e.g. "compare with Sutcliffe & Court"
const aliasList = [];
for (const n of nodes) {
  const aliases = new Set();
  if (n.kind === 'reading') {
    const base = n.title.split(/[(:,]/)[0].trim();
    if (base.length >= 5) aliases.add(base);
  }
  for (const [key, extra] of Object.entries(cfg.aliases || {})) {
    if (n.title.toLowerCase().includes(key.toLowerCase())) extra.forEach((a) => aliases.add(a));
  }
  const rx = [...aliases].filter((a) => a.length >= 5).map((a) => termRegex(a));
  if (rx.length) aliasList.push({ id: n.id, rx });
}
for (const n of nodes) {
  if (!n._text) continue;
  for (const { id, rx } of aliasList) {
    if (id === n.id) continue;
    if (rx.some((r) => ((r.lastIndex = 0), r.test(n._text)))) addLink(n.id, id, 'reference');
  }
}

// 4. Same week: readings/seminars share a date with their lecture
const byWeek = new Map();
for (const n of nodes) {
  if (!n.date || !['lecture', 'seminar', 'reading'].includes(n.kind)) continue;
  const key = `${n.group}|${n.date}`;
  if (!byWeek.has(key)) byWeek.set(key, []);
  byWeek.get(key).push(n);
}
for (const items of byWeek.values()) {
  const hubs = items.filter((n) => n.kind === 'lecture');
  const anchors = hubs.length ? hubs : items.filter((n) => n.kind === 'seminar');
  for (const n of items) for (const h of anchors) addLink(h.id, n.id, 'week');
}

// 5. Shared concepts (see "concepts" in config.json)
const minHits = cfg.minConceptHits ?? 2;
for (const c of cfg.concepts || []) {
  const hits = nodes.filter(
    (n) => n.kind !== 'database' && n._text && c.terms.reduce((s, t) => s + countHits(n._text, t), 0) >= minHits
  );
  if (hits.length < 2) continue;
  const cid = `concept:${c.name}`;
  nodes.push({ id: cid, title: c.name, kind: 'concept', group: 'Concepts', url: null, date: null, snippet: `Appears in ${hits.length} notes`, _text: '' });
  for (const h of hits) addLink(cid, h.id, 'concept');
}

const degree = new Map();
for (const l of links) {
  degree.set(l.source, (degree.get(l.source) || 0) + 1);
  degree.set(l.target, (degree.get(l.target) || 0) + 1);
}
const out = {
  generated: new Date().toISOString(),
  nodes: nodes.map(({ _text, ...n }) => ({ ...n, degree: degree.get(n.id) || 0 })),
  links,
};
await fs.mkdir('public', { recursive: true });
await fs.writeFile('public/graph.json', JSON.stringify(out));

const kinds = {};
links.forEach((l) => (kinds[l.kind] = (kinds[l.kind] || 0) + 1));
console.log(`✓ ${out.nodes.length} nodes, ${links.length} links →`, kinds);
console.log('  Now run: npm run dev');
