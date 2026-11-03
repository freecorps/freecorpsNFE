import { frame, type Figure, type K, type Point } from "./kit.ts";

// CT-e: a box truck (cab over engine, cargo box with ribs and a lit CT-e tag)
// driving down a short stretch of road, headlights on. Shared with the MDF-e
// rig (manifest.ts): wheels, road and headlight pool, so both read at the same
// scale and in the same hand.

const n = (v: number) => Number(v.toFixed(2));

// Convex hull of projected points (monotone chain), as an SVG path.
function hull(k: K, pts: Point[]) {
  const p = pts
    .map((q) => k.P(...q) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lo: number[][] = [];
  const hi: number[][] = [];
  for (const q of p) {
    while (lo.length > 1 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.slice().reverse()) {
    while (hi.length > 1 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, q) <= 0) hi.pop();
    hi.push(q);
  }
  const ring = [...lo.slice(0, -1), ...hi.slice(0, -1)];
  return `M${ring.map((q) => `${n(q[0]!)} ${n(q[1]!)}`).join("L")}Z`;
}

// A wheel on the near (+y) side: a tyre with real depth, sitting on z = 0,
// and a rim whose lug ring turns (`.spin`).
export const WHEEL_R = 7;
export function wheel(k: K, cx: number, y: number, r = WHEEL_R, depth = 5) {
  const ring: Point[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push([cx + r * Math.cos(a), y, r + r * Math.sin(a)]);
    ring.push([cx + r * Math.cos(a), y - depth, r + r * Math.sin(a)]);
  }
  const lugs = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2;
    return `<circle class="lug" cx="${n(Math.cos(a) * r * 0.36)}" cy="${n(Math.sin(a) * r * 0.36)}" r="0.55"/>`;
  }).join("");
  return (
    `<path class="wheel" d="${hull(k, ring)}"/>` +
    k.on(
      k.FRONT(cx, y, r),
      `<circle class="wheel" r="${r}"/><circle class="tread" r="${n(r - 1.3)}"/>` +
        `<circle class="hub" r="${n(r * 0.56)}"/>` +
        `<g class="spin"><circle class="spin-box" r="${n(r * 0.56)}"/>${lugs}` +
        `<line class="spoke" x1="${n(-r * 0.5)}" y1="0" x2="${n(r * 0.5)}" y2="0"/></g>` +
        `<circle class="cap" r="${n(r * 0.17)}"/>`,
    )
  );
}

// Road slab from x0 to x1, the vehicle's lane at y 0..30; a lane line slides
// under it (`.dashes`, one period = 14 units) and a solid edge line runs in front.
export function road(k: K, id: string, x0: number, x1: number) {
  const y0 = -6;
  const y1 = 44;
  const w = x1 - x0;
  let s = k.box(x0, y0, -3, w, y1 - y0, 3, "road");
  let dashes = "";
  for (let x = 0; x <= w + 28; x += 14)
    dashes += `<rect class="lane" x="${x}" y="36.4" width="7" height="1.4" rx="0.5"/>`;
  s += k.on(
    k.TOP(x0, y0, 0),
    `<clipPath id="${id}-road"><rect x="0" y="0" width="${w}" height="${y1 - y0}"/></clipPath>` +
      `<line class="edge" x1="1" y1="${y1 - y0 - 3}" x2="${w - 1}" y2="${y1 - y0 - 3}"/>` +
      `<line class="edge" x1="1" y1="2.5" x2="${w - 1}" y2="2.5"/>` +
      `<g clip-path="url(#${id}-road)"><g class="dashes">${dashes}</g></g>`,
  );
  return s;
}

// Light pool from the headlights spilling forward on the road (light, so it
// may be translucent), drawn on the road before the vehicle.
export function beams(k: K, id: string, x: number, reach: number) {
  const [ax, ay] = k.P(x, 15, 0);
  const [bx, by] = k.P(x + reach, 15, 0);
  const pool: Point[] = [
    [x, 3, 0],
    [x + reach, -5, 0],
    [x + reach, 37, 0],
    [x, 27, 0],
  ];
  return (
    `<linearGradient id="${id}-beam" gradientUnits="userSpaceOnUse" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}">` +
    `<stop class="beam-a" offset="0"/><stop class="beam-b" offset="1"/></linearGradient>` +
    k.poly(pool, "beam")
  );
}

