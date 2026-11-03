import { frame, plate, type Figure, type K, type Point } from "./kit.ts";

// Stripe: a card machine (maquininha) wired to the NFS-e issuer. Paying makes
// the sequence run: the card goes into the chip slot, the machine approves,
// a pulse rides the cable, the issuer reports invoice.paid and prints the
// note onto its tray. Without JS or with reduced motion the end state shows.

const n = (v: number) => Number(v.toFixed(2));

// Smooth 3D curve through control points (Catmull-Rom), sampled for k.path.
function curve(pts: Point[], steps = 10): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(i + 2, pts.length - 1)]!;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        [0, 1, 2].map((j) =>
          n(
            0.5 *
              (2 * p1[j]! +
                (-p0[j]! + p2[j]!) * t +
                (2 * p0[j]! - 5 * p1[j]! + 4 * p2[j]! - p3[j]!) * t2 +
                (-p0[j]! + 3 * p1[j]! - 3 * p2[j]! + p3[j]!) * t3),
          ),
        ) as Point,
      );
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

// Screen-space clip keeping only what lies in front of the plane y = y0
// (seen at height z), for parts that slide out of a slot.
function frontOf(k: K, id: string, y0: number, z: number) {
  const pts = [k.P(-400, y0, z), k.P(600, y0, z), k.P(600, y0 + 600, z), k.P(-400, y0 + 600, z)];
  return `<clipPath id="${id}"><path d="M${pts.map((p) => p.join(" ")).join("L")}Z"/></clipPath>`;
}

// The card machine: body, printer hump with a receipt stub, screen, keypad,
// chip slot on the near end. Footprint x 20..64, y 4..86, deck at z 17.
function machine(k: K) {
  let s = k.rbox(20, 4, 8, 44, 82, 9, 6);
  s += k.on(
    k.FRONT(26, 86, 17),
    `<rect class="recess" x="6" y="4.4" width="20" height="2.2" rx="1"/>`,
  );
  // Printer hump with the receipt stub standing out of its tear slot.
  s += k.rbox(20, 4, 17, 44, 24, 7, 6);
  s += k.on(
    k.TOP(20, 4, 24),
    `<line class="detail" x1="5" y1="5.5" x2="39" y2="5.5"/>` +
      `<rect class="detail" x="5" y="8.5" width="34" height="12" rx="2"/>` +
      // Contactless mark.
      [2.2, 4, 5.8]
        .map(
          (r) =>
            `<path class="t-nfc" d="M${n(18 + r * 0.7)} ${n(14.5 - r * 0.7)}A${r} ${r} 0 0 1 ${n(18 + r * 0.7)} ${n(14.5 + r * 0.7)}"/>`,
        )
        .join(""),
  );
  s += k.on(
    k.FRONT(25, 9.5, 27.6),
    `<path class="paper" d="M0 0.6L3.4 0L6.8 0.6L10.2 0L13.6 0.6L17 0L20.4 0.6L23.8 0L27.2 0.6L30.6 0L34 0.6L34 3.6L0 3.6Z"/>`,
  );
  // Deck: bezel, screen, keypad.
  const keys = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      const x = 5.5 + c * 11.7;
      const y = 54 + r * 5.6;
      keys.push(
        `<rect class="key-sh" x="${n(x)}" y="${n(y + 0.9)}" width="9.6" height="4"/>` +
          `<rect class="key" x="${n(x)}" y="${n(y)}" width="9.6" height="4" rx="0.8"/>`,
      );
    }
  const fn = ["t-cancel", "t-clear", "t-ok"]
    .map(
      (cls, c) =>
        `<rect class="key-sh" x="${n(5.5 + c * 11.7)}" y="77.5" width="9.6" height="4"/>` +
        `<rect class="key ${cls}" x="${n(5.5 + c * 11.7)}" y="76.6" width="9.6" height="4" rx="0.8"/>`,
    )
    .join("");
  s += k.on(
    k.TOP(20, 4, 17),
    `<rect class="recess" x="3.5" y="27" width="37" height="24" rx="2.6"/>` +
      `<rect class="glass hot t-glass" x="5" y="28.5" width="34" height="21" rx="1.6"/>` +
      `<g class="t-idle"><text class="scr t-dim" x="22" y="38" text-anchor="middle">R$ 1.500</text>` +
      `<text class="scr t-dim t-small" x="22" y="44.6" text-anchor="middle">insira o cartão</text></g>` +
      `<g class="t-on t-on-pos"><text class="scr t-amount" x="22" y="38.4" text-anchor="middle">R$ 1.500</text>` +
      `<text class="scr t-small" x="18.6" y="45" text-anchor="middle">aprovado</text>` +
      `<polyline class="t-tick" points="29.4,43.6 30.8,45 33.4,42.2"/></g>` +
      keys.join("") +
      fn,
  );
  return s;
}

