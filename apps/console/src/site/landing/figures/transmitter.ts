import { frame, plate, type Figure, type K, type Point } from "./kit.ts";

// Station 3: a lattice mast beams the signed document to SEFAZ. A signpost at
// the fork shows the route that was chosen (municipal, state, national); the
// lit lane and blade lead to the building, which answers by lighting its door
// and windows. Shared station frame: plate 184 x 92.
const MAST = { x: 14, y: 60, w: 9, top: 56 };
const B = { x: 98, y: 6, z: 8 }; // building origin
const OCULUS: Point = [B.x + 36, B.y + 58, B.z + 58];

export function transmitter(): Figure {
  const k = frame(
    [
      [0, 0, 0],
      [184, 0, 0],
      [0, 92, 0],
      [184, 92, 0],
      [0, 0, 22],
    ],
    0.03,
  );
  let s = plate(k, 0, 0, 184, 92);
  s += lanes(k);
  s += sefaz(k, B.x, B.y, B.z);
  s += signpost(k, FORK.x, FORK.y);
  s += mast(k);
  const head: Point = [MAST.x + MAST.w / 2, MAST.y + MAST.w / 2, MAST.top + 6];
  s += `<g class="beam">${k.path([head, OCULUS], "beam-halo")}${k.path([head, OCULUS], "beam-core")}${k.path([head, OCULUS], "beam-pulse")}</g>`;
  return { name: "transmitter", svg: s, viewBox: k.viewBox };
}

// Three ground lanes fan out from a fork in front of the mast; the chosen
// one (lit) runs to the building's steps.
const FORK = { x: 62, y: 78 };
function lanes(k: K) {
  const z = 8.2;
  const foot: Point = [MAST.x + MAST.w + 3, MAST.y + MAST.w / 2, z];
  const fork: Point = [FORK.x, FORK.y, z];
  let s = k.path([fork, [FORK.x, 44, z], [86, 30, z]], "lane");
  s += k.path([fork, [FORK.x, 91, z]], "lane");
  s += k.path(
    [foot, [FORK.x - 10, foot[1], z], fork, [B.x + 36, FORK.y, z], [B.x + 36, B.y + 66, z]],
    "lane lit-lane",
  );
  return s;
}

// Signpost: three arrow blades; the lit one points to SEFAZ (+x).
function signpost(k: K, x: number, y: number) {
  let s = k.box(x - 1, y - 1, 8, 2, 2, 36);
  s += k.box(x - 1.6, y - 1.6, 44, 3.2, 3.2, 1.4);
  const blade = (label: string, lit: boolean, flip = false) =>
    `<path class="blade${lit ? " lit" : ""}" d="${flip ? "M0 0L-15 0L-18 2.5L-15 5L0 5Z" : "M0 0L15 0L18 2.5L15 5L0 5Z"}"/>` +
    `<text class="blade-t${lit ? " on" : ""}" x="${flip ? -8 : 8}" y="3.9" text-anchor="middle">${label}</text>`;
  s += k.on(k.SIDE(x + 1, y + 1, 42), blade("NAC", false, true));
  s += k.on(k.SIDE(x + 1, y + 1, 35), blade("MUN", false));
  s += k.on(k.FRONT(x + 1, y + 1, 27), blade("UF", true));
  return s;
}

// Lattice mast: braced legs drawn on its two visible faces, a beacon on top.
function mast(k: K) {
  const { x, y, w, top } = MAST;
  let s = k.box(x - 3, y - 3, 8, w + 6, w + 6, 3);
  s += k.box(x, y, 11, w, w, top - 11);
  const h = top - 11;
  const bays = 5;
  const bay = h / bays;
  let lattice = "";
  for (let i = 0; i < bays; i++) {
    const a = i * bay;
    const b = a + bay;
    lattice += `<line class="detail" x1="0" y1="${a}" x2="${w}" y2="${b}"/><line class="detail" x1="${w}" y1="${a}" x2="0" y2="${b}"/><line class="detail" x1="0" y1="${b}" x2="${w}" y2="${b}"/>`;
  }
  s += k.on(k.FRONT(x, y + w, top), lattice);
  s += k.on(k.SIDE(x + w, y + w, top), lattice);
  // Platform and beacon housing.
  s += k.box(x - 1.5, y - 1.5, top, w + 3, w + 3, 2);
  const cx = x + w / 2;
  const cy = y + w / 2;
  const [hx, hy] = k.P(cx, cy, top + 6);
  s += `<circle class="beacon-halo" cx="${hx}" cy="${hy}" r="9"/>`;
  s += k.rbox(cx - 3.5, cy - 3.5, top + 2, 7, 7, 7, 3.5, "lit beacon");
  s += k.box(cx - 0.6, cy - 0.6, top + 9, 1.2, 1.2, 6);
  return s;
}

