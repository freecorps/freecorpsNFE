import { frame, type Figure, type K } from "./kit.ts";

// NFS-e municipal: the prefeitura on its square, between blocks of small
// houses. City blocks sit on a diagonal of the street grid, so the row reads
// wide and low. Windows light in a wave across the town; the flag waves.

// Window classes: lit, plus a band (0 to 7) from the window's screen
// position, so the CSS lights the town as a wave from left to right.
function win(k: K, x: number, y: number, z: number) {
  const band = Math.min(7, Math.max(0, Math.floor((k.P(x, y, z)[0]! / k.w) * 8)));
  return `window lit wave b${band}`;
}

// Sidewalk block: a low slab with a kerb line.
function block(k: K, x: number, y: number, w: number, d: number) {
  return (
    k.rbox(x, y, 0, w, d, 4, 3) +
    k.on(
      k.TOP(x, y, 4),
      `<rect class="kerb" x="3" y="3" width="${w - 6}" height="${d - 6}" rx="1.5"/>`,
    )
  );
}

// A house with the ridge along x: eaves toward the viewer, gable on the
// right. Door and windows on the long front wall.
function houseEaves(k: K, x: number, y: number, w: number, d: number, h: number, rh: number) {
  const z = 4;
  const e = z + h;
  const o = 1.6; // eave overhang
  let s = `<g class="bldg">${k.box(x, y, z, w, d, h)}`;
  const winW = 6;
  const n = w > 30 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 4 : 4 + i * (w - 26);
    s += k.on(
      k.FRONT(x, y + d, e),
      `<rect class="${win(k, x + u, y + d, e)}" x="${u}" y="${h * 0.28}" width="${winW}" height="${h * 0.34}"/>`,
    );
  }
  s += k.on(
    k.FRONT(x, y + d, e),
    `<rect class="door" x="${w - 11}" y="${h * 0.34}" width="6" height="${h * 0.66}"/>` +
      `<line class="detail" x1="0" y1="${h - 2}" x2="${w - 12}" y2="${h - 2}"/>`,
  );
  // Back slope (seen as a sliver above the ridge), front slope, then gable.
  s += k.poly(
    [
      [x - o, y - o, e],
      [x + w + o, y - o, e],
      [x + w + o, y + d / 2, e + rh],
      [x - o, y + d / 2, e + rh],
    ],
    "face roof-side",
  );
  s += k.poly(
    [
      [x - o, y + d / 2, e + rh],
      [x + w + o, y + d / 2, e + rh],
      [x + w + o, y + d + o, e],
      [x - o, y + d + o, e],
    ],
    "face roof",
  );
  s += k.slits(
    k.plane([x - o, y + d / 2, e + rh], [1, 0, 0], [0, 1, -(2 * rh) / (d + 2 * o)]),
    6,
    w - 2,
    6,
    0,
    d / 2 + o,
  );
  s += k.poly(
    [
      [x + w, y + d, e],
      [x + w, y, e],
      [x + w, y + d / 2, e + rh],
    ],
    "face side",
  );
  return `${s}</g>`;
}

// A house with the gable toward the viewer (ridge along y).
function houseGable(k: K, x: number, y: number, w: number, d: number, h: number, rh: number) {
  const z = 4;
  const e = z + h;
  const o = 1.6;
  let s = `<g class="bldg">${k.box(x, y, z, w, d, h)}`;
  s += k.on(
    k.FRONT(x, y + d, e),
    `<rect class="${win(k, x + 4, y + d, e)}" x="4" y="${h * 0.26}" width="6" height="${h * 0.36}"/>`,
  );
  s += k.on(
    k.SIDE(x + w, y + d, e),
    `<rect class="${win(k, x + w, y + d / 2, e)}" x="${d / 2 - 3}" y="${h * 0.26}" width="6" height="${h * 0.36}"/>`,
  );
  s += k.on(
    k.FRONT(x, y + d, e),
    `<rect class="door" x="${w - 11}" y="${h * 0.34}" width="6" height="${h * 0.66}"/>`,
  );
  // Left slope (thin, faces away), right slope, then the gable wall in front.
  s += k.poly(
    [
      [x - o, y - o, e],
      [x + w / 2, y - o, e + rh],
      [x + w / 2, y + d + o, e + rh],
      [x - o, y + d + o, e],
    ],
    "face roof-side",
  );
  s += k.poly(
    [
      [x + w / 2, y - o, e + rh],
      [x + w + o, y - o, e],
      [x + w + o, y + d + o, e],
      [x + w / 2, y + d + o, e + rh],
    ],
    "face roof",
  );
  s += k.poly(
    [
      [x, y + d, e],
      [x + w, y + d, e],
      [x + w / 2, y + d, e + rh],
    ],
    "face front",
  );
  s += k.on(
    k.FRONT(x, y + d, e),
    `<circle class="detail" cx="${w / 2}" cy="${-rh * 0.38}" r="1.6"/>`,
  );
  return `${s}</g>`;
}

