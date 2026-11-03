// Click the vault: the handle turns back, the door swings open on its hinges
// and shows the A1 certificates; click again and it closes, then the dial
// turns its combination and locks (the CSS cycle restarts from unlocked).

const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);
const OPEN = (30 * Math.PI) / 180;
const WIDTH = 48;

export function mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void {
  const vault = svg.querySelector<SVGGElement>(".rk-vault");
  const door = svg.querySelector<SVGGElement>(".rk-door");
  const edge = svg.querySelector<SVGGElement>(".rk-edge");
  if (!vault || !door || !edge) return;
  const [ox, oy] = (door.dataset.o ?? "0 0").split(" ").map(Number) as [number, number];

  let angle = 0;
  let open = false;
  let frame = 0;

  // The leaf turns about a vertical axis: u = (cos a, sin a, 0) in plan,
  // projected like the kernel's D(); the edge strip runs back from its end.
  const draw = (a: number) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ux = (c - s) * C;
    const uy = (c + s) * S;
    door.setAttribute("transform", `matrix(${ux} ${uy} 0 1 ${ox} ${oy})`);
    edge.setAttribute(
      "transform",
      `matrix(${(s + c) * C} ${(s - c) * S} 0 1 ${ox + WIDTH * ux} ${oy + WIDTH * uy})`,
    );
    svg.classList.toggle("ajar", a > 0.001);
  };

  const swing = (to: number, delay: number, done?: () => void) => {
    cancelAnimationFrame(frame);
    if (options.reducedMotion) {
      angle = to;
      draw(angle);
      done?.();
      return;
    }
    const from = angle;
    const ms = 900;
    let start = 0;
    const step = (now: number) => {
      start ||= now + delay;
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      angle = from + (to - from) * e;
      draw(angle);
      if (t < 1) frame = requestAnimationFrame(step);
      else done?.();
    };
    frame = requestAnimationFrame(step);
  };

  vault.addEventListener("click", () => {
    open = !open;
    if (open) {
      svg.classList.add("open");
      swing(OPEN, 260);
    } else {
      swing(0, 0, () => {
        if (!open) svg.classList.remove("open");
      });
    }
  });
}
