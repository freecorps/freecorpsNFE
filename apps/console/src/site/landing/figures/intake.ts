import { frame, plate, type Figure, type K } from "./kit.ts";

// Station 1: three sources on the back row (an order terminal, the A1 capture
// unit with its card and antenna, a supplier letterbox for XML) each push a
// document out of a front slot; it hops into the inbox in front. Shared station
// frame: plate 184 x 92, same camera and scale as the other three stations.

// Documents are 20 x 14 sheets. Each flyer's resting pose is the top of the
// stack (LAND); intake.css moves it from its source slot to there.
const LAND = { x: 98, y: 59, z: 14.2 };
const FRONT_Y = 30; // front faces of the three sources
const SOURCES = [
  { id: "order", x: 18, slotZ: 14 },
  { id: "capture", x: 74, slotZ: 13 },
  { id: "xml", x: 140, slotZ: 15 },
] as const;

export function intake(): Figure {
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
  s += `<g data-source="order">${terminal(k)}</g>`;
  s += `<g data-source="capture">${capture(k)}</g>`;
  s += `<g data-source="xml">${letterbox(k)}</g>`;
  s += tray(k);
  for (const src of SOURCES) s += flyer(k, src.id, src.slotZ);
  return { name: "intake", svg: s, viewBox: k.viewBox };
}

// A document lying on a top plane.
function doc(k: K, x: number, y: number, z: number, rot = 0, lit = false) {
  return k.on(
    k.TOP(x, y, z),
    `<g class="sheet${lit ? " lit" : ""}" transform="rotate(${rot} 10 7)">` +
      `<rect class="paper" width="20" height="14" rx="1"/>` +
      `<line class="ink" x1="3" y1="4" x2="14" y2="4"/>` +
      `<line class="ink" x1="3" y1="7" x2="17" y2="7"/>` +
      `<line class="ink" x1="3" y1="10" x2="11" y2="10"/></g>`,
  );
}

// Front-face slot with the label above it and a status LED.
function slotFace(
  k: K,
  x: number,
  w: number,
  top: number,
  slotZ: number,
  label: string,
  id: string,
) {
  const v = top - slotZ;
  return k.on(
    k.FRONT(x, FRONT_Y, top),
    `<text class="label" x="${w / 2}" y="${v - 3.2}" text-anchor="middle">${label}</text>` +
      `<rect class="slot" x="${w / 2 - 12}" y="${v - 0.8}" width="24" height="1.8" rx="0.6"/>` +
      `<circle class="led hot src-led" data-src="${id}" cx="${w - 4}" cy="${v + 4}" r="1.3"/>`,
  );
}

// Order terminal: keypad and a small lit screen on top.
function terminal(k: K) {
  const x = 6;
  const w = 34;
  let s = k.box(x, 8, 8, w, 22, 16);
  s += slotFace(k, x, w, 24, 14, "PEDIDO", "order");
  s += k.on(
    k.TOP(x, 8, 24),
    `<rect class="glass hot" x="3" y="3" width="16" height="9" rx="1"/>` +
      `<text class="scr" x="5" y="9.2">#1042</text>` +
      Array.from({ length: 9 }, (_, i) => {
        const c = i % 3;
        const r = Math.floor(i / 3);
        return `<rect class="key" x="${22 + c * 4}" y="${3 + r * 5.6}" width="3" height="4.2" rx="0.6"/>`;
      }).join("") +
      `<rect class="key" x="3" y="14.5" width="16" height="4" rx="0.6"/>`,
  );
  return s;
}