// A street lamp: post and a lit globe.
function lamp(k: K, x: number, y: number) {
  const [gx, gy] = k.P(x + 0.6, y + 0.6, 26.5) as [number, number];
  return k.box(x, y, 4, 1.2, 1.2, 21) + `<circle class="globe" cx="${gx}" cy="${gy}" r="2.4"/>`;
}

// A round tree: trunk and a ball crown (a sphere projects to a circle).
function tree(k: K, x: number, y: number, r = 7) {
  const [cx, cy] = k.P(x, y, 10 + r) as [number, number];
  return (
    k.box(x - 1, y - 1, 4, 2, 2, 8) +
    `<circle class="crown" cx="${cx}" cy="${cy}" r="${r}"/>` +
    `<path class="crown-line" d="M${cx - r * 0.55} ${cy + r * 0.2}a${r * 0.6} ${r * 0.6} 0 0 0 ${r * 1.1} 0"/>`
  );
}

// The prefeitura: a two-storey block with a flat roof behind a parapet, a
// central portico (steps, four columns, entablature with its name, pediment
// with a lit clock), windows on the front wings and the side, and the flag
// on the roof.
function prefeitura(k: K) {
  const { box, on, poly, FRONT, SIDE, TOP } = k;
  let s = "";
  // Main block 120 x 44 x 40 on the slab (z 4), cornice and parapet.
  s += box(0, 0, 4, 120, 44, 40);
  s += on(FRONT(0, 44, 24), `<line class="detail" x1="0" y1="0" x2="120" y2="0"/>`);
  s += on(SIDE(120, 44, 24), `<line class="detail" x1="0" y1="0" x2="44" y2="0"/>`);
  // Front wings: two rows of three arched windows each side of the portico.
  const cols = [3.5, 11.5, 19.5, 95.5, 103.5, 111.5];
  for (const u of cols)
    for (const v of [5, 25])
      s += on(
        FRONT(0, 44, 44),
        `<rect class="${win(k, u, 44, 44)}" x="${u}" y="${v}" width="5" height="11" rx="2.5"/>` +
          `<line class="sill" x1="${u - 0.8}" y1="${v + 11.6}" x2="${u + 5.8}" y2="${v + 11.6}"/>`,
      );
  // Side: two rows of four.
  for (const v of [5, 25])
    for (let i = 0; i < 4; i++) {
      const u = 5 + i * 10;
      s += on(
        SIDE(120, 44, 44),
        `<rect class="${win(k, 120, 44 - u, 44)}" x="${u}" y="${v}" width="5" height="11" rx="2.5"/>` +
          `<line class="sill" x1="${u - 0.8}" y1="${v + 11.6}" x2="${u + 5.8}" y2="${v + 11.6}"/>`,
      );
    }
  s += box(-1.5, -1.5, 44, 123, 47, 3);
  s += box(0, 0, 47, 120, 44, 5);
  s += on(TOP(0, 0, 52), `<rect class="roof-inner" x="3" y="3" width="114" height="38"/>`);

  // Flag on the roof, behind the pediment.
  s += flag(k, 58, 16, 52, 84);

  // Portico: two steps, the doors and upper windows behind four columns.
  s += box(26, 44, 4, 68, 14, 2) + box(28, 44, 6, 64, 10, 2);
  s += on(
    FRONT(28, 44, 40),
    `<rect class="door lit" x="27" y="13" width="10" height="19" rx="5"/>` +
      [9.5, 29.5, 49.5]
        .map((u) => `<rect class="window lit" x="${u}" y="2" width="5" height="9" rx="2.5"/>`)
        .join(""),
  );
  for (const x of [31, 44, 71, 84])
    s += box(x, 49, 8, 5, 5, 31) + box(x - 0.8, 48.2, 39, 6.6, 6.6, 1.4);
  s += box(28, 44, 40.4, 64, 11, 7);
  s += on(
    FRONT(28, 55, 47.4),
    `<line class="detail" x1="0" y1="1.4" x2="64" y2="1.4"/>` +
      `<text class="name" x="32" y="6" text-anchor="middle">PREFEITURA</text>`,
  );
  // Pediment: roof slopes back to the main block, then the gable in front.
  const e = 47.4;
  const r = 60;
  s += poly(
    [
      [27, 56, e],
      [60, 56, r],
      [60, 40, r],
      [27, 40, e],
    ],
    "face roof-side",
  );
  s += poly(
    [
      [60, 56, r],
      [93, 56, e],
      [93, 40, e],
      [60, 40, r],
    ],
    "face roof",
  );
  s += poly(
    [
      [27, 56, e],
      [93, 56, e],
      [60, 56, r],
    ],
    "face front",
  );
  s += on(
    FRONT(27, 56, e),
    `<path class="detail" d="M6 -1.4H60L33 -11.2Z"/><circle class="clock lit" cx="33" cy="-4.8" r="2.6"/>` +
      `<line class="clock-hand" x1="33" y1="-4.8" x2="33" y2="-6.6"/><line class="clock-hand" x1="33" y1="-4.8" x2="34.3" y2="-4.8"/>`,
  );
  return s;
}

