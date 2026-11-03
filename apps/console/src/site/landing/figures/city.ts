import { frame, plate, type Figure, type K, type Point } from "./kit.ts";

// Closing: a district of towers. The central tower issues notes: its floors
// light from the lobby up, its mast beacon flashes, and a dot of light flies
// to each rooftop; that tower then lights from the roof down. Hovering (or
// tapping) a tower lights it whole (city.client.ts).

type Tier = { h: number; i: number };
type Roof = "tank" | "mast" | "spire" | "hvac" | "garden";
type Tower = {
  id: string;
  x: number;
  y: number;
  w: number;
  d: number;
  tiers: Tier[];
  roof: Roof[];
  ribbon?: boolean;
};

const G = 8;
const FLOOR = 8;
const LOBBY = 9;
const PITCH = 6.4;
const f = (v: number) => Number(v.toFixed(2));

const TOWERS: Tower[] = [
  {
    id: "a",
    x: 12,
    y: 12,
    w: 52,
    d: 52,
    tiers: [
      { h: 84, i: 0 },
      { h: 22, i: 7 },
    ],
    roof: ["hvac"],
  },
  {
    id: "b",
    x: 86,
    y: 12,
    w: 60,
    d: 54,
    tiers: [
      { h: 96, i: 0 },
      { h: 36, i: 6 },
      { h: 22, i: 13 },
    ],
    roof: ["mast"],
  },
  {
    id: "c",
    x: 160,
    y: 14,
    w: 52,
    d: 50,
    tiers: [{ h: 88, i: 0 }],
    roof: ["hvac", "tank"],
    ribbon: true,
  },
  { id: "d", x: 12, y: 86, w: 50, d: 54, tiers: [{ h: 60, i: 0 }], roof: ["hvac"] },
  {
    id: "e",
    x: 86,
    y: 86,
    w: 60,
    d: 60,
    tiers: [
      { h: 92, i: 0 },
      { h: 50, i: 7 },
      { h: 30, i: 15 },
    ],
    roof: ["spire"],
  },
  {
    id: "f",
    x: 160,
    y: 88,
    w: 54,
    d: 54,
    tiers: [
      { h: 70, i: 0 },
      { h: 24, i: 8 },
    ],
    roof: ["tank"],
    ribbon: true,
  },
  { id: "g", x: 12, y: 160, w: 52, d: 48, tiers: [{ h: 30, i: 0 }], roof: ["hvac"] },
  {
    id: "h",
    x: 86,
    y: 160,
    w: 58,
    d: 50,
    tiers: [{ h: 44, i: 0 }],
    roof: ["garden"],
    ribbon: true,
  },
  { id: "i", x: 160, y: 162, w: 54, d: 46, tiers: [{ h: 36, i: 0 }], roof: ["hvac"] },
];

const PW = 226;
const PD = 222;

// Deterministic "random" for dark windows.
const hash = (a: number, b: number, c: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return v - Math.floor(v);
};
const dc = (t: number) => `ct-d${Math.max(0, Math.round(t * 10))}`;

function height(t: Tower) {
  return t.tiers.reduce((a, b) => a + b.h, 0);
}

// Windows of one face row as two paths: the ones that take part in the wave
// and the few that stay dark.
function row(width: number, cls: string, seed: number, ribbon: boolean) {
  if (ribbon) {
    const dark = hash(seed, 1, width) < 0.25;
    let m = "";
    for (let x = 3 + PITCH; x < width - 4; x += PITCH)
      m += `<line class="ct-rib-m" x1="${f(x)}" y1="0" x2="${f(x)}" y2="3.6"/>`;
    return `<rect class="ct-w ${dark ? "ct-off" : cls}" x="3" y="0" width="${f(width - 6)}" height="3.6"/>${m}`;
  }
  const cols = Math.floor((width - 4) / PITCH);
  const x0 = (width - (cols - 1) * PITCH - 3.4) / 2;
  let on = "";
  let off = "";
  for (let i = 0; i < cols; i++) {
    const r = `M${f(x0 + i * PITCH)} 0h3.4v4.2h-3.4Z`;
    if (hash(seed, i, cols) < 0.3) off += r;
    else on += r;
  }
  return (
    (on ? `<path class="ct-w ${cls}" d="${on}"/>` : "") +
    (off ? `<path class="ct-w ct-off" d="${off}"/>` : "")
  );
}

