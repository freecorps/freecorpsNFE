import { frame, plate, type Figure, type Point } from "./kit.ts";

// Self-hosting: a server rack, front panel toward the viewer, cabled to the
// certificate vault beside it. LEDs blink with disk and link activity; the
// vault dial turns its combination, the handle throws the bolts and the lock
// indicator lights; pulses run along the cable between the two. Clicking the
// vault swings its door open on the hinges (rack.client.ts).

// Cabinet and vault, in plate units.
const RX = 14;
const RY = 22;
const RW = 62;
const RD = 50;
const RZ = 12;
const RH = 138;
const VX = 100;
const VY = 32;
const VW = 58;
const VD = 46;
const VZ = 12;
const VH = 58;
const U = 7;

const f = (v: number) => Number(v.toFixed(2));

// Blink patterns for activity LEDs: four rhythms times three phase offsets.
const blink = (i: number) => `rk-b${i % 4} rk-o${(i * 7) % 3}`;

function led(x: number, y: number, w: number, h: number, i: number, steady = false) {
  return `<rect class="led hot${steady ? "" : ` ${blink(i)}`}" x="${f(x)}" y="${f(y)}" width="${w}" height="${h}" rx="0.3"/>`;
}

function vents(x0: number, x1: number, y0: number, y1: number, step = 1.8) {
  let s = "";
  for (let x = x0; x <= x1 + 1e-6; x += step)
    s += `<line class="detail" x1="${f(x)}" y1="${f(y0)}" x2="${f(x)}" y2="${f(y1)}"/>`;
  return s;
}

// One rack unit plate with its mounting ears and screws.
function chassis(v: number, n: number) {
  const h = n * U;
  return (
    `<rect class="face rk-unit" x="7" y="${f(v + 0.35)}" width="48" height="${f(h - 0.7)}" rx="0.5"/>` +
    `<circle class="screw" cx="8.4" cy="${f(v + h / 2)}" r="0.55"/>` +
    `<circle class="screw" cx="53.6" cy="${f(v + h / 2)}" r="0.55"/>`
  );
}