// The issuer: a squat box with a screen, two LEDs, a print slot and a tray.
// Footprint x 128..194, y 16..68, top at z 56.
function issuer(k: K) {
  let s = k.rbox(128, 16, 8, 66, 52, 48, 4);
  s += k.on(
    k.TOP(128, 16, 56),
    `<rect class="detail" x="5" y="5" width="56" height="42" rx="3"/>` +
      `<text class="label" x="33" y="27" text-anchor="middle">EMISSOR</text>`,
  );
  s += k.slits(k.SIDE(194, 60, 50), 4, 40, 3, 26, 40);
  s += k.on(
    k.FRONT(128, 68, 56),
    `<rect class="recess" x="5" y="4" width="56" height="20" rx="2"/>` +
      `<rect class="glass hot t-iglass" x="6.5" y="5.5" width="53" height="17" rx="1.4"/>` +
      `<g class="t-idle"><text class="scr t-dim t-itext" x="10" y="12">aguardando</text>` +
      `<rect class="t-caret" x="10" y="14.4" width="2.6" height="3.6"/></g>` +
      `<g class="t-on t-on-1"><text class="scr t-itext" x="10" y="12">invoice.paid</text></g>` +
      `<g class="t-on t-on-2"><text class="scr t-itext" x="10" y="19">NFS-e emitida</text>` +
      `<polyline class="t-tick" points="51,16.6 52.8,18.4 56,15"/></g>` +
      `<circle class="led hot" cx="9" cy="29" r="1.3"/><circle class="led hot t-led" cx="14" cy="29" r="1.3"/>` +
      `<text class="label" x="19" y="30.5">NFS-e</text>` +
      `<rect class="recess" x="12" y="32.6" width="46" height="3" rx="1"/>` +
      `<line class="detail" x1="10" y1="37.6" x2="60" y2="37.6"/>` +
      `<rect class="recess" x="3" y="40" width="5" height="3.6" rx="0.8"/>`,
  );
  // Tray under the slot.
  s += k.box(137, 68, 18, 50, 25, 2);
  s += k.on(k.FRONT(137, 93, 20), `<line class="detail" x1="3" y1="1" x2="47" y2="1"/>`);
  return s;
}

export function terminal(): Figure {
  const k = frame([
    [0, 0, 0],
    [214, 0, 0],
    [0, 126, 0],
    [214, 126, 0],
    [128, 16, 56],
    [0, 0, 8],
    [214, 126, -1],
  ]);
  let s = `<defs>${frontOf(k, "terminal-card-clip", 86, 11.6)}</defs>`;
  s += plate(k, 0, 0, 214, 126);
  s += machine(k);
  // Cable from the machine's hump to the back of the issuer, lying on the plate.
  s += k.box(64, 13.5, 17.6, 4, 5, 5, "plug");
  s += issuer(k);
  // Cable from the machine's hump, across the plate, into the issuer's port.
  s += k.box(131.4, 68, 12.4, 4.2, 3, 3.6, "plug");
  const cable = curve([
    [68, 16, 20],
    [73, 17.5, 15],
    [78, 24, 9.2],
    [92, 50, 8.8],
    [110, 72, 8.8],
    [126, 79, 8.8],
    [132, 75, 10.6],
    [133.5, 71, 14.2],
  ]);
  s += k.path(cable, "wire t-cable") + k.path(cable, "t-trail") + k.path(cable, "t-pulse");
  // The printed note: it slides out of the slot onto the tray (clipped so
  // it never shows inside the machine).
  const L = 24;
  const W = 40;
  s += k.on(
    k.TOP(142, 68, 20.2),
    `<clipPath id="terminal-paper-clip"><rect x="-2" y="0" width="46" height="40"/></clipPath>` +
      `<g clip-path="url(#terminal-paper-clip)"><g class="t-paper"><g class="sheet lit">` +
      `<rect class="paper" width="${W}" height="${L}" rx="0.6"/>` +
      `<text class="scr dark t-head" x="4" y="6.4">NFS-e</text>` +
      `<line class="ink" x1="4" y1="9.2" x2="36" y2="9.2"/>` +
      `<text class="scr dark t-sub" x="4" y="14.4">R$ 1.500</text>` +
      `<line class="ink" x1="4" y1="17.2" x2="25" y2="17.2"/>` +
      `<line class="ink" x1="4" y1="20.8" x2="22" y2="20.8"/>` +
      `<circle class="seal-ring t-ring" cx="33.5" cy="18.4" r="4.4"/>` +
      `<polyline class="check t-check" pathLength="1" points="31.2,18.6 33,20.4 36,16.8"/>` +
      `</g></g></g>`,
  );
  // The card, chip first into the slot (clipped at the machine's near end).
  s +=
    `<g clip-path="url(#terminal-card-clip)"><g class="t-card">` +
    k.box(31, 70, 11, 24, 36, 1, "card") +
    k.on(
      k.TOP(31, 70, 12),
      `<rect class="t-chip" x="8.5" y="5" width="7" height="5.4" rx="1"/>` +
        `<line class="detail" x1="4" y1="22" x2="20" y2="22"/>` +
        `<line class="detail" x1="4" y1="26" x2="14" y2="26"/>` +
        `<rect class="detail" x="15" y="28.5" width="5" height="3.4" rx="0.6"/>`,
    ) +
    `</g></g>`;
  return { name: "terminal", svg: s, viewBox: k.viewBox };
}
