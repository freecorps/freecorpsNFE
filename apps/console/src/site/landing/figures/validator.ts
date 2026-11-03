import { frame, paper, plate, type Figure, type K } from "./kit.ts";

// Station 2: a short belt indexes sheets through a scanning arch. The sheet
// that stops under the arch is read by a light curtain, the console reports
// the schema result and the sheet leaves checked. Shared station frame: plate
// 184 x 92, same camera and scale as intake, transmitter and delivery.
const BELT_Z = 18;
const PITCH = 36;
const GATE = 92; // x of the curtain plane and of the scanned sheet's centre
const SLOTS = [GATE - 2 * PITCH, GATE - PITCH, GATE, GATE + PITCH, GATE + 2 * PITCH];
const ENTRY = 34; // feeder face: sheets exist only at x >= ENTRY
const EXIT = 147; // bin wall: and only at x <= EXIT

export function validator(): Figure {
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

  // Console behind the belt: slanted readout facing the viewer.
  s += consoleUnit(k);

  // Wire from the console to the arch, on the plate.
  s += k.path(
    [
      [120, 30, 8.2],
      [120, 36, 8.2],
      [96, 36, 8.2],
    ],
    "wire hot",
  );

  // Feeder: a hopper the plain sheets come out of, slot on its x-max face.
  s += k.box(6, 36, 8, 28, 44, 26);
  s += k.on(
    k.SIDE(34, 80, 34),
    `<rect class="slot" x="5" y="13" width="34" height="3" rx="1"/>` +
      `<text class="label" x="22" y="8" text-anchor="middle">ENTRADA</text>`,
  );
  s += k.slits(k.TOP(6, 36, 34), 6, 22, 4, 6, 38);

  // Far post of the arch stands behind the belt.
  s += k.box(GATE - 3, 34, 8, 6, 6, 44);

  // Belt bed and moving surface (ribs clipped to the belt, one pitch = 4 ribs).
  s += k.box(34, 40, 8, 112, 36, BELT_Z - 8);
  s += k.rect(k.TOP(34, 42, BELT_Z), 112, 32, "belt", 1);
  s += k.on(
    k.TOP(34, 42, BELT_Z),
    `<clipPath id="validator-belt"><rect width="112" height="32"/></clipPath>` +
      `<g clip-path="url(#validator-belt)"><g class="ribs">` +
      Array.from(
        { length: 17 },
        (_, i) =>
          `<line class="detail" x1="${i * 9 - 36 + 4}" y1="1" x2="${i * 9 - 36 + 4}" y2="31"/>`,
      ).join("") +
      `</g></g>`,
  );
  s += k.on(
    k.FRONT(34, 76, BELT_Z),
    Array.from(
      { length: 7 },
      (_, i) => `<circle class="detail" cx="${8 + i * 16}" cy="5" r="2.4"/>`,
    ).join(""),
  );

  s += sheets(k);

  // The light curtain hangs in the x = GATE plane, across the belt.
  const curtain = k.plane([GATE, 76, 50], [0, -1, 0], [0, 0, -1]);
  s += k.on(
    curtain,
    `<g class="veil"><rect class="veil-sheet" x="0" y="0" width="36" height="${50 - BELT_Z}"/>` +
      `<line class="veil-line" x1="0" y1="0" x2="36" y2="0"/></g>`,
  );

  // Near post and the lintel with its emitter strip.
  s += k.box(GATE - 3, 76, 8, 6, 6, 44);
  s += k.box(GATE - 4, 34, 52, 8, 48, 7);
  s += k.rect(k.SIDE(GATE + 4, 82, 59), 48, 7, "face side");
  s += k.on(
    k.SIDE(GATE + 4, 82, 59),
    `<rect class="emitter" x="4" y="2.4" width="40" height="2.2"/>`,
  );
  s += k.on(
    k.FRONT(GATE - 4, 82, 59),
    `<circle class="led hot gate-led" cx="4" cy="3.5" r="1.4"/>`,
  );

  // Exit bin: validated sheets drop into it, top sheet lit and checked.
  s += k.box(146, 34, 8, 32, 48, 18);
  s += k.rect(k.TOP(150, 38, 26), 24, 40, "face recess", 1);
  s += paper(k, 150, 42, 26.4, 0, "lit", "check");
  s += k.on(
    k.FRONT(146, 82, 26),
    `<text class="label" x="16" y="11" text-anchor="middle">OK</text>`,
  );
  return { name: "validator", svg: s, viewBox: k.viewBox };
}

function consoleUnit(k: K) {
  let s = k.box(112, 6, 8, 44, 24, 14);
  // Sloped reading face from the deck to a raised back edge.
  const x0 = 112;
  const x1 = 156;
  s += k.poly(
    [
      [x1, 6, 46],
      [x1, 30, 22],
      [x1, 6, 22],
    ],
    "face side",
  );
  const slope = k.plane([x0, 6, 46], [1, 0, 0], [0, 24 / 34, -24 / 34]);
  s += k.poly(
    [
      [x0, 6, 46],
      [x1, 6, 46],
      [x1, 30, 22],
      [x0, 30, 22],
    ],
    "face top",
  );
  s += k.on(
    slope,
    `<g class="console" data-console="">` +
      `<rect class="glass hot" x="3" y="3" width="38" height="27" rx="1.5"/>` +
      `<text class="scr" x="6" y="9">XSD 1.01</text>` +
      `<rect class="bar-track" x="6" y="11.5" width="32" height="1.8"/>` +
      `<rect class="scr-bar bar" x="6" y="11.5" width="32" height="1.8"/>` +
      `<text class="scr big res-ok" x="6" y="20.5">0 erros</text>` +
      `<text class="scr big res-run" x="6" y="20.5">lendo</text>` +
      `<text class="scr count" x="6" y="27"></text>` +
      `</g>`,
  );
  s += k.on(
    k.FRONT(112, 30, 22),
    Array.from(
      { length: 4 },
      (_, i) => `<rect class="key" x="${5 + i * 9}" y="4" width="6" height="4" rx="0.8"/>`,
    ).join("") + `<circle class="led hot" cx="40" cy="6" r="1.3"/>`,
  );
  return s;
}

// Five slots one pitch apart; every sheet advances one pitch per cycle, so the
// reset is invisible. Slot 1 is plain until the scan, slot 2 onward checked.
function sheets(k: K) {
  const [x0, y0] = k.P(ENTRY, -200, BELT_Z);
  const [x1, y1] = k.P(ENTRY, 300, BELT_Z);
  const [x2, y2] = k.P(EXIT, 300, BELT_Z);
  const [x3, y3] = k.P(EXIT, -200, BELT_Z);
  let s =
    `<clipPath id="validator-entry"><path d="M${x0} ${y0}L${x1} ${y1}L${x2} ${y2}L${x3} ${y3}Z"/></clipPath>` +
    `<g clip-path="url(#validator-entry)">`;
  SLOTS.forEach((cx, i) => {
    const sheet = (cls: string, mark: "" | "check") =>
      paper(k, cx - 12, 42, BELT_Z + 0.4, 0, cls, mark);
    s += `<g class="ride">`;
    if (i < 1) s += sheet("raw", "");
    else if (i === 1)
      s += `<g class="plain-copy">${sheet("raw", "")}</g><g class="checked-copy">${sheet("lit", "check")}</g>`;
    else s += sheet("lit", "check");
    s += `</g>`;
  });
  return `${s}</g>`;
}