// The rack front, face-local: u 0..62 across, v 0..138 down from the top.
function rackFront() {
  let s = `<rect class="recess" x="5" y="6" width="52" height="127"/>`;
  for (let v = 8; v < 132; v += 3.5)
    s += `<circle class="rk-hole" cx="6" cy="${f(v)}" r="0.45"/><circle class="rk-hole" cx="56" cy="${f(v)}" r="0.45"/>`;
  let v = 7;
  let n = 0;

  // Patch panel: twelve ports in two groups.
  s += chassis(v, 1);
  const patch: number[] = [];
  for (let i = 0; i < 12; i++) {
    const x = 11 + i * 3.1 + (i >= 6 ? 2 : 0);
    patch.push(x + 1.1);
    s += `<rect class="recess" x="${f(x)}" y="${v + 2.2}" width="2.2" height="2.6" rx="0.3"/>`;
  }
  const vPatch = v;
  v += U;

  // Horizontal cable manager with its slot.
  s += chassis(v, 1);
  s += `<rect class="recess" x="11" y="${v + 2.4}" width="40" height="2.2" rx="1.1"/>`;
  v += U;

  // Switch: sixteen ports, a link LED over each, a status LED at the end.
  s += chassis(v, 1);
  const sw: number[] = [];
  for (let i = 0; i < 16; i++) {
    const x = 10.5 + i * 2.55;
    sw.push(x + 0.9);
    s += `<rect class="recess" x="${f(x)}" y="${v + 3}" width="1.8" height="2.3" rx="0.2"/>`;
    s += led(x + 0.3, v + 1.3, 1.2, 0.8, n++);
  }
  s += led(52, v + 3, 1.2, 1.2, 0, true);
  const vSwitch = v;
  v += U;

  // Patch cords: short straight drops from the panel into the switch.
  for (const p of [0, 2, 3, 5, 6, 8, 9, 11]) {
    const x = patch[p]!;
    const j = sw.reduce((b, c, i) => (Math.abs(c - x) < Math.abs(sw[b]! - x) ? i : b), 0);
    const x2 = sw[j]!;
    s += `<path class="rk-cord" d="M${f(x)} ${vPatch + 4.8}C${f(x)} ${vPatch + 9} ${f(x2)} ${vSwitch - 1} ${f(x2)} ${vSwitch + 3}"/>`;
  }

  // Blank panel with a vent.
  s += chassis(v, 1) + vents(12, 50, v + 2, v + 5);
  v += U;

  // Three 2U servers: handle, eight drive bays, power and activity LEDs.
  for (let k = 0; k < 3; k++) {
    s += chassis(v, 2);
    s += `<rect class="detail" x="9.6" y="${v + 2.2}" width="1.8" height="9.6" rx="0.9"/>`;
    for (let i = 0; i < 8; i++) {
      const x = 13 + i * 3.9;
      s += `<rect class="recess" x="${f(x)}" y="${v + 1.6}" width="3.3" height="10.8" rx="0.3"/>`;
      s += `<line class="detail" x1="${f(x + 0.8)}" y1="${v + 3}" x2="${f(x + 2.5)}" y2="${v + 3}"/>`;
      s += led(x + 1.15, v + 10.4, 1, 1, n++);
    }
    s += `<rect class="led hot" x="46.4" y="${v + 2}" width="1.6" height="1.6" rx="0.8"/>`;
    s += led(49.4, v + 2, 1.6, 1.6, n++);
    s += vents(46.4, 53, v + 5.5, v + 12, 1.65);
    v += 2 * U;
  }

  // Two 1U servers with four wide bays each.
  for (let k = 0; k < 2; k++) {
    s += chassis(v, 1);
    for (let i = 0; i < 4; i++) {
      const x = 11 + i * 8.4;
      s += `<rect class="recess" x="${f(x)}" y="${v + 1.6}" width="7.6" height="3.8" rx="0.3"/>`;
      s += led(x + 5.6, v + 3, 1, 1, n++);
    }
    s += `<rect class="led hot" x="46.4" y="${v + 2.8}" width="1.4" height="1.4" rx="0.7"/>`;
    s += led(49.4, v + 2.8, 1.4, 1.4, n++);
    v += U;
  }

  // Storage shelf: two rows of six bays.
  s += chassis(v, 2);
  for (let r = 0; r < 2; r++)
    for (let i = 0; i < 6; i++) {
      const x = 10.5 + i * 7;
      const y = v + 1.6 + r * 5.6;
      s += `<rect class="recess" x="${f(x)}" y="${f(y)}" width="6.3" height="4.8" rx="0.3"/>`;
      s += led(x + 4.6, y + 1.8, 1, 1, n++);
    }
  s += vents(53, 53, v + 2, v + 12);
  v += 2 * U;

  s += chassis(v, 1) + vents(12, 50, v + 2, v + 5);
  v += U;

  // UPS: a lit status display, three LEDs and a grille.
  s += chassis(v, 3);
  s +=
    `<rect class="glass hot" x="10" y="${v + 3.5}" width="22" height="10" rx="0.8"/>` +
    `<text class="scr rk-scr" x="12" y="${v + 8}">UPS 100%</text>`;
  for (let i = 0; i < 5; i++)
    s += `<rect class="scr-bar" x="${12 + i * 3.6}" y="${v + 10}" width="2.8" height="1.6"/>`;
  s +=
    `<text class="label rk-small" x="10" y="${v + 18.2}">REDE OK</text>` +
    `<rect class="led hot" x="35" y="${v + 4}" width="1.6" height="1.6" rx="0.8"/>` +
    `<rect class="led hot" x="38.4" y="${v + 4}" width="1.6" height="1.6" rx="0.8"/>` +
    `<rect class="led" x="41.8" y="${v + 4}" width="1.6" height="1.6" rx="0.8"/>` +
    vents(35, 52, v + 8, v + 18.5, 1.7);
  return s;
}

