import { frame, plate, type Figure, type K, type Point } from "./kit.ts";

// Hero: a fiscal production line. A messy pile of XML feeds a belt; an arch
// scanner checks each sheet against the XSD, a C-frame press stamps the
// signature seal, the sheet lands on a lit stack in the output tray (the JSON)
// and a lattice mast transmits it to the tax authority, whose windows answer.
//
// Layout (x along the belt, y toward the viewer, z up):
//   bin x 8..60, belt x 60..244 (y 46..84, top z 24), gate arch at x 104,
//   press head over x 146..174, tray x 248..296, mast at (246, 18),
//   SEFAZ on its own plate behind (y -118..-46), façade facing +y.

const BELT_Z = 24;
const SHEET_Z = BELT_Z + 0.4;
const T = 1.4; // sheet thickness in the output stack
const STACK = 9; // static sheets in the tray

// A sheet of paper, 24 x 32 in its plane: printed lines, optional seal / check.
function sheet(cls = "", seal = false, check = false) {
  const lines = [19, 13, 19, 10, 16]
    .map((end, i) => `<line class="ink" x1="4" y1="${5 + i * 4}" x2="${end}" y2="${5 + i * 4}"/>`)
    .join("");
  const mark = seal
    ? `<circle class="seal-mark" cx="17" cy="26" r="4"/><circle class="seal-ring" cx="17" cy="26" r="2"/>`
    : "";
  const tick = check ? `<polyline class="check" points="4,26 7,29 12,23"/>` : "";
  return `<g class="sheet ${cls}"><rect class="paper" width="24" height="32" rx="0.8"/>${lines}${mark}${tick}</g>`;
}

// A sheet leaning in the pile: bottom edge centred at `base`, turned `turn`
// degrees in plan, raised `lean` degrees from the horizontal.
function leaning(k: K, base: Point, turn: number, lean: number) {
  const a = (turn * Math.PI) / 180;
  const e = (lean * Math.PI) / 180;
  const u: Point = [Math.cos(a), Math.sin(a), 0];
  const m: Point = [-Math.sin(a), Math.cos(a), 0];
  const v: Point = [m[0] * Math.cos(e), m[1] * Math.cos(e), -Math.sin(e)];
  const o: Point = [
    base[0] - 12 * u[0] - 32 * v[0],
    base[1] - 12 * u[1] - 32 * v[1],
    base[2] - 32 * v[2],
  ];
  return k.on(k.plane(o, u, v), sheet());
}

// A flat sheet on a top plane, turned about its centre.
function flat(k: K, cx: number, cy: number, z: number, rot: number, cls = "") {
  return k.on(k.TOP(cx - 12, cy - 16, z), `<g transform="rotate(${rot} 12 16)">${sheet(cls)}</g>`);
}

