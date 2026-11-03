import { frame, plate, type Figure, type K, type Point } from "./kit.ts";

// Station 4: the webhook as a pneumatic post. A dispatch box fires a capsule
// up a tube on two supports and across into your system's tower; the floors
// light from the receiving floor outward and the box reads 200. Shared
// station frame: plate 184 x 92.
const BOX = { x: 12, y: 54, w: 34, d: 32, h: 20 };
const TOWER = { x: 116, y: 10, w: 44, d: 38, h: 76 };
const TUBE_Z = 60;
const TUBE_Y = 70; // the run leaves straight from the box's collar
const ENTRY_X = 136;
const FLOORS = 7; // above the lobby, 9.1 units each

export function delivery(): Figure {
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
  s += tower(k);
  s += dispatch(k);
  // Supports under the run, then the tube itself.
  for (const x of [70, 108]) {
    s += k.box(x - 4, TUBE_Y - 4, 8, 8, 8, 2);
    s += k.box(x - 1.2, TUBE_Y - 1.2, 10, 2.4, 2.4, TUBE_Z - 14);
    s += k.box(x - 2.5, TUBE_Y - 2.5, TUBE_Z - 4.5, 5, 5, 1.5);
  }
  const cx = BOX.x + BOX.w / 2;
  const cy = BOX.y + BOX.d / 2;
  const tube: Point[] = [
    [cx, cy, BOX.h + 8 + 6],
    [cx, TUBE_Y, TUBE_Z],
    [ENTRY_X, TUBE_Y, TUBE_Z],
    [ENTRY_X, TOWER.y + TOWER.d, TUBE_Z],
  ];
  s += `<g class="tube-run">${k.path(tube, "tube-shell")}${k.path(tube, "tube-bore")}${k.path(tube, "tube-core")}${k.path(tube, "capsule")}</g>`;
  // Couplings where the tube meets the box and the tower.
  s += k.box(cx - 5, cy - 5, BOX.h + 8, 10, 10, 6);
  s += k.rect(k.FRONT(ENTRY_X - 6, TOWER.y + TOWER.d + 0.2, TUBE_Z + 6), 12, 12, "face front", 1);
  s += k.on(
    k.FRONT(ENTRY_X - 6, TOWER.y + TOWER.d + 0.2, TUBE_Z + 6),
    `<circle class="detail" cx="6" cy="6" r="4.4"/>`,
  );
  return { name: "delivery", svg: s, viewBox: k.viewBox };
}

// Dispatch box: tube collar on top, a small readout and the launch hatch.
function dispatch(k: K) {
  const { x, y, w, d, h } = BOX;
  let s = k.box(x, y, 8, w, d, h);
  s += k.on(
    k.FRONT(x, y + d, 8 + h),
    `<rect class="glass hot" x="4" y="3.5" width="18" height="7.5" rx="1"/>` +
      `<text class="scr st-post" x="6" y="8.8">POST</text>` +
      `<text class="scr st-ok" x="6" y="8.8">200</text>` +
      `<circle class="led hot ack" cx="27" cy="7.2" r="1.5"/>` +
      `<text class="label" x="4" y="17">WEBHOOK</text>`,
  );
  s += k.on(
    k.SIDE(x + w, y + d, 8 + h),
    `<rect class="detail" x="5" y="4" width="22" height="12" rx="1.5"/>` +
      `<line class="detail" x1="5" y1="10" x2="27" y2="10"/>`,
  );
  return s;
}

// Your system: a tower with a lobby, seven lit floors and roof plant.
function tower(k: K) {
  const { x, y, w, d, h } = TOWER;
  const top = 8 + h;
  let s = k.box(x, y, 8, w, d, h);
  const floorZ = (f: number) => 8 + 12 + (f + 1) * 9.1; // top of floor f
  const row = (n: number, width: number, f: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `<rect class="window lit floor f${f}" x="${4 + (i * (width - 8)) / n}" y="0" width="${(width - 8) / n - 3}" height="5.6"/>`,
    ).join("");
  for (let f = 0; f < FLOORS; f++) {
    const z = floorZ(f) - 1.6;
    s += k.on(k.FRONT(x, y + d, z), row(4, w, f));
    s += k.on(k.SIDE(x + w, y + d, z), row(3, d, f));
  }
  // Lobby: door and the sign.
  s += k.on(
    k.FRONT(x, y + d, 20),
    `<line class="detail" x1="0" y1="0.6" x2="${w}" y2="0.6"/>` +
      `<text class="label" x="${w / 2}" y="5.6" text-anchor="middle">SEU SISTEMA</text>` +
      `<rect class="door lit" x="${w / 2 - 5}" y="7" width="10" height="5"/>`,
  );
  // Roof: parapet line, a plant box and a mast.
  s += k.on(
    k.TOP(x, y, top),
    `<rect class="detail" x="2" y="2" width="${w - 4}" height="${d - 4}"/>`,
  );
  s += k.box(x + 8, y + 8, top, 16, 12, 5);
  s += k.slits(k.FRONT(x + 8, y + 20, top + 5), 2, 14, 3, 1, 4);
  s += k.box(x + 32, y + 10, top, 2, 2, 9);
  s += k.on(k.TOP(x + 32, y + 10, top + 9), `<circle class="led hot" cx="1" cy="1" r="1.4"/>`);
  return s;
}
