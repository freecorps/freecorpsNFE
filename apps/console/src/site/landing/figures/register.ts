import { frame, type Figure } from "./kit.ts";

// NFC-e: a point-of-sale till. Cash drawer at the bottom, a terminal with a
// keypad, a customer display on a stalk and a thermal printer whose receipt
// (with the NFC-e QR code) feeds out of the slot. The sale runs in a loop:
// three items keyed, the total grows, the receipt prints, the drawer opens.
export function register(): Figure {
  const k = frame(
    [
      [0, 0, 0],
      [84, 0, 0],
      [0, 70, 0],
      [84, 70, 0],
      [2, 10, 72],
      [61, 32, 64],
    ],
    0.05,
  );
  const { box, on, rect, FRONT, TOP, SIDE, P } = k;
  let s = "";

  // Cash drawer housing. The drawer itself is drawn later so it can slide out.
  s += box(0, 0, 0, 84, 60, 16);
  s += on(
    SIDE(84, 60, 16),
    Array.from(
      { length: 6 },
      (_, i) => `<line class="detail" x1="${8 + i * 3}" y1="4" x2="${8 + i * 3}" y2="12"/>`,
    ).join(""),
  );
  s += rect(FRONT(3, 60, 14), 78, 12, "face recess");

  // Terminal with a raised keypad.
  s += box(4, 6, 16, 50, 50, 7);
  s += on(
    FRONT(4, 56, 23),
    `<line class="detail" x1="3" y1="4.5" x2="47" y2="4.5"/><circle class="led hot" cx="44" cy="2.4" r="0.9"/>`,
  );
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 5; c++) {
      const go = c === 4 && r >= 2;
      if (c === 4 && r === 3) continue; // the tall "total" key covers two rows
      const items: Record<string, string> = { "0,1": " kA", "1,2": " kB", "2,0": " kC" };
      const item = items[`${r},${c}`] ?? "";
      s += box(
        9 + c * 8.6,
        28 + r * 6.4,
        23,
        7,
        go ? 11 : 4.6,
        1.4,
        go ? "keycap key-go" : c === 4 ? "keycap key-fn" : `keycap${item}`,
      );
    }

  // Customer display on a stalk, facing the customer (the viewer).
  s += box(20, 12, 23, 4, 4, 28);
  s += box(2, 10, 51, 40, 7, 21);
  s += rect(FRONT(4, 17, 70), 36, 17, "glass hot", 1.5);
  const amounts = ["0,00", "18,50", "32,40", "48,90"];
  s += on(
    FRONT(4, 17, 70),
    `<text class="scr" x="3" y="6">TOTAL R$</text>` +
      amounts
        .map((a, i) => `<text class="scr amt a${i}" x="33" y="14.4" text-anchor="end">${a}</text>`)
        .join(""),
  );

  // Thermal printer: cover seam, slot, feed LED.
  s += box(58, 10, 16, 24, 30, 14);
  s += on(
    TOP(58, 10, 30),
    `<line class="detail" x1="2" y1="18" x2="22" y2="18"/><rect class="recess" x="2.5" y="21.4" width="19" height="1.2"/>`,
  );
  s += on(
    FRONT(58, 40, 30),
    `<line class="detail" x1="2" y1="4" x2="22" y2="4"/><circle class="led prn-led" cx="19" cy="9" r="1.1"/>` +
      `<rect class="detail" x="3" y="7.5" width="6" height="3" rx="1"/>`,
  );

  // The receipt: one strip of paper in the slot plane, clipped at the slot so
  // the part still inside the printer never shows. It feeds by translation.
  const H = 30;
  const [ax, ay] = P(61, 32, 30) as [number, number];
  const [bx, by] = P(79, 32, 30) as [number, number];
  s += `<clipPath id="fig-register-slot"><path d="M${ax} ${ay}L${bx} ${by}L${bx} ${by - 200}L${ax} ${ay - 200}Z"/></clipPath>`;
  const zig = Array.from({ length: 13 }, (_, i) => `L${i * 1.5} ${i % 2 ? 0 : 1.2}`).join("");
  const qr = [
    [0, 0, 3, 3],
    [5, 0, 3, 3],
    [0, 5, 3, 3],
    [3.6, 3.6, 1.2, 1.2],
    [5.4, 5, 1.2, 2.6],
    [3.6, 6.6, 1.2, 1.4],
    [6.8, 4, 1.2, 1.2],
  ]
    .map(
      ([x, y, w, h]) =>
        `<rect class="ink-fill" x="${x! + 5}" y="${y! + 20}" width="${w}" height="${h}"/>`,
    )
    .join("");
  const lines = [
    [5, 13, 3.5],
    [2, 16, 6.5],
    [2, 10, 9.4],
    [13, 16, 9.4],
    [2, 9, 11.8],
    [13, 16, 11.8],
    [2, 11, 14.2],
    [13, 16, 14.2],
  ]
    .map(([a, b, y]) => `<line class="ink dark" x1="${a}" y1="${y}" x2="${b}" y2="${y}"/>`)
    .join("");
  s +=
    `<g clip-path="url(#fig-register-slot)"><g class="feed">` +
    on(
      FRONT(61, 32, 30 + H),
      `<path class="receipt-paper lit" d="M0 1.2${zig}L18 ${H + 34}L0 ${H + 34}Z"/>${lines}` +
        `<line class="ink dark heavy" x1="2" y1="17.4" x2="16" y2="17.4"/>${qr}`,
    ) +
    `</g></g>`;

  // The drawer: a tray of notes and coins that slides out toward the viewer.
  // Clipped to the front plane so the part inside the housing stays hidden.
  const clip = `<clipPath id="fig-register-drawer"><rect transform="${FRONT(3, 60, 14)}" x="-30" y="0" width="108" height="40"/></clipPath>`;
  const tray = on(
    TOP(3, 40, 14),
    `<rect class="tray" x="2" y="1.5" width="74" height="17"/>` +
      [20, 38, 56]
        .map((x) => `<line class="detail" x1="${x}" y1="1.5" x2="${x}" y2="18.5"/>`)
        .join("") +
      [3.5, 21.5, 39.5]
        .map((x) => `<rect class="note" x="${x}" y="4" width="15" height="12" rx="0.6"/>`)
        .join("") +
      [61, 66, 71].map((x) => `<circle class="coin" cx="${x}" cy="10" r="2"/>`).join(""),
  );
  s +=
    clip +
    `<g clip-path="url(#fig-register-drawer)"><g class="drawer">` +
    box(3, 40, 2, 78, 20, 12) +
    tray +
    on(
      FRONT(3, 60, 14),
      `<rect class="recess" x="31" y="4" width="16" height="2.6" rx="1.3"/><circle class="lock" cx="70" cy="5.5" r="1.8"/><line class="detail" x1="70" y1="4.4" x2="70" y2="6.6"/>`,
    ) +
    `</g></g>`;

  return { name: "register", svg: s, viewBox: k.viewBox };
}