// Classical public building, façade toward +y (the viewer's lower left): a
// three-step stylobate, cella with door and windows, six columns, entablature
// carrying the name, pediment with an oculus, and a pitched roof.
function sefaz(k: K, x: number, y: number, z: number) {
  const W = 72;
  let s = "";
  // Stylobate: three steps, each a little shallower toward the front.
  s += k.box(x, y, z, W, 64, 3) + k.box(x + 2, y + 2, z + 3, W - 4, 58, 3);
  s += k.box(x + 4, y + 4, z + 6, W - 8, 52, 3);
  const base = z + 9;
  // Cella.
  s += k.box(x + 10, y + 8, base, W - 20, 32, 34);
  s += k.on(
    k.FRONT(x + 10, y + 40, base + 34),
    `<rect class="door answer" x="${(W - 20) / 2 - 5}" y="12" width="10" height="22" rx="0.8"/>` +
      `<rect class="window answer" x="6" y="10" width="8" height="11"/>` +
      `<rect class="window answer" x="${W - 20 - 14}" y="10" width="8" height="11"/>`,
  );
  s += k.on(
    k.SIDE(x + W - 10, y + 40, base + 34),
    `<rect class="window answer" x="6" y="10" width="7" height="11"/>` +
      `<rect class="window answer" x="19" y="10" width="7" height="11"/>`,
  );
  // Six columns on the front edge of the top step, each with base and capital.
  for (let i = 0; i < 6; i++) {
    const cx = x + 7 + i * 11.2;
    const cy = y + 49;
    s += k.box(cx - 0.5, cy - 0.5, base, 5, 5, 2);
    s += k.box(cx, cy, base + 2, 4, 4, 30);
    s += k.on(
      k.FRONT(cx, cy + 4, base + 32),
      `<line class="detail" x1="2" y1="2" x2="2" y2="28"/>`,
    );
    s += k.box(cx - 1, cy - 1, base + 32, 6, 6, 2);
  }
  // Entablature with the name.
  const e = base + 34;
  s += k.box(x + 3, y + 5, e, W - 6, 53, 8);
  s += k.on(
    k.FRONT(x + 3, y + 58, e + 8),
    `<line class="detail" x1="0" y1="2.4" x2="${W - 6}" y2="2.4"/>` +
      `<text class="label name" x="${(W - 6) / 2}" y="6.9" text-anchor="middle">SEFAZ</text>`,
  );
  // Roof slopes (ridge runs front to back) and the pediment on the façade.
  const r0 = e + 8;
  const r1 = r0 + 15;
  const mid = x + W / 2;
  s += k.poly(
    [
      [x + 3, y + 58, r0],
      [mid, y + 58, r1],
      [mid, y + 5, r1],
      [x + 3, y + 5, r0],
    ],
    "face roof",
  );
  s += k.poly(
    [
      [mid, y + 58, r1],
      [x + W - 3, y + 58, r0],
      [x + W - 3, y + 5, r0],
      [mid, y + 5, r1],
    ],
    "face roof-side",
  );
  s += k.slits(
    k.plane([mid, y + 5, r1], [0, 1, 0], [1, 0, -15 / (W / 2 - 3)]),
    4,
    50,
    5,
    1,
    W / 2 - 4,
    true,
  );
  s += k.poly(
    [
      [x + 3, y + 58, r0],
      [x + W - 3, y + 58, r0],
      [mid, y + 58, r1],
    ],
    "face front",
  );
  s += k.poly(
    [
      [x + 9, y + 58, r0 + 1.6],
      [x + W - 9, y + 58, r0 + 1.6],
      [mid, y + 58, r1 - 2.4],
    ],
    "detail",
  );
  s += k.on(k.FRONT(...OCULUS), `<circle class="oculus" r="2.8"/>`);
  return s;
}
