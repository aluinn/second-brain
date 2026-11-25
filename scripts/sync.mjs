// Pulls your Notion pages (everything the integration can see under the root
// page in config.json) into data/pages.json. Run with: npm run sync
import fs from 'node:fs/promises';
import { chainOf, findRoot, isExcluded } from './lib.mjs';

const TOKEN = process.env.NOTION_TOKEN?.trim();
if (!TOKEN) {
  console.error('✗ NOTION_TOKEN is empty. Paste your token after NOTION_TOKEN= in .env and save the file.');
  process.exit(1);
}

const API = 'https://api.notion.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function notion(path, body, attempt = 0) {
  const wait = Math.max(0, 340 - (Date.now() - lastCall)); // stay under ~3 requests/second
  if (wait) await sleep(wait);
  lastCall = Date.now();
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    const retry = Number(res.headers.get('retry-after')) || 2;
    await sleep(retry * 1000 * (attempt + 1));
    return notion(path, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

const nid = (s) => (s || '').replace(/-/g, '').toLowerCase();
const richText = (arr) => (arr || []).map((x) => x.plain_text || '').join('');

function titleOf(o) {
  if (o.object === 'database') return richText(o.title);
  for (const p of Object.values(o.properties || {})) if (p.type === 'title') return richText(p.title);
  return '';
}

function propsOf(page) {
  const out = {};
  for (const [k, p] of Object.entries(page.properties || {})) {
    if (p.type === 'select' && p.select) out[k] = p.select.name;
    else if (p.type === 'multi_select' && p.multi_select.length) out[k] = p.multi_select.map((o) => o.name);
    else if (p.type === 'status' && p.status) out[k] = p.status.name;
    else if (p.type === 'date' && p.date) {
      out[k] = p.date.start;
      if (!out.__date) out.__date = p.date.start;
    }
  }
  return out;
}

const blockParentCache = new Map();
async function resolveParent(parent, depth = 0) {
  if (!parent) return null;
  if (parent.type === 'page_id') return nid(parent.page_id);
  if (parent.type === 'database_id') return nid(parent.database_id);
  if (parent.type === 'block_id') {
    const id = nid(parent.block_id);
    if (blockParentCache.has(id)) return blockParentCache.get(id);
    let result = null;
    if (depth < 8) {
      try {
        const block = await notion(`/blocks/${parent.block_id}`);
        result = await resolveParent(block.parent, depth + 1);
      } catch {
        result = null;
      }
    }
    blockParentCache.set(id, result);
    return result;
  }
  return null; // workspace level
}

async function searchAll() {
  const all = [];
  let cursor;
  do {
    const r = await notion('/search', { page_size: 100, start_cursor: cursor });
    all.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
    process.stdout.write(`\r  search: ${all.length} objects`);
  } while (cursor);
  console.log();
  return all;
}

async function pageContent(pageId) {
  const texts = [];
  const mentions = new Set();

  function collect(b) {
    if (b.type === 'child_page' || b.type === 'child_database') return;
    const body = b[b.type] || {};
    if (b.type === 'link_to_page') {
      const target = body.page_id || body.database_id;
      if (target) mentions.add(nid(target));
      return;
    }
    const rts = b.type === 'table_row' ? (body.cells || []).flat() : body.rich_text || [];
    const line = rts.map((x) => x.plain_text || '').join('');
    if (line) texts.push(line);
    for (const x of rts) {
      if (x.type === 'mention' && x.mention) {
        if (x.mention.type === 'page') mentions.add(nid(x.mention.page.id));
        if (x.mention.type === 'database') mentions.add(nid(x.mention.database.id));
      }
      const href = x.href || x.text?.link?.url;
      if (href && /notion\.(so|com|site)/.test(href)) {
        const m = href.replace(/-/g, '').match(/[0-9a-f]{32}/i);
        if (m) mentions.add(m[0].toLowerCase());
      }
    }
  }

  async function walk(blockId, depth) {
    let cursor;
    do {
      const q = `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
      const r = await notion(q);
      for (const b of r.results) {
        collect(b);
        if (b.has_children && depth < 3 && b.type !== 'child_page' && b.type !== 'child_database') {
          await walk(b.id, depth + 1);
        }
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
  }

  await walk(pageId, 0);
  return { text: texts.join('\n').slice(0, 30000), mentions: [...mentions] };
}

async function main() {
  const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
  await fs.mkdir('data', { recursive: true });
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile('data/cache.json', 'utf8'));
  } catch {}

  console.log('1/4 Searching Notion for everything shared with the integration…');
  const found = await searchAll();
  if (found.length === 0) {
    console.error(
      '✗ Nothing found. Open your Second Year page in Notion → ••• menu → Connections → add your integration, then run again.'
    );
    process.exit(1);
  }

  const objs = new Map();
  const toObj = async (o) => ({
    id: nid(o.id),
    object: o.object,
    title: titleOf(o).trim(),
    url: o.url,
    created: o.created_time,
    edited: o.last_edited_time,
    archived: !!(o.archived || o.in_trash),
    props: o.object === 'page' ? propsOf(o) : {},
    parentId: await resolveParent(o.parent),
  });

  console.log('2/4 Working out how pages nest…');
  let i = 0;
  for (const o of found) {
    const obj = await toObj(o);
    if (!obj.archived) objs.set(obj.id, obj);
    process.stdout.write(`\r  ${++i}/${found.length}`);
  }
  console.log();

  // Make sure every row of every database is present (search can miss some).
  for (const db of [...objs.values()].filter((o) => o.object === 'database')) {
    let cursor;
    try {
      do {
        const r = await notion(`/databases/${db.id}/query`, { page_size: 100, start_cursor: cursor });
        for (const row of r.results) {
          if (!objs.has(nid(row.id)) && !(row.archived || row.in_trash)) {
            objs.set(nid(row.id), await toObj(row));
          }
        }
        cursor = r.has_more ? r.next_cursor : undefined;
      } while (cursor);
    } catch (e) {
      console.warn(`  (skipped database ${db.id}: ${e.message.slice(0, 80)})`);
    }
  }

  // Keep only what sits under the root page and is not excluded.
  const hasRoot = [...objs.values()].some((o) => findRoot(chainOf(o, objs), cfg) >= 0);
  if (!hasRoot) console.warn(`  ! Couldn't find a page titled "${cfg.rootTitle}" – keeping everything.`);
  const keep = [...objs.values()].filter((o) => {
    if (isExcluded(o, objs, cfg)) return false;
    if (!hasRoot) return true;
    return findRoot(chainOf(o, objs), cfg) >= 0;
  });
  console.log(`3/4 Reading the text of ${keep.filter((o) => o.object === 'page').length} pages…`);

  const out = [];
  let n = 0;
  for (const o of keep) {
    if (o.object === 'page') {
      const cached = cache[o.id];
      let content;
      if (cached && cached.edited === o.edited) {
        content = { text: cached.text, mentions: cached.mentions };
      } else {
        try {
          content = await pageContent(o.id);
        } catch (e) {
          console.warn(`\n  (couldn't read "${o.title}": ${e.message.slice(0, 80)})`);
          content = { text: '', mentions: [] };
        }
        cache[o.id] = { edited: o.edited, ...content };
      }
      out.push({ ...o, date: o.props.__date || null, ...content });
      process.stdout.write(`\r  ${++n}`);
    } else {
      out.push({ ...o, date: null, text: '', mentions: [] });
    }
  }
  console.log();

  console.log('4/4 Saving…');
  await fs.writeFile('data/pages.json', JSON.stringify(out, null, 2));
  await fs.writeFile('data/cache.json', JSON.stringify(cache));
  console.log(`✓ Saved ${out.length} items to data/pages.json. Now run: npm run graph`);
}

main().catch((e) => {
  console.error('\n✗ Sync failed:', e.message);
  process.exit(1);
});
