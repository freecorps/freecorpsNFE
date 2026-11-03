import { frame, type Figure, type K } from "./kit.ts";

// One taped carton: tape across the top and down both ends, a hand hole on
// the end panel and the "this side up" arrows on the long face.
function carton(k: K, x: number, y: number, z: number, w: number, d: number, h: number) {
  const { box, on, TOP, SIDE, FRONT } = k;
  const t = 5;
  return (
    box(x, y, z, w, d, h) +
    on(
      TOP(x, y, z + h),
      `<rect class="tape" x="0" y="${d / 2 - t / 2}" width="${w}" height="${t}"/>`,
    ) +
    on(
      SIDE(x + w, y + d, z + h),
      `<rect class="tape" x="${d / 2 - t / 2}" y="0" width="${t}" height="7"/>` +
        `<rect class="hole" x="${d / 2 - 6}" y="${h * 0.42}" width="12" height="3.6" rx="1.8"/>`,
    ) +
    on(
      FRONT(x, y + d, z + h),
      `<line class="detail" x1="0" y1="2.2" x2="${w}" y2="2.2"/>` +
        `<path class="mark" d="M${w - 11} ${h - 4}v-7m-2.2 2.4l2.2 -2.4 2.2 2.4M${w - 5} ${h - 4}v-7m-2.2 2.4l2.2 -2.4 2.2 2.4M${w - 13.5} ${h - 2.4}h11"/>`,
    )
  );
}

// NF-e: a pallet of taped cartons on a hand pallet truck. The NF-e label on
// the stack is lit; a scanner line reads it and the "lida" mark comes on.
// Click (or scroll into view) and the last carton is set onto the stack.
export function crate(): Figure {
  const k = frame(
    [
      [0, 0, 0],
      [132, 0, 0],
      [0, 96, 0],
      [132, 96, 0],
      [131, 40, 86],
      [4, 4, 72],
    ],
    0.04,
  );
  const { box, on, poly, FRONT, SIDE, TOP } = k;
  let s = "";

  // Pallet: top deck, blocks and fork pockets on both visible faces.
  s += box(0, 0, 0, 104, 96, 12);
  const pallet = (len: number, pockets: [number, number][]) =>
    `<line class="detail" x1="0" y1="3" x2="${len}" y2="3"/><line class="detail" x1="0" y1="9.5" x2="${len}" y2="9.5"/>` +
    pockets
      .map(([a, b]) => `<rect class="recess" x="${a}" y="3" width="${b - a}" height="6.5"/>`)
      .join("");
  s += on(
    FRONT(0, 96, 12),
    pallet(104, [
      [12, 44],
      [60, 92],
    ]),
  );
  s += on(
    SIDE(104, 96, 12),
    pallet(96, [
      [12, 40],
      [56, 84],
    ]),
  );
  s += on(
    TOP(0, 0, 12),
    [0, 13, 26, 39, 52, 65, 78, 91]
      .map((x) => `<line class="detail" x1="${x + 6.5}" y1="0" x2="${x + 6.5}" y2="96"/>`)
      .join(""),
  );

  // Two layers of cartons, back to front. The front-right carton of the top
  // layer is the one being set down (class "drop").
  s += carton(k, 4, 4, 12, 48, 44, 30) + carton(k, 52, 4, 12, 48, 44, 30);
  s += carton(k, 4, 48, 12, 48, 44, 30) + carton(k, 52, 48, 12, 48, 44, 30);
  s += carton(k, 4, 4, 42, 48, 44, 30) + carton(k, 52, 4, 42, 48, 44, 30);
  s += carton(k, 4, 48, 42, 48, 44, 30);

  // The NF-e label on the front of the top-left carton, with the scan line.
  const bars = [
    0, 1.4, 2.2, 3.8, 4.6, 5.4, 7, 8.4, 9.2, 10.8, 12.2, 13, 14.6, 16, 17.4, 18.2, 19.8, 21, 22.6,
    23.4, 25,
  ]
    .map(
      (x, i) =>
        `<rect class="bar" x="${(9 + x).toFixed(1)}" y="13.4" width="${i % 3 ? 0.7 : 1.2}" height="6"/>`,
    )
    .join("");
  // A dim printed copy underneath and the lit copy on top, revealed by a clip
  // that follows the scan line (left to right), so the label lights as read.
  const print = (ink: string) =>
    `<text class="scr big-code ${ink}" x="9" y="11.4">NF-e 55</text>${bars.replaceAll('class="bar"', `class="bar ${ink}"`)}` +
    `<text class="scr tiny ${ink}" x="9" y="23.2">DANFE</text>`;
  s += on(
    FRONT(4, 92, 72),
    `<clipPath id="fig-crate-wipe"><rect class="wipe" x="6" y="3" width="36" height="24"/></clipPath>` +
      `<rect class="tag label-dim" x="6" y="5" width="36" height="20" rx="1.2"/>${print("ink-dim")}` +
      `<g clip-path="url(#fig-crate-wipe)"><rect class="tag lit label-card" x="6" y="5" width="36" height="20" rx="1.2"/>${print("ink-lit")}` +
      `<g class="read"><circle class="read-dot" cx="38.4" cy="18.8" r="2.5"/><polyline class="read-tick" points="37.1,18.8 38.1,19.9 39.9,17.7"/></g></g>` +
      `<g class="scan"><rect class="scan-halo" x="-2.5" y="2" width="5" height="26"/><line class="scan-core" x1="0" y1="2" x2="0" y2="28"/></g>`,
  );

  s += `<g class="drop">${carton(k, 52, 48, 42, 48, 44, 30)}</g>`;

  // Hand pallet truck: forks in the side pockets, heel, pump body on its
  // steering wheel, and the upright handle with its loop grip.
  s += box(104, 18, 3.5, 8, 16, 4) + box(104, 62, 3.5, 8, 16, 4);
  s += box(112, 16, 2, 7, 64, 8);
  s += box(116, 37, 0, 14, 22, 20);
  s += on(
    SIDE(130, 59, 20),
    `<rect class="detail" x="4" y="3" width="14" height="8" rx="1"/><line class="detail" x1="11" y1="11" x2="11" y2="15"/>` +
      `<circle class="wheel" cx="11" cy="16.4" r="3.6"/><circle class="hub" cx="11" cy="16.4" r="1.2"/>`,
  );
  s += on(FRONT(116, 59, 20), `<line class="detail" x1="3" y1="4" x2="11" y2="4"/>`);
  const shaft = (y: number, x0: number, x1: number) =>
    poly(
      [
        [x0, y, 20],
        [x1, y, 20],
        [x1 + 6, y, 74],
        [x0 + 6, y, 74],
      ],
      "face handle",
    );
  s += shaft(49.5, 121.5, 124.5);
  s += poly(
    [
      [124.5, 46.5, 20],
      [124.5, 49.5, 20],
      [130.5, 49.5, 74],
      [130.5, 46.5, 74],
    ],
    "face handle-side",
  );
  s += on(
    SIDE(130.5, 56, 86),
    `<path class="face handle-side" fill-rule="evenodd" d="M0 3a3 3 0 0 1 3 -3h10a3 3 0 0 1 3 3v9h-16zM2.6 3.6v5.8h10.8v-5.8z"/>` +
      `<rect class="face handle-side" x="6.5" y="9.4" width="3" height="3"/>`,
  );
  return { name: "crate", svg: s, viewBox: k.viewBox };
}