// Cab over engine, nose toward +x: lower cab, raked windshield, roof
// deflector, door with side window, wheel arch, grille and lit headlights.
export function cab(k: K, x: number, top: number, roof: number, wheelX: number) {
  const x1 = x + 28;
  const shoulder = 30;
  const rake = 4;
  let s = k.box(x, 1, 11, 28, 28, shoulder - 11);
  // Upper cab: raked windshield, the near wall as a trapezoid, the roof.
  const sl = Math.hypot(rake, top - shoulder);
  s += k.on(
    k.plane([x1 - rake, 29, top], [0, -1, 0], [rake / sl, 0, (shoulder - top) / sl]),
    `<rect class="face side" width="28" height="${n(sl)}"/>` +
      `<rect class="glass" x="1.6" y="1.4" width="24.8" height="${n(sl - 2.8)}" rx="1"/>` +
      `<line class="wiper" x1="5" y1="${n(sl - 1.8)}" x2="12" y2="${n(sl - 5)}"/>` +
      `<line class="wiper" x1="16" y1="${n(sl - 1.8)}" x2="23" y2="${n(sl - 5)}"/>`,
  );
  s += k.poly(
    [
      [x, 29, top],
      [x1 - rake, 29, top],
      [x1, 29, shoulder],
      [x, 29, shoulder],
    ],
    "face front",
  );
  s += k.rect(k.TOP(x, 1, top), 28 - rake, 28, "face top");
  // Roof deflector, rising toward the box behind it.
  if (roof > top) {
    const fx = x + 16;
    const dl = Math.hypot(fx - x - 2, roof - top);
    s += k.on(
      k.plane([fx, 27, top], [0, -1, 0], [(x + 2 - fx) / dl, 0, (roof - top) / dl]),
      `<rect class="face side" width="24" height="${n(dl)}"/>`,
    );
    s += k.poly(
      [
        [x + 2, 27, top],
        [fx, 27, top],
        [x + 2, 27, roof],
      ],
      "face front",
    );
  }
  // Near wall: door, side window, handle, step and the wheel arch.
  const h = top - 11;
  const v = (z: number) => n(top - z);
  const wx = (z: number) => n(28 - rake * ((z - shoulder) / (top - shoulder)) - 2.4);
  const au = wheelX - x;
  const ar = WHEEL_R + 2;
  const av = top - WHEEL_R;
  const archDx = Math.sqrt(ar * ar - (av - h) ** 2);
  s += k.on(
    k.FRONT(x, 29, top),
    `<path class="glass" d="M9 ${v(top - 2.2)}L${wx(top - 2.2)} ${v(top - 2.2)}L${wx(shoulder + 1.5)} ${v(shoulder + 1.5)}L9 ${v(shoulder + 1.5)}Z"/>` +
      `<path class="detail" d="M7.5 ${v(top - 1)}L${wx(top - 1) + 0.8} ${v(top - 1)}L${n(28 - 0.8)} ${v(shoulder)}L${n(28 - 0.8)} ${v(WHEEL_R + ar + 1.2)}L7.5 ${v(WHEEL_R + ar + 1.2)}Z"/>` +
      `<line class="detail" x1="9.5" y1="${v(shoulder - 3)}" x2="13" y2="${v(shoulder - 3)}"/>` +
      `<path class="recess" d="M${n(au - archDx)} ${h}A${ar} ${ar} 0 0 1 ${n(au + archDx)} ${h}Z"/>` +
      `<line class="detail" x1="0" y1="${v(shoulder)}" x2="${n(28)}" y2="${v(shoulder)}"/>`,
  );
  // Nose: grille, headlights, indicator.
  s += k.on(
    k.SIDE(x1, 29, shoulder),
    `<rect class="grille" x="8.5" y="3" width="11" height="11" rx="1"/>` +
      [5, 7.5, 10, 12.5]
        .map((g) => `<line class="detail" x1="9.5" y1="${g}" x2="18.5" y2="${g}"/>`)
        .join("") +
      `<rect class="lamp lit head" x="1.6" y="9" width="5.6" height="4" rx="1"/>` +
      `<rect class="lamp lit head" x="20.8" y="9" width="5.6" height="4" rx="1"/>` +
      `<rect class="lamp" x="1.6" y="5" width="3" height="2"/><rect class="lamp" x="23.4" y="5" width="3" height="2"/>`,
  );
  // Bumper and mirror.
  s += k.box(x1, 0.5, 9, 2.5, 29, 5);
  s +=
    k.box(x + 25, 29, shoulder + 1, 1.2, 2.5, 1) + k.box(x + 24.6, 31.5, shoulder - 1, 2, 1.6, 9);
  return s;
}

export function truck(): Figure {
  const k = frame(
    [
      [-26, -6, -3],
      [138, -6, -3],
      [-26, 44, -3],
      [138, 44, -3],
      [0, 0, 55],
      [-36.5, 44, -3],
    ],
    0.03,
  );
  const id = "truck";
  let s = road(k, id, -26, 138);
  s += beams(k, id, 102, 36);
  // Chassis rail and fuel tank, under the box.
  s += k.box(4, 7, 10, 94, 16, 5, "chassis");
  s += k.box(40, 21, 8.5, 18, 6, 6.5);
  s += k.on(
    k.FRONT(40, 27, 15),
    `<line class="detail" x1="2" y1="2" x2="16" y2="2"/><line class="detail" x1="2" y1="4.5" x2="16" y2="4.5"/>`,
  );
  // Cargo box: ribs, rails, the lit CT-e tag.
  s += k.box(0, 0, 15, 69, 30, 40);
  s += k.slits(k.FRONT(0, 30, 55), 5.75, 63.25, 5.75, 3.5, 36.5);
  s += k.on(
    k.FRONT(0, 30, 55),
    `<line class="rail" x1="0" y1="3.5" x2="69" y2="3.5"/><line class="rail" x1="0" y1="36.5" x2="69" y2="36.5"/>` +
      `<rect class="tag lit" x="16.5" y="11" width="36" height="17" rx="1.6"/>` +
      `<text class="scr dark tag-t" x="34.5" y="22.6" text-anchor="middle">CT-e</text>`,
  );
  s += k.on(k.TOP(0, 0, 55), `<rect class="detail" x="2" y="2" width="65" height="26" rx="1"/>`);
  s += cab(k, 71, 44, 51, 86);
  // Mud flap behind the rear wheel, then the wheels.
  s += k.rect(k.FRONT(8.6, 30.5, 14), 1.2, 9.5, "flap");
  s += wheel(k, 18, 30.5) + wheel(k, 86, 30.5);
  return { name: "truck", svg: s, viewBox: k.viewBox };
}
