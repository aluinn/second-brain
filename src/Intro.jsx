import { useEffect, useRef } from 'react';

// Opening sequence: a brain made of glowing neurons (sampled from the reference picture),
// then the camera dives into it and dissolves into the real graph.
// Same look as the graph: #04050a, soft glowing dots with white cores, thin translucent links.

const DURATION = 6000;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function rng(seed) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
const hex = (n) => n.toString(16).padStart(2, '0');

// Neurons = coloured dots taken from the brain picture; each links to its nearest neighbours.
async function loadBrain() {
  const img = new Image();
  img.src = '/reference/brain-neurons.jpg';
  await img.decode();
  const W = img.naturalWidth, Hh = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = Hh;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const { data } = cx.getImageData(0, 0, W, Hh);
  const pool = [];
  for (let y = 0; y < Hh; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r + g + b < 200) continue;
      if (r > 200 && g > 200 && b > 200) continue; // label boxes
      pool.push([x, y, r, g, b]);
    }
  }
  const rand = rng(11);
  const N = 1300;
  const nodes = [];
  for (let i = 0; i < N && pool.length; i++) {
    const p = pool[Math.floor(rand() * pool.length)];
    const m = (p[2] + p[3] + p[4]) / 3;
    const q = (v) => Math.max(0, Math.min(255, Math.round((m + (v - m) * 1.6) / 32) * 32)); // more saturated
    nodes.push({ x: p[0] / W - 0.5, y: p[1] / Hh - 0.5, color: '#' + hex(q(p[2])) + hex(q(p[3])) + hex(q(p[4])), r: 1.6 + rand() * 1.8 });
  }
  // nearest-neighbour links via a coarse grid
  const cell = 0.04, grid = new Map();
  nodes.forEach((n, i) => {
    const k = Math.floor(n.x / cell) + ',' + Math.floor(n.y / cell);
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  });
  const edges = [];
  const seen = new Set();
  nodes.forEach((n, i) => {
    const gx = Math.floor(n.x / cell), gy = Math.floor(n.y / cell);
    const near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(gx + dx + ',' + (gy + dy)) || []) {
        if (j !== i) near.push([Math.hypot(nodes[j].x - n.x, nodes[j].y - n.y), j]);
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [d, j] of near.slice(0, 5)) {
      if (d > 0.075) continue;
      const key = i < j ? i + '-' + j : j + '-' + i;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([i, j]);
      }
    }
  });
  return { nodes, edges };
}

const spriteCache = new Map();
function sprite(color) {
  if (spriteCache.has(color)) return spriteCache.get(color);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, color + 'cc');
  g.addColorStop(0.25, color + '55');
  g.addColorStop(1, color + '00');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  spriteCache.set(color, c);
  return c;
}