// Classical public building, façade toward +y (the FRONT plane): three steps,
// a cella with a door and windows, six columns, a frieze with its name and a
// pediment whose ridge runs back along y.
function sefaz(k: K) {
  const x = 196;
  const y = -112;
  let s = "";
  s +=
    k.box(x, y, 6, 104, 62, 3) +
    k.box(x + 3, y + 3, 9, 98, 56, 3) +
    k.box(x + 6, y + 6, 12, 92, 50, 3);
  s += k.slits(k.FRONT(x, y + 62, 9), 0, 0, 1, 0, 104, false);
  // Cella.
  s += k.box(x + 14, y + 12, 15, 76, 30, 42);
  s += k.on(
    k.FRONT(x + 14, y + 42, 57),
    [8, 22, 48, 62]
      .map((wx) => `<rect class="window answer" x="${wx - 4}" y="10" width="8" height="12"/>`)
      .join("") +
      `<rect class="door answer" x="31" y="16" width="14" height="26" rx="0.8"/>` +
      `<line class="detail" x1="38" y1="16" x2="38" y2="42"/>` +
      `<rect class="window answer" x="${8 - 4}" y="28" width="8" height="8"/><rect class="window answer" x="${62 - 4}" y="28" width="8" height="8"/>`,
  );
  s += k.slits(k.SIDE(x + 90, y + 42, 57), 4, 26, 5.5, 8, 30);
  // Columns: base, shaft with flutes, capital.
  const cy = y + 50;
  for (let i = 0; i < 6; i++) {
    const cx = x + 10 + i * 16.4;
    s += k.box(cx - 3.5, cy - 3.5, 15, 7, 7, 2);
    s += k.box(cx - 2.5, cy - 2.5, 17, 5, 5, 36);
    s += k.slits(k.FRONT(cx - 2.5, cy + 2.5, 53), 1.7, 3.4, 1.7, 1, 35);
    s += k.box(cx - 3.5, cy - 3.5, 53, 7, 7, 3);
  }
  // Entablature with the name on the frieze.
  const ex = x + 4;
  const ey = y + 4;
  const ew = 96;
  const ed = 54;
  s += k.box(ex, ey, 56, ew, ed, 10);
  s += k.on(
    k.FRONT(ex, ey + ed, 66),
    `<line class="detail" x1="0" y1="2.4" x2="${ew}" y2="2.4"/><line class="detail" x1="0" y1="8" x2="${ew}" y2="8"/>` +
      `<text class="plant-name" x="${ew / 2}" y="6.9" text-anchor="middle">SEFAZ · ADN</text>`,
  );
  // Roof: two slopes, then the pediment on the façade plane.
  const e = 66;
  const r = 98;
  const mx = ex + ew / 2;
  const fy = ey + ed;
  s += k.poly(
    [
      [ex, fy, e],
      [mx, fy, r],
      [mx, ey, r],
      [ex, ey, e],
    ],
    "face roof",
  );
  s += k.poly(
    [
      [mx, fy, r],
      [ex + ew, fy, e],
      [ex + ew, ey, e],
      [mx, ey, r],
    ],
    "face roof-side",
  );
  s += k.slits(k.plane([mx, ey, r], [1, 0, -32 / 48], [0, 1, 0]), 6, 48, 6, 0, ed);
  s += k.poly(
    [
      [ex, fy, e],
      [ex + ew, fy, e],
      [mx, fy, r],
    ],
    "face front pediment",
  );
  s += k.poly(
    [
      [ex + 8, fy, e + 2],
      [ex + ew - 8, fy, e + 2],
      [mx, fy, r - 5.6],
    ],
    "tympanum",
  );
  s += k.on(
    k.FRONT(mx, fy, e),
    `<circle class="emblem" cx="0" cy="-12" r="5"/><circle class="seal-ring" cx="0" cy="-12" r="2.2"/>`,
  );
  return s;
}

