// Shared helpers for the sync and graph scripts.

export function chainOf(obj, byId) {
  const chain = [];
  const seen = new Set();
  let cur = obj;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain;
}

const norm = (s) => (s || '').trim().toLowerCase();

export function findRoot(chain, cfg) {
  return chain.findIndex((a) => norm(a.title) === norm(cfg.rootTitle));
}

export function isExcluded(obj, byId, cfg) {
  const ex = (cfg.excludeTitles || []).map(norm);
  return chainOf(obj, byId).some((a) => {
    const t = norm(a.title);
    return t && ex.some((e) => t.startsWith(e));
  });
}

// "Group" = the module a note belongs to (the page directly under the first
// database below the root page), so nodes can be coloured per module.
export function groupOf(obj, byId, cfg) {
  const chain = chainOf(obj, byId);
  const idx = findRoot(chain, cfg);
  if (idx < 0) return chain[0]?.title?.trim() || 'Other';
  const sub = chain.slice(idx + 1);
  const dbIdx = sub.findIndex((a) => a.object === 'database');
  if (dbIdx >= 0) {
    const next = sub[dbIdx + 1];
    return next ? (next.title || 'Other').trim() : cfg.rootTitle;
  }
  return sub[0]?.title?.trim() || cfg.rootTitle;
}