export default function Intro({ stageRef, onStart, onDone }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const st = { phase: 'loading', t0: 0, raf: 0, dead: false, brain: null };
    const rand = rng(21);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener('resize', resize);

    loadBrain()
      .then((b) => {
        st.brain = b;
        st.particles = Array.from({ length: 170 }, () => ({ e: Math.floor(rand() * b.edges.length), off: rand(), speed: 0.0002 + rand() * 0.0004 }));
        if (st.phase === 'loading') st.phase = 'ready';
      })
      .catch(() => onDone()); // no picture -> go straight to the graph

    const finish = () => {
      if (st.dead) return;
      st.dead = true;
      cancelAnimationFrame(st.raf);
      onDone();
    };
    const begin = () => {
      if (st.phase !== 'ready') return;
      st.phase = 'playing';
      st.t0 = performance.now();
      onStart();
    };
    const onKey = (ev) => {
      if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
      if (ev.key === 'Enter') (st.phase === 'ready' ? begin : st.phase === 'playing' ? finish : () => {})();
      else if (ev.key === 'Escape' && st.phase === 'playing') finish();
    };
    addEventListener('keydown', onKey);

    const draw = (now) => {
      if (st.dead) return;
      const vw = innerWidth, vh = innerHeight;
      ctx.clearRect(0, 0, vw, vh);
      st.raf = requestAnimationFrame(draw);
      if (!st.brain) return;
      const { nodes, edges } = st.brain;

      const size = 0.9 * Math.min(vh, vw * 0.95); // on-screen size of the brain picture
      const C = { x: vw / 2, y: vh / 2 };
      const H = { x: C.x + 0.0 * size, y: C.y + 0.05 * size }; // dive target (inside the sulcus)
      const zEnd = 5;

      let e = 0;
      if (st.phase === 'playing') {
        const t = Math.min(1, (now - st.t0) / DURATION);
        e = ease(t);
        if (t >= 1) return finish();
      }
      const z = Math.exp(Math.log(zEnd) * e);
      const P = { x: H.x + (C.x - H.x) * e, y: H.y + (C.y - H.y) * e };
      // gentle breathing while waiting
      const breathe = st.phase === 'ready' ? 1 + 0.006 * Math.sin(now / 900) : 1;

      const stage = stageRef.current;
      if (stage && st.phase === 'playing') {
        stage.style.transform = `translate(${P.x - C.x}px, ${P.y - C.y}px) scale(${z / zEnd})`;
        stage.style.opacity = String(smooth(0.6, 0.94, e));
      }
      const brainA = 1 - smooth(0.78, 0.98, e);
      const sx = (n) => P.x + (C.x + n.x * size * breathe - H.x) * z;
      const sy = (n) => P.y + (C.y + n.y * size * breathe - H.y) * z;
      const pts = nodes.map((n) => [sx(n), sy(n)]);
      const on = (p) => p[0] > -80 && p[0] < vw + 80 && p[1] > -80 && p[1] < vh + 80;

      // links
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(170,190,255,${brainA * (0.42 + 0.25 * smooth(0, 0.7, e))})`;
      ctx.beginPath();
      for (const [i, j] of edges) {
        if (!on(pts[i]) && !on(pts[j])) continue;
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[j][0], pts[j][1]);
      }
      ctx.stroke();

      // glowing neurons
      const k = size / 1080;
      nodes.forEach((n, i) => {
        if (!on(pts[i])) return;
        const a = brainA * (0.75 + 0.25 * Math.sin(now * 0.002 + i));
        const r = n.r * 1.5 * (0.6 + k) * Math.pow(z, 0.78);
        ctx.globalAlpha = a;
        const s = r * 3.6 * 2;
        ctx.drawImage(sprite(n.color), pts[i][0] - s / 2, pts[i][1] - s / 2, s, s);
        ctx.globalAlpha = a;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(pts[i][0], pts[i][1], Math.max(r * 0.5, 0.7), 0, Math.PI * 2);
        ctx.fill();
      });

      // slow white pulses firing along links
      ctx.fillStyle = '#ffffff';
      for (const p of st.particles) {
        const [i, j] = edges[p.e];
        const t = (p.off + now * p.speed) % 1;
        const x = pts[i][0] + (pts[j][0] - pts[i][0]) * t;
        const y = pts[i][1] + (pts[j][1] - pts[i][1]) * t;
        if (!on([x, y])) continue;
        ctx.globalAlpha = brainA * 0.9;
        ctx.beginPath();
        ctx.arc(x, y, 1.5 * Math.pow(z, 0.4), 0, Math.PI * 2);
        ctx.fill();
      }

      // hint
      const hintA = st.phase === 'ready' ? 0.4 + 0.35 * Math.sin(now / 650) : Math.max(0, 1 - (now - st.t0) / 400) * 0.6;
      if (hintA > 0.01 && st.phase !== 'loading') {
        ctx.globalAlpha = hintA;
        ctx.fillStyle = '#8b90a3';
        ctx.font = '12px ui-sans-serif, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
        ctx.fillText('PRESS ENTER', vw / 2, vh * 0.95);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      }
      ctx.globalAlpha = 1;
    };
    st.raf = requestAnimationFrame(draw);

    return () => {
      st.dead = true;
      cancelAnimationFrame(st.raf);
      removeEventListener('resize', resize);
      removeEventListener('keydown', onKey);
    };
  }, []);

  return <canvas ref={canvasRef} className="intro" />;
}
