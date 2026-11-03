import { frame, type Point } from "../iso.ts";

// Shared parts for the landing figures: plates and paper. Each figure lives
// in its own module next to this one, with its own CSS (`<name>.css`, scoped
// to `.fig-<name>`) and, when it reacts to input, a `<name>.client.ts`. Paint
// order is the depth sort: list parts back to front.

export { frame, type Point };
export type Figure = { name: string; svg: string; viewBox: string };
export type K = ReturnType<typeof frame>;

// Ground plate: rounded slab, inset hairline and four screws.
export function plate(k: K, x: number, y: number, w: number, d: number, h = 8, r = 10) {
  const screws = [
    [9, 9],
    [w - 9, 9],
    [9, d - 9],
    [w - 9, d - 9],
  ]
    .map(([cx, cy]) => `<circle class="screw" cx="${cx}" cy="${cy}" r="1.6"/>`)
    .join("");
  return (
    k.rbox(x, y, 0, w, d, h, r) +
    k.on(
      k.TOP(x, y, h),
      `<rect class="detail" x="5" y="5" width="${w - 10}" height="${d - 10}" rx="${Math.max(r - 4, 2)}"/>${screws}`,
    )
  );
}

// A sheet of paper lying on a top plane: printed lines, optional seal or check.
export function paper(
  k: K,
  x: number,
  y: number,
  z: number,
  rot = 0,
  cls = "",
  mark: "" | "seal" | "check" = "",
) {
  const lines = [20, 14, 20, 11]
    .map((end, i) => `<line class="ink" x1="4" y1="${6 + i * 5}" x2="${end}" y2="${6 + i * 5}"/>`)
    .join("");
  const extra =
    mark === "seal"
      ? `<circle class="seal-mark" cx="18" cy="27" r="4.2"/><circle class="seal-ring" cx="18" cy="27" r="2"/>`
      : mark === "check"
        ? `<polyline class="check" points="6,26 10,30 19,21"/>`
        : "";
  return k.on(
    k.TOP(x, y, z),
    `<g class="sheet ${cls}" transform="rotate(${rot} 12 16)"><rect class="paper" width="24" height="32" rx="1"/>${lines}${extra}</g>`,
  );
}