function tank(k: K, cx: number, cy: number, z: number, r: number) {
  let s = "";
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ])
    s += k.box(cx + dx! * r * 0.6 - 0.6, cy + dy! * r * 0.6 - 0.6, z, 1.2, 1.2, 7);
  const z1 = z + 7;
  s += k.rbox(cx - r, cy - r, z1, 2 * r, 2 * r, 11, r);
  const q = r / Math.SQRT2;
  const hoop = (zz: number) =>
    k.on(
      k.TOP(cx, cy, zz),
      `<path class="detail" d="M${f(q)} ${f(-q)}A${r} ${r} 0 0 1 ${f(-q)} ${f(q)}"/>`,
    );
  s += hoop(z1 + 3.5) + hoop(z1 + 7.5);
  s += k.poly(
    [
      [cx - q, cy + q, z1 + 11],
      [cx + q, cy - q, z1 + 11],
      [cx, cy, z1 + 16],
    ],
    "face roof",
  );
  return s;
}

function hvac(k: K, x: number, y: number, z: number) {
  return (
    k.box(x, y, z, 12, 9, 5) +
    k.on(
      k.TOP(x, y, z + 5),
      `<circle class="detail" cx="6" cy="4.5" r="3.4"/><circle class="detail" cx="6" cy="4.5" r="1"/>`,
    )
  );
}

function mast(k: K, cx: number, cy: number, z: number, h: number, beacon: string, base = true) {
  const [x0, y0] = k.P(cx, cy, z);
  const [x1, y1] = k.P(cx, cy, z + h);
  const [xa, ya] = k.P(cx, cy, z + h * 0.45);
  return (
    (base ? k.box(cx - 2.5, cy - 2.5, z, 5, 5, 3) : "") +
    `<line class="ct-mast" x1="${x0}" y1="${y0! - (base ? 3 : 0)}" x2="${x1}" y2="${y1}"/>` +
    `<line class="ct-mast" x1="${xa! - 4}" y1="${ya}" x2="${xa! + 4}" y2="${ya}"/>` +
    `<circle class="ct-beacon ${beacon}" cx="${x1}" cy="${y1}" r="1.7"/>`
  );
}

function tower(k: K, t: Tower, delay: (z: number, top: number) => number) {
  const top = G + height(t);
  let s = `<g class="ct-tower" data-tower="${t.id}">`;
  s += k.box(t.x - 3, t.y - 3, G, t.w + 6, t.d + 6, 1.4, "ct-curb");
  let z = G + 1.4;
  t.tiers.forEach((tier, n) => {
    const x = t.x + tier.i;
    const y = t.y + tier.i;
    const w = t.w - 2 * tier.i;
    const d = t.d - 2 * tier.i;
    const zt = z + tier.h;
    s += k.box(x, y, z, w, d, tier.h);
    s += k.on(
      k.TOP(x, y, zt),
      `<rect class="detail" x="2" y="2" width="${w - 4}" height="${d - 4}"/>`,
    );
    const faces: [string, number][] = [
      [k.FRONT(x, y + d, zt), w],
      [k.SIDE(x + w, y + d, zt), d],
    ];
    for (const [plane, width] of faces) {
      let inner = `<line class="detail" x1="0" y1="2.2" x2="${width}" y2="2.2"/>`;
      const bottom = n === 0 ? LOBBY + 3 : 3;
      for (let v = 5; tier.h - v - 4.2 >= bottom; v += FLOOR) {
        const zz = zt - v;
        inner += `<g transform="translate(0 ${v})">${row(width, dc(delay(zz, top)), zz * 3 + width + t.x, !!t.ribbon)}</g>`;
      }
      if (n === 0) {
        const v0 = tier.h - LOBBY;
        inner += `<rect class="face ct-canopy" x="1.5" y="${v0 - 1.6}" width="${width - 3}" height="1.6"/>`;
        inner += `<rect class="glass hot" x="3" y="${v0 + 1.2}" width="${width - 6}" height="${LOBBY - 1.2}"/>`;
        for (let m = 3 + 6; m < width - 4; m += 6)
          inner += `<line class="ct-mull" x1="${m}" y1="${v0 + 1.2}" x2="${m}" y2="${tier.h}"/>`;
        if (plane === faces[0]![0])
          inner += `<rect class="lit" x="${f(width / 2 - 4)}" y="${v0 + 2.6}" width="8" height="${LOBBY - 2.6}"/>`;
      }
      s += k.on(plane, inner);
    }
    z = zt;
  });

  // Rooftop.
  const last = t.tiers[t.tiers.length - 1]!;
  const rx = t.x + last.i;
  const ry = t.y + last.i;
  const rw = t.w - 2 * last.i;
  const rd = t.d - 2 * last.i;
  for (const item of t.roof) {
    if (item === "tank") s += tank(k, rx + rw * 0.35, ry + rd * 0.4, top, 6);
    if (item === "hvac") s += hvac(k, rx + 6, ry + 7, top) + hvac(k, rx + 22, ry + 7, top);
    if (item === "mast") s += mast(k, rx + rw / 2, ry + rd / 2, top, 30, "lit");
    if (item === "garden")
      s += k.on(
        k.TOP(rx, ry, top),
        Array.from({ length: 3 }, (_, i) =>
          Array.from(
            { length: 2 },
            (_, j) =>
              `<rect class="face top ct-solar" x="${6 + j * 24}" y="${7 + i * 12}" width="21" height="9"/>` +
              `<line class="detail" x1="${6 + j * 24 + 7}" y1="${7 + i * 12}" x2="${6 + j * 24 + 7}" y2="${16 + i * 12}"/>` +
              `<line class="detail" x1="${6 + j * 24 + 14}" y1="${7 + i * 12}" x2="${6 + j * 24 + 14}" y2="${16 + i * 12}"/>`,
          ).join(""),
        ).join(""),
      );
    if (item === "spire") {
      const h = 36;
      const cx = rx + rw / 2;
      const cy = ry + rd / 2;
      s += k.poly(
        [
          [rx, ry + rd, top],
          [rx + rw, ry + rd, top],
          [cx, cy, top + h],
        ],
        "face front",
      );
      s += k.poly(
        [
          [rx + rw, ry + rd, top],
          [rx + rw, ry, top],
          [cx, cy, top + h],
        ],
        "face side",
      );
      s += k.on(
        k.FRONT(rx, ry + rd, top),
        `<rect class="lit ct-crown" x="0" y="-1.2" width="${rw}" height="1.6"/>`,
      );
      s += k.on(
        k.SIDE(rx + rw, ry + rd, top),
        `<rect class="lit ct-crown" x="0" y="-1.2" width="${rd}" height="1.6"/>`,
      );
      s += mast(k, cx, cy, top + h, 24, "ct-tx ct-d16", false);
    }
  }
  return `${s}</g>`;
}

