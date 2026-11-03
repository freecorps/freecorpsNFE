import { frame, type Figure } from "./kit.ts";

// NFS-e Nacional: a work desk. The laptop sends the DPS to the national
// issuer (a progress bar fills), the screen confirms "autorizada" and the
// phone beside it lights with the notification. A mug keeps steaming.
export function desk(): Figure {
  const k = frame(
    [
      [0, 0, 0],
      [96, 0, 0],
      [0, 54, 0],
      [96, 54, 0],
      [22, 12, 64],
      [14, 30, 62],
    ],
    0.05,
  );
  const { box, rbox, on, rect, plane, FRONT, TOP } = k;
  let s = "";

  // Legs, back to front, then the top and its front apron with a drawer.
  for (const [x, y] of [
    [3, 3],
    [89, 3],
    [3, 47],
    [89, 47],
  ] as const)
    s += box(x, y, 0, 4, 4, 28);
  s += box(62, 40, 21, 26, 14, 7);
  s += on(FRONT(62, 54, 28), `<rect class="recess" x="9" y="3" width="8" height="1.4" rx="0.7"/>`);
  s += box(0, 0, 28, 96, 54, 4);

  // Laptop: lid standing on the back edge of the base, screen toward the viewer.
  s += box(22, 12, 32, 50, 2, 32, "lid");
  s += rect(FRONT(25, 14, 61.5), 44, 24, "glass hot", 1.2);
  s += on(
    FRONT(25, 14, 61.5),
    `<text class="scr hd" x="4" y="6.4">DPS 1.01</text><line class="scr-rule" x1="4" y1="8.6" x2="40" y2="8.6"/>` +
      `<text class="scr st st-send" x="4" y="15">enviando</text>` +
      `<text class="scr st st-ok" x="4" y="15">autorizada</text>` +
      `<polyline class="tick st-ok" points="34,3.6 36,5.6 40,1.8"/>` +
      `<rect class="track" x="4" y="18" width="36" height="2.6" rx="0.6"/>` +
      `<rect class="scr-bar bar" x="4" y="18" width="36" height="2.6" rx="0.6"/>`,
  );
  s += box(22, 14, 32, 50, 30, 2.4);
  s += on(
    TOP(22, 14, 34.4),
    Array.from({ length: 4 }, (_, r) =>
      Array.from(
        { length: 11 },
        (_, c) =>
          `<rect class="lap-key" x="${4.6 + c * 3.8}" y="${2.4 + r * 3.4}" width="3" height="2.6" rx="0.4"/>`,
      ).join(""),
    ).join("") +
      `<rect class="lap-key" x="12" y="15.9" width="22" height="2.4" rx="0.4"/>` +
      `<rect class="detail" x="17" y="20" width="16" height="8" rx="1"/>`,
  );

  // Phone lying flat to the right; it lights when the authorization arrives.
  s += box(78, 18, 32, 12, 22, 1.6);
  s += rect(TOP(79, 19, 33.6), 10, 20, "glass phone", 1.4);
  s += on(
    TOP(79, 19, 33.6),
    `<g class="note-card"><rect class="note-bg" x="1.2" y="3" width="7.6" height="5" rx="0.8"/>` +
      `<polyline class="tick-dark" points="2.4,5.6 3.4,6.6 5,4.6"/><line class="ink dark" x1="5.8" y1="5.6" x2="7.6" y2="5.6"/></g>` +
      `<line class="detail" x1="3.5" y1="18.2" x2="6.5" y2="18.2"/>`,
  );

  // Mug at the front left, with a C handle toward the viewer and steam.
  s += rbox(8, 30, 32, 12, 12, 12, 6);
  s += on(TOP(8, 30, 44), `<circle class="coffee" cx="6" cy="6" r="4.6"/>`);
  s += on(
    plane([14, 42, 42], [0, 1, 0], [0, 0, -1]),
    `<path class="face mug-handle" d="M-1 1H2.2A3.6 3.6 0 0 1 2.2 8.4H-1V6.6H2.2A1.8 1.8 0 0 0 2.2 3H-1Z"/>`,
  );
  s += on(
    FRONT(8, 36, 46),
    `<path class="steam s1" d="M4 0c-2 -3 2 -5 0 -8s2 -5 0 -8"/><path class="steam s2" d="M8 0c-2 -3 2 -5 0 -8s2 -5 0 -8"/>`,
  );

  return { name: "desk", svg: s, viewBox: k.viewBox };
}