// Capture unit: A1 card standing in its reader slot, dish antenna behind it.
function capture(k: K) {
  const x = 62;
  const w = 40;
  let s = k.box(x, 8, 8, w, 22, 12);
  // Antenna mast at the back corner, drawn before the card in front of it.
  s += k.box(94, 10, 20, 3, 3, 20);
  const c: [number, number, number] = [95.5, 14, 42];
  const dish = k.plane(c, [1, 0, 0], [0, 0.6, -0.8]);
  s += k.on(
    dish,
    `<circle class="wave w0" r="11"/><circle class="wave w1" r="11"/>` +
      `<circle class="face dish" r="8"/><circle class="detail" r="4.6"/>`,
  );
  const [fx, fy] = k.P(c[0], c[1] + 6.4, c[2] + 4.8);
  const [cx, cy] = k.P(...c);
  s += `<line class="wire" x1="${cx}" y1="${cy}" x2="${fx}" y2="${fy}"/><circle class="led hot feed" cx="${fx}" cy="${fy}" r="1.4"/>`;
  // Card reader slot and the card (thin, its face toward the viewer).
  s += k.rect(k.TOP(68, 17, 20), 24, 3, "slot", 0.6);
  s += k.box(70, 18, 20, 20, 1.4, 14, "card-body");
  s += k.on(
    k.FRONT(70, 19.4, 34),
    `<rect class="chip lit" x="3" y="3.4" width="5" height="4" rx="0.6"/>` +
      `<text class="label" x="17" y="7" text-anchor="end">A1</text>` +
      `<line class="detail" x1="3" y1="10.5" x2="17" y2="10.5"/>`,
  );
  s += slotFace(k, x, w, 20, 13, "CAPTURA", "capture");
  return s;
}

// Supplier letterbox: XML documents drop through it.
function letterbox(k: K) {
  const x = 128;
  const w = 36;
  let s = k.box(x, 8, 8, w, 22, 22);
  s += k.slits(k.TOP(x, 8, 30), 4, 32, 4, 4, 18);
  s += slotFace(k, x, w, 30, 15, "XML", "xml");
  s += k.on(
    k.FRONT(x, FRONT_Y, 30),
    `<rect class="detail" x="4" y="17" width="${w - 8}" height="3" rx="0.6"/>`,
  );
  // Mail flag on the side: raised, there is post.
  s += k.on(
    k.SIDE(x + w, FRONT_Y, 30),
    `<rect class="detail" x="13" y="6" width="1.6" height="12"/>` +
      `<path class="flag lit" d="M14.6 6L22 6L22 10.5L14.6 10.5Z"/>`,
  );
  return s;
}

// Inbox tray: real walls, a loose stack inside, the newest document lit.
function tray(k: K) {
  const x = 72;
  const y = 46;
  const w = 72;
  const d = 40;
  let s = k.box(x, y, 8, w, d, 4);
  s += k.box(x, y, 12, w, 3, 8) + k.box(x, y + 3, 12, 3, d - 6, 8);
  s += doc(k, LAND.x - 9, LAND.y - 4, 12.4, -12);
  s += doc(k, LAND.x + 8, LAND.y + 3, 13, 9);
  s += doc(k, LAND.x - 2, LAND.y + 1, 13.6, -4);
  s += `<g class="stack-top">${doc(k, LAND.x, LAND.y, LAND.z, 0, true)}</g>`;
  s += k.box(x + w - 3, y + 3, 12, 3, d - 6, 8);
  s += k.box(x, y + d - 3, 12, w, 3, 8);
  s += k.on(
    k.FRONT(x, y + d, 20),
    `<text class="label" x="7" y="5.6">ENTRADA</text>` +
      `<rect class="strip lit tray-strip" x="${w - 18}" y="3.2" width="12" height="1.6" rx="0.6"/>`,
  );
  return s;
}

// A flyer: a lit document resting at LAND, clipped to the space in front of
// its source's face so it slides out of the slot instead of popping in.
function flyer(k: K, id: string, slotZ: number) {
  const pts = [
    k.P(-400, FRONT_Y, slotZ),
    k.P(400, FRONT_Y, slotZ),
    k.P(400, 400, slotZ),
    k.P(-400, 400, slotZ),
  ];
  return (
    `<clipPath id="intake-clip-${id}"><path d="M${pts.map((p) => p.join(" ")).join("L")}Z"/></clipPath>` +
    `<g clip-path="url(#intake-clip-${id})"><g class="flyer fly-${id}" data-flyer="${id}">${doc(k, LAND.x, LAND.y, LAND.z, 0, true)}</g></g>`
  );
}
