import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import Intro from './Intro.jsx';

const PALETTE = ['#5eead4', '#a78bfa', '#fbbf24', '#f472b6', '#4ade80', '#fb923c', '#60a5fa', '#f87171', '#22d3ee', '#c084fc'];
const CONCEPT_COLOR = '#e5e7eb';
const idOf = (v) => (v && typeof v === 'object' ? v.id : v);

// Sample points that lie on the brain picture so the graph can take its shape.
async function sampleBrain(count) {
  const img = new Image();
  img.src = '/reference/brain-neurons.jpg';
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pool = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const bright = r + g + b;
      const nearWhite = r > 225 && g > 225 && b > 225; // skip the white label boxes
      if (bright > 180 && !nearWhite) pool.push([x - width / 2, y - height / 2]);
    }
  }
  if (!pool.length) return [];
  const picked = [];
  for (let i = 0; i < count; i++) picked.push(pool[Math.floor(Math.random() * pool.length)]);
  picked.sort((a, b) => a[0] - b[0]);
  const scale = 0.62;
  return picked.map(([x, y]) => ({ x: x * scale, y: y * scale }));
}

export default function App() {
  const fgRef = useRef(null);
  const [raw, setRaw] = useState(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [brain, setBrain] = useState(true);
  const [query, setQuery] = useState('');
  const [mono, setMono] = useState(false);
  const [spin, setSpin] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const stageRef = useRef(null);

  useEffect(() => {
    document.body.classList.toggle('intro-on', !introDone);
  }, [introDone]);

  useEffect(() => {
    fetch('/graph.json')
      .then((r) => {
        if (!r.ok) throw new Error('missing');
        return r.json();
      })
      .then(setRaw)
      .catch(() => setFailed(true));
  }, []);

  const groups = useMemo(() => {
    if (!raw) return [];
    const counts = new Map();
    raw.nodes.forEach((n) => counts.set(n.group, (counts.get(n.group) || 0) + 1));
    return [...counts.entries()].sort((a, b) => (a[0] === 'Concepts') - (b[0] === 'Concepts') || b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }, [raw]);

  const colorOf = useMemo(() => {
    const map = new Map();
    let i = 0;
    groups.forEach((g) => map.set(g.name, g.name === 'Concepts' ? CONCEPT_COLOR : PALETTE[i++ % PALETTE.length]));
    return (group) => map.get(group) || '#9ca3af';
  }, [groups]);

  const graphData = useMemo(() => {
    if (!raw) return { nodes: [], links: [] };
    return {
      nodes: raw.nodes.map((n) => ({ ...n })),
      links: raw.links.map((l, i) => ({ ...l, pulse: l.kind !== 'parent' && i % 4 === 0 })),
    };
  }, [raw]);

  const nodeById = useMemo(() => new Map(graphData.nodes.map((n) => [n.id, n])), [graphData]);
  const neighbours = useMemo(() => {
    const m = new Map(graphData.nodes.map((n) => [n.id, new Set()]));
    graphData.links.forEach((l) => {
      m.get(idOf(l.source))?.add(idOf(l.target));
      m.get(idOf(l.target))?.add(idOf(l.source));
    });
    return m;
  }, [graphData]);

  const radius = (n) => (n.kind === 'concept' ? 5 + Math.sqrt(n.degree) * 1.6 : 2.2 + Math.sqrt(n.degree) * 1.25);

  // Brain mode: pull every node toward a point on the brain picture.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graphData.nodes.length) return;
    const charge = fg.d3Force('charge');
    if (!brain) {
      fg.d3Force('brain', null);
      charge?.strength(-30);
      fg.d3ReheatSimulation();
      return;
    }
    let cancelled = false;
    sampleBrain(graphData.nodes.length)
      .then((pts) => {
        if (cancelled || !pts.length) return;
        const order = groups.map((g) => g.name);
        const nodes = [...graphData.nodes].sort(
          (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || Math.random() - 0.5
        );
        nodes.forEach((n, i) => {
          n.tx = pts[i].x;
          n.ty = pts[i].y;
        });
        const pull = (alpha) => {
          for (const n of graphData.nodes) {
            if (n.tx === undefined || n.x === undefined) continue;
            n.vx += (n.tx - n.x) * 0.2 * alpha;
            n.vy += (n.ty - n.y) * 0.2 * alpha;
          }
        };
        charge?.strength(-6);
        fg.d3Force('brain', pull);
        fg.d3ReheatSimulation();
        setTimeout(() => fg.zoomToFit(900, 70), 2500);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [brain, graphData, groups]);

  // Spin: slowly rotate the whole brain around its centre (pauses on hover / while a note is open).
  const pauseSpin = useRef(false);
  pauseSpin.current = !!hover || !!selected;
  useEffect(() => {
    if (!spin) return;
    let raf;
    const step = () => {
      if (!pauseSpin.current) {
        const a = 0.0035, c = Math.cos(a), sn = Math.sin(a);
        for (const n of graphData.nodes) {
          if (!Number.isFinite(n.x) || n.fx !== undefined) continue;
          const x = n.x, y = n.y;
          n.x = x * c - y * sn;
          n.y = x * sn + y * c;
          if (n.tx !== undefined) {
            const tx = n.tx, ty = n.ty;
            n.tx = tx * c - ty * sn;
            n.ty = tx * sn + ty * c;
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [spin, graphData]);

  const focusNode = useCallback(
    (id) => {
      const n = nodeById.get(id);
      if (!n) return;
      setSelected(n);
      const fg = fgRef.current;
      if (fg && n.x !== undefined) {
        fg.centerAt(n.x, n.y, 700);
        fg.zoom(3, 700);
      }
    },
    [nodeById]
  );

  const toggleGroup = (name) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const drawNode = useCallback(
    (node, ctx, scale) => {
      if (hidden.has(node.group) || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      const r = radius(node);
      const color = mono ? '#ffffff' : colorOf(node.group);
      const near = hover ? neighbours.get(hover)?.has(node.id) : false;
      const state = !hover ? 'normal' : node.id === hover ? 'hot' : near ? 'near' : 'dim';
      const alpha = state === 'dim' ? 0.12 : 1;
      const glow = state === 'hot' ? 6 : state === 'near' ? 4.5 : 3.6;

      ctx.globalAlpha = alpha;
      const g = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r * glow);
      g.addColorStop(0, color + 'cc');
      g.addColorStop(0.25, color + '55');
      g.addColorStop(1, color + '00');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * glow, 0, 2 * Math.PI);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(node.x, node.y, Math.max(r * 0.55, 1), 0, 2 * Math.PI);
      ctx.fill();

      if (selected && selected.id === node.id) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2 / scale;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 1.9, 0, 2 * Math.PI);
        ctx.stroke();
      }

      const showLabel = state === 'hot' || state === 'near' || (selected && selected.id === node.id) || scale > 2.4 || (scale > 1.1 && node.degree >= 9);
      if (showLabel && state !== 'dim') {
        const size = Math.max(10 / scale, 2.5);
        ctx.font = `${size}px ui-sans-serif, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(232,234,242,0.95)';
        const label = node.title.length > 46 ? node.title.slice(0, 44) + '…' : node.title;
        ctx.fillText(label, node.x, node.y + r + 2 / scale);
      }
      ctx.globalAlpha = 1;
    },
    [hover, hidden, neighbours, selected, colorOf, mono]
  );

  const paintPointer = useCallback(
    (node, color, ctx) => {
      if (hidden.has(node.group) || !Number.isFinite(node.x)) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius(node) + 3, 0, 2 * Math.PI);
      ctx.fill();
    },
    [hidden]
  );

  const linkColor = useCallback(
    (l) => {
      const s = idOf(l.source), t = idOf(l.target);
      const sg = nodeById.get(s)?.group, tg = nodeById.get(t)?.group;
      if (hidden.has(sg) || hidden.has(tg)) return 'rgba(0,0,0,0)';
      if (hover) return s === hover || t === hover ? 'rgba(255,255,255,0.8)' : 'rgba(150,160,200,0.03)';
      if (l.kind === 'parent') return 'rgba(150,165,210,0.12)';
      if (l.kind === 'concept') return 'rgba(229,231,235,0.14)';
      return 'rgba(170,190,255,0.26)';
    },
    [hover, hidden, nodeById]
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? graphData.nodes.filter((n) => n.title.toLowerCase().includes(q)) : [];
  }, [query, graphData]);

  if (failed) {
    return (
      <div className="empty">
        <div>
          <h2 style={{ color: '#e8eaf2' }}>No graph data yet</h2>
          <p>
            In the terminal run <code>npm run build-data</code>, then refresh this page.
          </p>
        </div>
      </div>
    );
  }
  if (!raw) return <div className="empty">Loading…</div>;

  const connections = selected ? [...(neighbours.get(selected.id) || [])].map((id) => nodeById.get(id)).filter(Boolean) : [];

  return (
    <>
      <div ref={stageRef} className="stage" style={introDone ? undefined : { opacity: 0 }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        backgroundColor="#04050a"
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={paintPointer}
        nodeLabel={() => ''}
        linkColor={linkColor}
        linkWidth={(l) => (hover && (idOf(l.source) === hover || idOf(l.target) === hover) ? 1.4 : 0.5)}
        linkDirectionalParticles={(l) => (l.pulse || (hover && (idOf(l.source) === hover || idOf(l.target) === hover)) ? 2 : 0)}
        linkDirectionalParticleWidth={1.8}
        linkDirectionalParticleSpeed={0.004}
        linkDirectionalParticleColor={() => '#ffffff'}
        onNodeHover={(n) => setHover(n ? n.id : null)}
        onNodeClick={(n) => focusNode(n.id)}
        onBackgroundClick={() => setSelected(null)}
        cooldownTime={12000}
        d3VelocityDecay={0.3}
      />
      </div>
      {!introDone && (
        <Intro
          stageRef={stageRef}
          onStart={() => fgRef.current?.zoomToFit(0, 70)}
          onDone={() => {
            if (stageRef.current) stageRef.current.style.transform = '';
            setIntroDone(true);
          }}
        />
      )}

      <div className="panel topbar">
        <input
          placeholder="Search notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && matches[0] && focusNode(matches[0].id)}
        />
        <button className={`btn ${brain ? 'on' : ''}`} onClick={() => setBrain((b) => !b)}>
          Brain shape
        </button>
        <button className={`btn ${mono ? 'on' : ''}`} onClick={() => setMono((m) => !m)}>
          Theme: {mono ? 'Mono' : 'Colour'}
        </button>
        <button className={`btn ${spin ? 'on' : ''}`} onClick={() => setSpin((v) => !v)}>
          Spin
        </button>
        <button className="btn" onClick={() => fgRef.current?.zoomToFit(700, 70)}>
          Fit
        </button>
        <span className="stats">
          {raw.nodes.length} notes · {raw.links.length} links
        </span>
      </div>

      <div className="panel legend">
        <h4>Modules</h4>
        {groups.map((g) => (
          <button key={g.name} className={hidden.has(g.name) ? 'off' : ''} onClick={() => toggleGroup(g.name)}>
            <span className="dot" style={{ background: mono ? '#fff' : colorOf(g.name), boxShadow: `0 0 8px ${mono ? '#fff' : colorOf(g.name)}` }} />
            <span style={{ flex: 1 }}>{g.name}</span>
            <span style={{ color: '#8b90a3' }}>{g.count}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="panel detail">
          <button className="close" onClick={() => setSelected(null)} aria-label="Close">
            ×
          </button>
          <h3>{selected.title}</h3>
          <div className="meta">
            {selected.kind}
            {selected.date ? ` · ${selected.date}` : ''} · {selected.group}
          </div>
          {selected.snippet && <p>{selected.snippet}…</p>}
          {selected.url && (
            <a className="btn" href={selected.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', display: 'inline-block' }}>
              Open in Notion ↗
            </a>
          )}
          <h5>Connected to {connections.length}</h5>
          {connections.slice(0, 40).map((c) => (
            <button key={c.id} className="conn" onClick={() => focusNode(c.id)}>
              {c.title.length > 48 ? c.title.slice(0, 46) + '…' : c.title}
              <small>{c.kind}</small>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
