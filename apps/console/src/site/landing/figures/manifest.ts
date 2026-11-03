import { frame, type Figure } from "./kit.ts";
import { beams, cab, road, wheel } from "./truck.ts";

// MDF-e: a tractor unit pulling a box semi-trailer whose side carries the trip
// manifest as a lit board. The board fills in line by line, is closed with a
// check, and starts over; the road slides under the rig. Same wheels, cab and
// road as the CT-e truck, so the two read as one fleet at one scale.
export function manifest(): Figure {
  const k = frame(
    [
      [-6, -6, -3],
      [168, -6, -3],
      [-6, 44, -3],
      [168, 44, -3],
      [0, 0, 55],
    ],
    0.03,
  );
  const id = "manifest";
  let s = road(k, id, -6, 168);
  s += beams(k, id, 154, 18);
  // Tractor chassis and fifth wheel (under the trailer's nose).
  s += k.box(100, 7, 10, 50, 16, 5, "chassis");
  s += k.box(103, 5, 15, 17, 20, 3);
  // Trailer: chassis, landing gear, box, ribs and the manifest board.
  s += k.box(2, 7, 13, 106, 16, 5, "chassis");
  s += k.box(87, 23, 3.4, 4, 3, 1.2) + k.box(88, 24, 4.6, 2, 2, 13.4);
  s += k.box(0, 0, 18, 110, 30, 37);
  s += k.slits(k.FRONT(0, 30, 55), 5.5, 104.5, 5.5, 3.5, 33.5);
  const lines = [
    [7, 38],
    [7, 31],
    [7, 35],
    [7, 26],
  ];
  s += k.on(
    k.FRONT(0, 30, 55),
    `<line class="rail" x1="0" y1="3.5" x2="110" y2="3.5"/><line class="rail" x1="0" y1="33.5" x2="110" y2="33.5"/>` +
      `<g class="board-g" transform="translate(29 6.5)">` +
      `<rect class="board lit" width="52" height="24" rx="1.6"/>` +
      `<text class="scr dark m-head" x="4.5" y="6.6">MDF-e</text>` +
      `<line class="m-rule" x1="4.5" y1="8.6" x2="47.5" y2="8.6"/>` +
      lines
        .map(
          ([a, b], i) =>
            `<line class="m-line m-l${i}" pathLength="1" x1="${a! - 2.5}" y1="${12 + i * 3.4}" x2="${b! - 2.5}" y2="${12 + i * 3.4}"/>`,
        )
        .join("") +
      `<circle class="m-seal" cx="44" cy="17" r="4.6"/>` +
      `<polyline class="m-check" pathLength="1" points="41.8,17.2 43.4,18.8 46.4,15.4"/>` +
      `</g>`,
  );
  s += k.on(k.TOP(0, 0, 55), `<rect class="detail" x="2" y="2" width="106" height="26" rx="1"/>`);
  // Tractor: tank, exhaust stack, cab with a tall sleeper roof.
  s += k.box(126, 21.5, 8.5, 12, 6, 6.5);
  s += k.box(120, 25.5, 15, 2, 2, 41, "stack");
  s += cab(k, 124, 46, 54, 142);
  s += k.rect(k.FRONT(102.6, 30.5, 14), 1.2, 9.5, "flap");
  s += wheel(k, 14, 30.5) + wheel(k, 30, 30.5) + wheel(k, 112, 30.5) + wheel(k, 142, 30.5);
  return { name: "manifest", svg: s, viewBox: k.viewBox };
}