// Flagpole with a waving flag (the flag is drawn on the front plane and
// skewed from the pole by CSS).
function flag(k: K, x: number, y: number, z: number, top: number) {
  const [fx, fy] = k.P(x + 0.6, y + 0.6, top) as [number, number];
  return (
    k.box(x - 1.4, y - 1.4, z, 4, 4, 1.6) +
    k.box(x, y, z + 1.6, 1.2, 1.2, top - z - 1.6) +
    k.on(
      k.FRONT(x + 1.2, y + 1.2, top - 1),
      `<g class="flag"><path class="flag-cloth" d="M0 0C5 -1.6 10 1.6 17 0V10.5C10 12.1 5 8.9 0 10.5Z"/>` +
        `<circle class="flag-disc" cx="8.5" cy="5.2" r="2.4"/></g>`,
    ) +
    `<circle class="finial" cx="${fx}" cy="${fy - 1}" r="1.2"/>`
  );
}

export function cityHall(): Figure {
  // Three blocks on one diagonal of the street grid (x + y constant through
  // their centres), so the row reads wide and low on screen.
  const M = { x: -10, y: -10, w: 140, d: 84 };
  const L = { x: -90, y: 109, w: 100, d: 46 };
  const R = { x: 110, y: -91, w: 100, d: 46 };
  const k = frame(
    [
      [L.x, L.y + L.d, 0],
      [L.x + L.w, L.y, 0],
      [R.x, R.y + R.d, 0],
      [R.x + R.w, R.y, 0],
      [0, 0, 52],
      [M.x + M.w, M.y + M.d, 0],
      [58, 16, 86],
    ],
    0.02,
  );
  let s = "";

  // Blocks never overlap on screen, so they can be drawn in any order; inside
  // each block the parts go back to front.
  s += block(k, R.x, R.y, R.w, R.d);
  s += houseGable(k, R.x + 6, R.y + 6, 26, 30, 18, 12);
  s += houseEaves(k, R.x + 36, R.y + 10, 30, 24, 15, 8);
  s += houseGable(k, R.x + 70, R.y + 8, 24, 28, 20, 11);
  s += lamp(k, R.x + 34, R.y + 40);

  s += block(k, M.x, M.y, M.w, M.d);
  s += `<g class="bldg">${prefeitura(k)}</g>`;
  s += k.on(k.TOP(M.x, M.y, 4), `<path class="kerb" d="M48 68V${M.d - 3}M92 68V${M.d - 3}"/>`);
  s += tree(k, 6, 64, 6.5) + lamp(k, 20, 68);
  s += lamp(k, 100, 68) + tree(k, 116, 66, 6.5);

  s += block(k, L.x, L.y, L.w, L.d);
  s += houseEaves(k, L.x + 6, L.y + 12, 34, 24, 17, 9);
  s += houseGable(k, L.x + 44, L.y + 6, 24, 30, 19, 11);
  s += houseEaves(k, L.x + 72, L.y + 12, 24, 22, 14, 8);
  s += lamp(k, L.x + 40, L.y + 41);

  return { name: "city-hall", svg: s, viewBox: k.viewBox };
}