export function rack(): Figure {
  // Cable from the rack's side gland, sagging down to the vault's top gland.
  const bez = (a: Point, b: Point, c: Point, d: Point, t: number): Point =>
    [0, 1, 2].map(
      (i) =>
        (1 - t) ** 3 * a[i]! +
        3 * (1 - t) ** 2 * t * b[i]! +
        3 * (1 - t) * t * t * c[i]! +
        t ** 3 * d[i]!,
    ) as Point;
  const gy = RY + RD - 34;
  const gz = RZ + RH - 40;
  const top = VZ + VH;
  const cable: Point[] = [[RX + RW, gy, gz]];
  for (let i = 0; i <= 16; i++)
    cable.push(
      bez(
        [RX + RW + 6, gy, gz],
        [104, gy, gz - 2],
        [114, 44, top + 30],
        [114, 44, top + 8],
        i / 16,
      ),
    );
  cable.push([114, 44, top + 1]);

  const k = frame(
    [
      [0, 10, 0],
      [172, 10, 0],
      [0, 92, 0],
      [172, 92, 0],
      [RX, RY, RZ + RH],
    ],
    0.04,
  );

  let s = plate(k, 0, 10, 172, 82);

  // Rack: plinth, cabinet, top vents, side louvres and the cable gland.
  s += k.box(RX + 3, RY + 3, 8, RW - 6, RD - 6, 4);
  s += k.box(RX, RY, RZ, RW, RD, RH);
  s += k.on(
    k.TOP(RX, RY, RZ + RH),
    `<rect class="detail" x="4" y="4" width="${RW - 8}" height="${RD - 8}" rx="1"/>` +
      `<circle class="detail" cx="20" cy="25" r="9"/><circle class="detail" cx="20" cy="25" r="2.5"/>` +
      `<circle class="detail" cx="42" cy="25" r="9"/><circle class="detail" cx="42" cy="25" r="2.5"/>` +
      [0, 60, 120]
        .map((a) => {
          const r = (a * Math.PI) / 180;
          const dx = f(Math.cos(r) * 8.5);
          const dy = f(Math.sin(r) * 8.5);
          return `<line class="detail" x1="${20 - dx}" y1="${25 - dy}" x2="${20 + dx}" y2="${25 + dy}"/><line class="detail" x1="${42 - dx}" y1="${25 - dy}" x2="${42 + dx}" y2="${25 + dy}"/>`;
        })
        .join(""),
  );
  s += k.on(
    k.SIDE(RX + RW, RY + RD, RZ + RH),
    `<rect class="detail" x="4" y="6" width="${RD - 8}" height="${RH - 12}" rx="1.5"/>` +
      Array.from(
        { length: 6 },
        (_, i) =>
          `<line class="detail" x1="10" y1="${14 + i * 3}" x2="${RD - 10}" y2="${14 + i * 3}"/>` +
          `<line class="detail" x1="10" y1="${110 + i * 3}" x2="${RD - 10}" y2="${110 + i * 3}"/>`,
      ).join("") +
      `<circle class="face" cx="34" cy="40" r="3.4"/><circle class="recess" cx="34" cy="40" r="1.8"/>`,
  );
  s += k.on(k.FRONT(RX, RY + RD, RZ + RH), rackFront());

  // Vault: feet, the interior behind the door, then the body with its opening.
  const fy = VY + VD;
  const vg: string[] = [];
  for (const [x, y] of [
    [VX + 3, VY + 3],
    [VX + VW - 9, VY + 3],
    [VX + 3, fy - 9],
    [VX + VW - 9, fy - 9],
  ])
    vg.push(k.box(x!, y!, 8, 6, 6, 4));
  const dep = 14;
  vg.push(
    k.rect(k.FRONT(VX + 5, fy - dep, top - 5), 48, 48, "recess"),
    k.rect(k.TOP(VX + 5, fy - dep, VZ + 5), 48, dep, "face top"),
    k.rect(k.SIDE(VX + 5, fy, top - 5), dep, 48, "face side rk-wall"),
  );
  // Two A1 certificates standing in a file tray.
  vg.push(k.box(VX + 12, fy - 11, VZ + 5, 34, 8, 4));
  for (const [x, y] of [
    [VX + 15, fy - 9],
    [VX + 27, fy - 6],
  ])
    vg.push(
      k.box(x!, y!, VZ + 9, 14, 1, 20, "rk-card") +
        k.on(
          k.FRONT(x!, y! + 1, VZ + 29),
          `<text class="scr dark rk-cert" x="2" y="6">A1</text>` +
            `<line class="ink dark" x1="2" y1="10" x2="12" y2="10"/><line class="ink dark" x1="2" y1="13" x2="9" y2="13"/>` +
            `<circle class="rk-seal" cx="10" cy="16.4" r="2"/>`,
        ),
    );
  vg.push(
    k.rect(k.SIDE(VX + VW, fy, top), VD, VH, "face side"),
    k.rect(k.TOP(VX, VY, top), VW, VD, "face top"),
    k.on(
      k.TOP(VX, VY, top),
      `<rect class="detail" x="4" y="4" width="${VW - 8}" height="${VD - 8}" rx="1"/>` +
        `<circle class="face" cx="14" cy="12" r="3.6"/><circle class="recess" cx="14" cy="12" r="2"/>`,
    ),
    k.on(
      k.SIDE(VX + VW, fy, top),
      `<rect class="detail" x="5" y="5" width="${VD - 10}" height="${VH - 10}" rx="1.5"/>` +
        `<rect class="detail" x="9" y="9" width="${VD - 18}" height="${VH - 18}" rx="1"/>`,
    ),
    k.on(
      k.FRONT(VX, fy, top),
      `<path class="face front" fill-rule="evenodd" d="M0 0H${VW}V${VH}H0Z M5 5V53H53V5Z"/>` +
        `<rect class="detail" x="4.4" y="4.4" width="49.2" height="49.2" rx="0.6"/>` +
        [10, 38]
          .map(
            (y) =>
              `<rect class="hinge" x="1.6" y="${y}" width="3.2" height="9" rx="1"/><line class="detail" x1="1.6" y1="${y + 4.5}" x2="4.8" y2="${y + 4.5}"/>`,
          )
          .join(""),
    ),
  );

  // The door leaf, hinged on its left edge. Its edge strip shows only while
  // it stands ajar; rack.client.ts rewrites both transforms as it swings.
  const [ox, oy] = k.P(VX + 5, fy, top - 5);
  const ticks = Array.from({ length: 40 }, (_, i) => {
    const a = (i * 9 * Math.PI) / 180;
    const r0 = i % 5 ? 8.4 : 7.4;
    return `<line class="${i % 5 ? "detail" : "rk-tick"}" x1="${f(Math.sin(a) * r0)}" y1="${f(-Math.cos(a) * r0)}" x2="${f(Math.sin(a) * 9.6)}" y2="${f(-Math.cos(a) * 9.6)}"/>`;
  }).join("");
  const grips = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    return `<line class="detail" x1="${f(Math.sin(a) * 3.6)}" y1="${f(-Math.cos(a) * 3.6)}" x2="${f(Math.sin(a) * 5.6)}" y2="${f(-Math.cos(a) * 5.6)}"/>`;
  }).join("");
  const spokes = [45, 165, 285]
    .map((d) => {
      const a = (d * Math.PI) / 180;
      const x = f(Math.sin(a) * 8.5);
      const y = f(-Math.cos(a) * 8.5);
      return `<line class="rk-spoke" x1="0" y1="0" x2="${x}" y2="${y}"/><circle class="rk-knob" cx="${x}" cy="${y}" r="1.5"/>`;
    })
    .join("");
  vg.push(
    `<g class="rk-edge" transform="matrix(0 -1 0 1 0 0)"><rect class="face side" width="3" height="48"/></g>`,
    `<g class="rk-door" data-o="${ox} ${oy}" transform="${k.FRONT(VX + 5, fy, top - 5)}">` +
      `<rect class="face front" width="48" height="48" rx="0.6"/>` +
      `<rect class="detail" x="3" y="3" width="42" height="42" rx="1"/>` +
      `<g transform="translate(17 20)"><circle class="face rk-bezel" r="10.6"/><circle class="rk-ring" r="10.6"/>` +
      `<g class="rk-dial">${ticks}<circle class="face" r="6"/>${grips}<circle class="face" r="2.4"/><line class="rk-tick" x1="0" y1="-2.4" x2="0" y2="-5.6"/></g>` +
      `<path class="rk-index" d="M-1.3 -13.4H1.3L0 -11.2Z"/></g>` +
      `<g transform="translate(36 22)"><g class="rk-handle">${spokes}<circle class="face" r="2.8"/><circle class="detail" r="1.2"/></g></g>` +
      `<rect class="rk-lock lit" x="31" y="6" width="11" height="3.2" rx="1.6"/>` +
      `<rect class="detail" x="7" y="36" width="34" height="7" rx="0.6"/>` +
      `<text class="label rk-plaque" x="24" y="41" text-anchor="middle">AES-256-GCM</text>` +
      `</g>`,
  );
  s += `<g class="rk-vault">${vg.join("")}</g>`;

  // The cable and the data pulses it carries.
  s += k.path(cable, "rk-cable-under");
  s += k.path(cable, "rk-cable");
  s += k.path(cable, "rk-pulse rk-up");
  s += k.path(cable.slice().reverse(), "rk-pulse rk-down");
  return { name: "rack", svg: s, viewBox: k.viewBox };
}