export function city(): Figure {
  const e = TOWERS.find((t) => t.id === "e")!;
  const eTop = G + height(e) + 36 + 24 + 4;
  const origin: Point = [e.x + e.w / 2, e.y + e.d / 2, eTop];
  const others = TOWERS.filter((t) => t.id !== "e");
  // Launch order: back row first, then sideways, then the front.
  const order = ["b", "f", "a", "h", "c", "d", "i", "g"];
  const arrive = new Map<string, number>();
  const LAUNCH = 1.6;
  const TRAVEL = 0.9;
  order.forEach((id, i) => arrive.set(id, LAUNCH + i * 0.3 + TRAVEL));

  const k = frame([[0, 0, 0], [PW, 0, 0], [0, PD, 0], [PW, PD, 0], origin], 0.03);
  let s = plate(k, 0, 0, PW, PD, 8, 12);
  // Street centre lines.
  s += k.on(
    k.TOP(0, 0, G),
    [79, 153]
      .map(
        (c) =>
          `<line class="ct-lane" x1="10" y1="${c}" x2="${PW - 10}" y2="${c}"/><line class="ct-lane" x1="${c}" y1="10" x2="${c}" y2="${PD - 10}"/>`,
      )
      .join(""),
  );

  const sorted = TOWERS.slice().sort((a, b) => a.x + a.y - (b.x + b.y) || a.x - b.x);
  for (const t of sorted) {
    if (t.id === "e") {
      s += tower(k, t, (z) => 0.1 + ((z - G) / (height(t) - 4)) * 1.4);
    } else {
      const at = arrive.get(t.id)!;
      s += tower(k, t, (z, top) => at + ((top - z) / top) * 1.1);
    }
  }

  // Flights: a dot of light leaves the beacon and lands on each roof.
  for (const t of others) {
    const to: Point = [
      t.x + t.w / 2 + (t.roof.includes("tank") ? 8 : 0),
      t.y + t.d / 2,
      G + height(t) + 1,
    ];
    const lift = Math.max(origin[2], to[2]) + 26;
    const pts: Point[] = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const m = (a: number, b: number, c: number) =>
        (1 - u) ** 2 * a + 2 * (1 - u) * u * b + u * u * c;
      pts.push([
        m(origin[0], (origin[0] + to[0]) / 2, to[0]),
        m(origin[1], (origin[1] + to[1]) / 2, to[1]),
        m(origin[2], lift, to[2]),
      ]);
    }
    s += k.path(pts, `ct-fly ${dc(arrive.get(t.id)! - TRAVEL)}`);
  }
  return { name: "city", svg: s, viewBox: k.viewBox };
}
