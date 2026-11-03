// Isometric kernel for the landing figures, ported from iso-glow (MIT, April Zhu),
// which builds on iso-figure (MIT, Tolga Cohce). Licence: LICENSES/iso-glow-MIT.txt.
//
// +x runs down-right, +y down-left, +z up. A box is its three visible faces, and
// paint order is the only depth sort: draw back to front (smaller x+y first,
// lower z first). Figures render to SVG strings at build time; colour comes
// only from the classes in landing.css, never from attributes.

export type Point = [number, number, number];

const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);
const n = (v: number) => Number(v.toFixed(2));

export function kernel(ox: number, oy: number) {
  const P = (x: number, y: number, z: number) => [n((x - y) * C + ox), n((x + y) * S - z + oy)];
  const D = (x: number, y: number, z: number) => [(x - y) * C, (x + y) * S - z];
  const plane = (o: Point, u: Point, v: Point) => {
    const [ax, ay] = P(...o);
    const [ux, uy] = D(...u);
    const [vx, vy] = D(...v);
    return `matrix(${n(ux)} ${n(uy)} ${n(vx)} ${n(vy)} ${ax} ${ay})`;
  };
  const TOP = (x: number, y: number, z: number) => plane([x, y, z], [1, 0, 0], [0, 1, 0]);
  const FRONT = (x: number, y: number, z: number) => plane([x, y, z], [1, 0, 0], [0, 0, -1]);
  const SIDE = (x: number, y: number, z: number) => plane([x, y, z], [0, -1, 0], [0, 0, -1]);
  const rect = (t: string, w: number, h: number, cls = "face", r = 0) =>
    `<g transform="${t}"><rect class="${cls}" width="${n(w)}" height="${n(h)}"${r ? ` rx="${r}"` : ""}/></g>`;
  // `cls` is added to every face, so `lit` or `glass` on a box lights all three.
  const box = (x: number, y: number, z: number, w: number, d: number, h: number, cls = "") => {
    const c = cls ? ` ${cls}` : "";
    return (
      rect(SIDE(x + w, y + d, z + h), d, h, `face side${c}`) +
      rect(FRONT(x, y + d, z + h), w, h, `face front${c}`) +
      rect(TOP(x, y, z + h), w, d, `face top${c}`)
    );
  };
  const path = (pts: Point[], cls = "wire", closed = false) =>
    `<path class="${cls}" pathLength="100" d="M${pts.map((p) => P(...p).join(" ")).join("L")}${closed ? "Z" : ""}"/>`;
  // Parallel hairlines on a face plane, in face-local units.
  const slits = (
    t: string,
    a0: number,
    a1: number,
    step: number,
    b0: number,
    b1: number,
    vertical = true,
    cls = "detail",
  ) => {
    let s = "";
    for (let a = a0; a <= a1 + 1e-6; a += step)
      s += vertical
        ? `<line class="${cls}" x1="${n(a)}" y1="${b0}" x2="${n(a)}" y2="${b1}"/>`
        : `<line class="${cls}" x1="${b0}" y1="${n(a)}" x2="${b1}" y2="${n(a)}"/>`;
    return `<g transform="${t}">${s}</g>`;
  };
  // Any flat polygon in 3D (roof slopes, gables, ramps).
  const poly = (pts: Point[], cls = "face") =>
    `<path class="${cls}" d="M${pts.map((p) => P(...p).join(" ")).join("L")}Z"/>`;
  // Arbitrary markup drawn on a face plane, in face-local units.
  const on = (t: string, inner: string) => `<g transform="${t}">${inner}</g>`;
  // Rounded box: one rounded top plus one continuous wall along the visible part
  // of the outline, so corners line up (iso-glow lesson: never round faces apart).
  const rbox = (
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
    r: number,
    cls = "",
  ) => {
    r = Math.min(r, w / 2, d / 2);
    const steps = 8;
    const z1 = z + h;
    const q = Math.PI / 4;
    const H = Math.PI / 2;
    const c = cls ? ` ${cls}` : "";
    const arc = (cx: number, cy: number, a0: number, a1: number) =>
      Array.from({ length: steps + 1 }, (_, i) => {
        const a = a0 + ((a1 - a0) * i) / steps;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
      });
    const ring = [
      ...arc(x + w - r, y + r, -H, 0),
      ...arc(x + w - r, y + d - r, 0, H),
      ...arc(x + r, y + d - r, H, 2 * H),
      ...arc(x + r, y + r, 2 * H, 3 * H),
    ];
    const visible = [
      ...arc(x + w - r, y + r, -q, 0),
      ...arc(x + w - r, y + d - r, 0, H),
      ...arc(x + r, y + d - r, H, 3 * q),
    ];
    const d3 = (pts: Point[]) => `M${pts.map((p) => P(...p).join(" ")).join("L")}Z`;
    const wall: Point[] = [
      ...visible.map(([a, b]): Point => [a, b, z]),
      ...visible
        .slice()
        .reverse()
        .map(([a, b]): Point => [a, b, z1]),
    ];
    return (
      `<path class="face side${c}" d="${d3(wall)}"/>` +
      `<path class="face top${c}" d="${d3(ring.map(([a, b]): Point => [a, b, z1]))}"/>`
    );
  };
  return { P, D, plane, TOP, FRONT, SIDE, rect, box, rbox, poly, on, path, slits };
}

// Fit a scene: pass its extreme 3D corners (including the tallest point).
export function frame(points: Point[], margin = 0.05) {
  const d = points.map(([x, y, z]) => [(x - y) * C, (x + y) * S - z]);
  const xs = d.map((p) => p[0]);
  const ys = d.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const m = margin * Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0);
  const w = Math.max(...xs) - x0 + 2 * m;
  const h = Math.max(...ys) - y0 + 2 * m;
  return { ...kernel(m - x0, m - y0), viewBox: `0 0 ${n(w)} ${n(h)}`, w, h };
}