// Lattice radio mast: four tapering legs, X bracing, a platform, a whip and a
// beacon on top.
function mast(k: K, back: boolean) {
  const cx = 246;
  const cy = 18;
  const levels = [8, 36, 60, 82, 102, 120];
  const half = (z: number) => 10 - ((z - 8) / (120 - 8)) * 6.5;
  const corner = (z: number, sx: number, sy: number): Point => [
    cx + sx * half(z),
    cy + sy * half(z),
    z,
  ];
  let s = "";
  const face = (a: [number, number], b: [number, number], cls: string) => {
    for (let i = 0; i < levels.length - 1; i++) {
      const z0 = levels[i]!;
      const z1 = levels[i + 1]!;
      s += k.path([corner(z0, ...a), corner(z1, ...b)], cls);
      s += k.path([corner(z0, ...b), corner(z1, ...a)], cls);
      s += k.path([corner(z1, ...a), corner(z1, ...b)], cls);
    }
  };
  if (back) {
    // Back faces and the hidden leg first.
    face([-1, -1], [1, -1], "strut back");
    face([-1, -1], [-1, 1], "strut back");
    s += k.path([corner(8, -1, -1), corner(120, -1, -1)], "leg back");
    return s;
  }
  face([-1, 1], [1, 1], "strut");
  face([1, -1], [1, 1], "strut");
  s += k.path([corner(8, 1, -1), corner(120, 1, -1)], "leg");
  s += k.path([corner(8, -1, 1), corner(120, -1, 1)], "leg");
  s += k.path([corner(8, 1, 1), corner(120, 1, 1)], "leg");
  // Footings.
  for (const [sx, sy] of [
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const)
    s += k.box(cx + sx * 10 - 2, cy + sy * 10 - 2, 8, 4, 4, 2);
  // Platform, panel antennas, whip and beacon.
  s += k.box(cx - 6, cy - 6, 120, 12, 12, 3);
  s += k.box(cx + 6, cy - 3, 104, 2, 6, 14);
  s += k.box(cx - 3, cy + 6, 104, 6, 2, 14);
  s += k.box(cx - 1, cy - 1, 123, 2, 2, 16);
  s += `<circle class="beacon-halo" cx="${k.P(cx, cy, 142)[0]}" cy="${k.P(cx, cy, 142)[1]}" r="12"/>`;
  s += `<g class="beacon">${k.rbox(cx - 4, cy - 4, 139, 8, 8, 5, 4, "lit")}</g>`;
  return s;
}

// Numbered callout: leader from a 3D point to a badge at a fixed spot of the
// drawing, label to its right (or left with `end`).
function note(k: K, n: number, at: Point, badge: [number, number], text: string, end = false) {
  const [x, y] = k.P(...at);
  const [qx, qy] = badge;
  return (
    `<g class="callout" data-step="${n}"><line class="leader" x1="${x}" y1="${y}" x2="${qx}" y2="${qy}"/>` +
    `<circle class="leader-dot" cx="${x}" cy="${y}" r="1.8"/><circle class="badge" cx="${qx}" cy="${qy}" r="7"/>` +
    `<text class="badge-n" x="${qx}" y="${qy + 2.7}" text-anchor="middle">${n}</text>` +
    `<text class="callout-t" x="${qx + (end ? -12 : 12)}" y="${qy + 3.2}" text-anchor="${end ? "end" : "start"}">${text}</text></g>`
  );
}

export function plant(): Figure {
  const k = frame(
    [
      [0, 104, 0],
      [300, 104, 0],
      [306, -118, 0],
      [190, -118, 0],
      [246, 18, 144],
      [-30, 104, 40],
      [-20, 0, 60],
      [330, -40, 120],
    ],
    0.02,
  );
  const P = (p: Point) => k.P(...p);
  const pts = (list: Point[]) => list.map((p) => P(p).join(",")).join(" ");
  let s = "";

  // Clip regions. The feed clip shows the traveller only once it has left the
  // bin (x >= 60 on the belt plane); the tray clip shows the stack only above
  // the rim or through the tray opening.
  const op = { x0: 252, x1: 292, y0: 46, y1: 86, z: 18 };
  s +=
    `<defs><clipPath id="plant-feed"><rect transform="${k.TOP(60, -200, SHEET_Z)}" width="500" height="600"/></clipPath>` +
    `<clipPath id="plant-tray"><polygon points="${pts([
      [op.x0, op.y1, op.z],
      [op.x1, op.y1, op.z],
      [op.x1, op.y0, op.z],
      [op.x1, op.y0, 80],
      [op.x0, op.y0, 80],
      [op.x0, op.y1, 80],
    ])}"/></clipPath>` +
    `<clipPath id="plant-belt"><rect transform="${k.TOP(62, 48, BELT_Z)}" width="180" height="34"/></clipPath></defs>`;

  // 4: the tax authority, on its own plate behind the line.
  s += plate(k, 190, -118, 116, 72, 6, 8);
  s += `<g class="st" data-st="4">${sefaz(k)}</g>`;

  // Main plate, with the signal cable from the tray to the mast.
  s += plate(k, 0, 0, 300, 104);
  const cable: Point[] = [
    [270, 42, 8.2],
    [270, 30, 8.2],
    [256, 30, 8.2],
    [256, 28, 10],
    [252, 24, 60],
    [249, 21, 104],
  ];
  s += k.path(cable.slice(0, 4), "wire");

  // Mast (behind the belt) and the press column (behind the belt).
  s += `<g class="st" data-st="4">${mast(k, true)}${mast(k, false)}${k.path(cable.slice(3), "wire")}</g>`;
  s += `<path class="plant-pulse up" pathLength="100" d="M${cable.map((p) => P(p).join(" ")).join("L")}"/>`;

  // 2: gate, back pillar.
  s += `<g class="st" data-st="2">${k.box(100, 36, 8, 8, 8, 56)}${k.slits(k.SIDE(108, 44, 64), 2, 6, 2, 6, 44)}</g>`;

  // 3: press frame: base, column and its control panel.
  let col = k.box(138, 10, 8, 44, 38, 6);
  col += k.box(144, 16, 14, 32, 26, 84);
  col += k.slits(k.SIDE(176, 42, 98), 34, 76, 6, 4, 22, false);
  col += k.slits(k.FRONT(144, 42, 98), 4, 28, 4, 34, 80);
  s += `<g class="st" data-st="3">${col}</g>`;

  // 1: the bin. Body, dark interior, the buried sheets, walls redrawn over
  // them, then the heap on top with a few sheets leaning out.
  let bin = k.box(8, 38, 8, 52, 56, 36);
  bin += k.rect(k.TOP(11, 41, 44), 46, 50, "face recess", 1.5);
  bin += flat(k, 30, 62, 40, -18) + flat(k, 40, 72, 41, 24);
  bin += k.rect(k.FRONT(8, 94, 44), 52, 36, "face front");
  bin += k.rect(k.SIDE(60, 94, 44), 56, 36, "face side");
  bin += k.rect(k.TOP(8, 91, 44), 52, 3, "face top");
  bin += k.rect(k.TOP(57, 38, 44), 3, 56, "face top");
  bin += k.on(
    k.FRONT(8, 94, 44),
    `<rect class="tag" x="12" y="8" width="28" height="11" rx="1"/><text class="plant-tag" x="26" y="15.6" text-anchor="middle">XML</text>` +
      `<line class="detail" x1="4" y1="26" x2="48" y2="26"/><line class="detail" x1="4" y1="30" x2="48" y2="30"/>`,
  );
  bin += k.on(
    k.SIDE(60, 94, 44),
    `<rect class="slot" x="8" y="16" width="40" height="5" rx="1"/><line class="detail" x1="8" y1="26" x2="48" y2="26"/>`,
  );
  bin += leaning(k, [24, 50, 44], 10, 62);
  bin += leaning(k, [44, 52, 44], -24, 52);
  bin += leaning(k, [16, 68, 44], 80, 58);
  bin += flat(k, 30, 58, 45, 14) + flat(k, 44, 66, 46.2, -30) + flat(k, 26, 74, 47.4, 36);
  bin += flat(k, 40, 76, 48.6, -8) + flat(k, 34, 64, 49.8, 58);
  s += `<g class="st bin" data-st="1">${bin}</g>`;

  // Belt: frame, rollers on the front, rubber top and moving slats.
  s += k.box(60, 46, 8, 184, 38, 16);
  s += k.rect(k.TOP(62, 48, BELT_Z), 180, 34, "belt", 1.5);
  s += k.on(
    k.FRONT(60, 84, BELT_Z),
    Array.from(
      { length: 10 },
      (_, i) =>
        `<circle class="roller" cx="${10 + i * 18.2}" cy="7" r="4"/><circle class="screw" cx="${10 + i * 18.2}" cy="7" r="1"/>`,
    ).join(""),
  );
  let slats = "";
  for (let x = 62 - 224; x <= 244; x += 14)
    slats += `<line class="slat" x1="${P([x, 48, BELT_Z])[0]}" y1="${P([x, 48, BELT_Z])[1]}" x2="${P([x, 82, BELT_Z])[0]}" y2="${P([x, 82, BELT_Z])[1]}"/>`;
  s += `<g clip-path="url(#plant-belt)"><g class="slats">${slats}</g></g>`;
  // Belt legs at the far end, so the belt is clearly raised over the tray.
  s += k.rect(k.SIDE(244, 84, BELT_Z), 38, 16, "face side");

  // 5: output tray with the lit stack and the JSON readout.
  let tray = k.box(248, 42, 8, 48, 48, 10);
  tray += k.rect(k.TOP(op.x0, op.y0, op.z), op.x1 - op.x0, op.y1 - op.y0, "face recess", 1);
  let stack = "";
  for (let i = 0; i < STACK; i++)
    stack += k.on(k.TOP(260, 50, 10.4 + i * T), sheet("lit", true, true));
  stack += `<g class="stack-new">${k.on(k.TOP(260, 50, 10.4 + STACK * T), sheet("authorized lit", true, true))}</g>`;
  tray += `<g clip-path="url(#plant-tray)"><g class="stack">${stack}</g></g>`;
  tray += k.on(
    k.FRONT(248, 90, 18),
    `<rect class="glass hot" x="8" y="2" width="32" height="6.4" rx="1"/><text class="scr" x="24" y="6.6" text-anchor="middle">nota.json</text>`,
  );
  s += `<g class="st" data-st="5">${tray}</g>`;

  // The travelling sheet: plain until the press, stamped after it.
  const at = k.TOP(36, 50, SHEET_Z);
  s +=
    `<g clip-path="url(#plant-feed)"><g class="tv-x"><g class="tv-z">` +
    `<g class="tv-plain">${k.on(at, sheet())}</g>` +
    `<g class="tv-seal">${k.on(at, sheet("", true))}</g>` +
    `</g></g></g>`;
  // Frozen story (no motion): one stamped sheet waiting between press and tray.
  s += `<g class="at-rest">${k.on(k.TOP(198, 50, SHEET_Z), sheet("", true))}</g>`;

  // 2: gate, light curtain, front pillar and crossbeam with its readout.
  let gate = k.on(
    k.plane([104, 86, 64], [0, -1, 0], [0, 0, -1]),
    `<g class="curtain-g"><rect class="curtain" width="42" height="40"/>` +
      [6, 12, 18, 24, 30, 36]
        .map((v) => `<line class="ray" x1="0" y1="${v}" x2="42" y2="${v}"/>`)
        .join("") +
      `<line class="sweep" x1="0" y1="0" x2="42" y2="0"/></g>`,
  );
  gate += k.box(100, 86, 8, 8, 8, 56);
  gate += k.slits(k.SIDE(108, 94, 64), 2, 6, 2, 6, 44);
  gate += k.on(
    k.SIDE(108, 94, 64),
    [10, 18, 26, 34, 42]
      .map((v) => `<rect class="led eye" x="2.6" y="${v}" width="2.8" height="2.8"/>`)
      .join(""),
  );
  gate += k.box(98, 34, 64, 12, 62, 10);
  gate += k.on(
    k.SIDE(110, 96, 74),
    `<rect class="glass xsd" x="16" y="2" width="30" height="6" rx="1"/><text class="scr" x="31" y="6.4" text-anchor="middle">XSD ok</text>`,
  );
  s += `<g class="st" data-st="2">${gate}</g>`;

  // 3: press ram (moves): rod, die and head with the seal; then the cylinder
  // housing, the crown arm and the flywheel, which turns once per stroke.
  let ram = k.box(156, 62, 62, 8, 8, 50);
  ram += k.box(150, 56, 44, 20, 20, 4, "die");
  ram += k.box(145, 51, 48, 30, 30, 14);
  ram += k.slits(k.FRONT(145, 81, 62), 3, 9, 3, 2, 12);
  ram += k.slits(k.FRONT(145, 81, 62), 21, 27, 3, 2, 12);
  ram += k.on(
    k.FRONT(145, 81, 62),
    `<circle class="seal lit" cx="15" cy="7" r="4.2"/><circle class="seal-ring" cx="15" cy="7" r="1.9"/>`,
  );
  s += `<g class="st" data-st="3"><g class="ram">${ram}</g>`;
  s += `<path class="plant-flash" d="M${pts([
    [146, 50, SHEET_Z],
    [174, 50, SHEET_Z],
    [174, 82, SHEET_Z],
    [146, 82, SHEET_Z],
  ]).replace(/ /g, "L")}Z"/>`;
  s += k.box(150, 56, 80, 20, 20, 18);
  s += k.slits(k.FRONT(150, 76, 98), 3, 17, 3.5, 2, 16);
  s += k.box(142, 14, 98, 36, 70, 14);
  s += k.on(
    k.FRONT(142, 84, 112),
    `<rect class="glass hot" x="5" y="3.6" width="26" height="6.6" rx="1"/><text class="scr" x="18" y="8.4" text-anchor="middle">assina</text>`,
  );
  s += k.slits(k.SIDE(178, 84, 112), 6, 64, 6, 3, 11);
  // Flywheel on an axle off the column's side.
  s += k.box(176, 26, 74, 6, 6, 6);
  const spokes = [0, 60, 120, 180, 240, 300]
    .map((a) => {
      const t = (a * Math.PI) / 180;
      return `<line class="spoke" x1="${(4 * Math.cos(t)).toFixed(2)}" y1="${(4 * Math.sin(t)).toFixed(2)}" x2="${(15 * Math.cos(t)).toFixed(2)}" y2="${(15 * Math.sin(t)).toFixed(2)}"/>`;
    })
    .join("");
  s += k.on(
    k.SIDE(182, 29, 77),
    `<circle class="fly-rim" r="19"/><g class="fly">${spokes}<circle class="fly-inner" r="15"/><circle class="fly-mark" cx="0" cy="-17" r="1.3"/></g><circle class="hub" r="4"/><circle class="screw" r="1.4"/>`,
  );
  s += `</g>`;

  // 4: beam from the beacon to the pediment emblem, with the request and the
  // answer travelling along it.
  const beam: Point[] = [
    [246, 18, 141],
    [248, -58, 78],
  ];
  const back: Point[] = [beam[1]!, beam[0]!];
  s +=
    `<g class="beam">${k.path(beam, "beam-halo")}${k.path(beam, "beam-core")}` +
    `${k.path(beam, "plant-pulse out")}${k.path(back, "plant-pulse in")}</g>`;

  // Callouts, numbered along the story; badges placed in the empty margins.
  s += note(k, 1, [22, 94, 26], [22, 196], "XML de todo jeito");
  s += note(k, 2, [104, 40, 72], [170, 24], "confere no XSD", true);
  s += note(k, 3, [160, 48, 112], [214, 34], "carimba o hash");
  s += note(k, 4, [248, -96, 84], [408, 30], "em construção");
  s += note(k, 5, [296, 70, 12], [340, 272], "JSON normalizado");
  return { name: "plant", svg: s, viewBox: k.viewBox };
}
