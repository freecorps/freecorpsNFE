import { scenes } from "./shader-scenes.ts";

// Progressive enhancement for the next landing. The static page already reads
// in its lit end state; this adds the demos, the coverage wave and, when the
// browser has WebGPU and the reader allows motion, the shader backgrounds.

const root = document.querySelector<HTMLElement>("[data-landing]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Figures that react to input ship a `figures/<name>.client.ts` exporting
// `mount(svg, options)`. Each loads only when its figure is on the page.
type FigureClient = { mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void };
const figureClients = import.meta.glob<FigureClient>("./figures/*.client.ts");

if (root) {
  root.classList.add("js");
  tabs();
  replay();
  stripe();
  coverageWave();
  figures();
  pipeline();
  // The shader engine is large (about 300 KB gzipped, even trimmed to the
  // effects the scenes use), so it waits for an idle moment after load instead
  // of competing with the first paint.
  if (!reducedMotion.matches && "gpu" in navigator && shadersWorthIt()) {
    const start = () => void shaders();
    if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 2500 });
    else setTimeout(start, 1200);
  }
}

function figures() {
  // Animations run only while their figure (or the map) is on screen: offscreen
  // they would still cost style and paint every frame.
  const live = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) entry.target.classList.toggle("is-live", entry.isIntersecting);
    },
    { rootMargin: "120px 0px" },
  );
  for (const svg of root!.querySelectorAll<SVGSVGElement>("svg.iso, svg.map")) live.observe(svg);
  for (const svg of root!.querySelectorAll<SVGSVGElement>("svg[data-figure]")) {
    const load = figureClients[`./figures/${svg.dataset.figure}.client.ts`];
    if (!load) continue;
    // One figure failing must not take the others (or the shaders) with it.
    void load()
      .then((client) => client.mount(svg, { reducedMotion: reducedMotion.matches }))
      .catch((error: unknown) => console.error(`figura ${svg.dataset.figure}`, error));
  }
}

// The shader engine is about 300 KB gzipped. Phones, data savers and small
// devices keep the static CSS backgrounds, which are designed to stand alone.
function shadersWorthIt() {
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  if (nav.connection?.saveData) return false;
  if (nav.deviceMemory !== undefined && nav.deviceMemory < 4) return false;
  if (nav.hardwareConcurrency && nav.hardwareConcurrency < 4) return false;
  return window.matchMedia("(min-width: 768px) and (pointer: fine)").matches;
}

// Without JavaScript every example stays visible, one under the other; with it
// they become tabs (arrow keys, Home and End move between them).
function tabs() {
  const panel = root!.querySelector<HTMLElement>("[data-tabs]");
  if (!panel) return;
  const buttons = [...panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (button: HTMLButtonElement) => {
    for (const other of buttons) {
      const selected = other === button;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      const target = document.getElementById(other.getAttribute("aria-controls")!);
      if (target) {
        target.hidden = !selected;
        // Hidden panels stay in layout (equal heights), so take them out of the tab order too.
        target.tabIndex = selected ? 0 : -1;
      }
    }
  };
  // Code wider than the panel (phones) fades at the right edge until it is
  // scrolled to the end.
  const blocks = [...panel.querySelectorAll<HTMLElement>("pre")];
  const edge = (pre: HTMLElement) =>
    pre.classList.toggle("has-more", pre.scrollLeft + pre.clientWidth < pre.scrollWidth - 2);
  const resize = new ResizeObserver(() => blocks.forEach(edge));
  for (const pre of blocks) {
    pre.addEventListener("scroll", () => edge(pre), { passive: true });
    resize.observe(pre);
  }
  select(buttons.find((b) => b.getAttribute("aria-selected") === "true") ?? buttons[0]!);
  buttons.forEach((button, i) => {
    button.addEventListener("click", () => select(button));
    button.addEventListener("keydown", (event) => {
      const last = buttons.length - 1;
      const index =
        event.key === "ArrowRight"
          ? (i + 1) % buttons.length
          : event.key === "ArrowLeft"
            ? (i + last) % buttons.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? last
                : -1;
      if (index < 0) return;
      event.preventDefault();
      const next = buttons[index]!;
      next.focus();
      select(next);
    });
  });
}

// Each press repeats the same request with the same key. The answer is always
// the first reservation: the request count grows, the batch count never does.
function replay() {
  const box = root!.querySelector<HTMLElement>("[data-replay]");
  const button = box?.querySelector<HTMLButtonElement>("[data-replay-button]");
  const count = box?.querySelector<HTMLElement>("[data-replay-count]");
  const sentLabel = box?.querySelector<HTMLElement>("[data-replay-sent]");
  const status = box?.querySelector<HTMLElement>("[data-replay-status]");
  if (!box || !button || !count || !sentLabel || !status) return;
  const rows = [...box.querySelectorAll<HTMLElement>("[data-replay-again]")];
  button.hidden = false;
  let sent = 2;
  button.addEventListener("click", () => {
    sent += 1;
    count.textContent = `envio ${sent}`;
    sentLabel.textContent = String(sent);
    for (const row of rows) {
      row.classList.remove("fresh");
      // Restart the highlight on every press.
      void row.offsetWidth;
      row.classList.add("fresh");
    }
    status.textContent = `Envio ${sent}: 200, reused: true, o mesmo lote 7Hk2Qm. Nenhuma reserva nova.`;
  });
}

function stripe() {
  const scene = root!.querySelector<HTMLElement>("[data-stripe]");
  const button = scene?.querySelector<HTMLButtonElement>("[data-stripe-pay]");
  if (!scene || !button) return;
  button.hidden = false;
  button.addEventListener("click", () => {
    scene.classList.remove("paid");
    // Restart the CSS sequence on every click.
    void scene.offsetWidth;
    scene.classList.add("paid");
  });
}

// The pinned pipeline (landing.css) walks four stations as you scroll. This
// marks the current one, so only its figure plays and restarts as it lights
// up, and makes the rail stops jump to their station.
function pipeline() {
  const section = root!.querySelector<HTMLElement>(".pipeline");
  if (!section) return;
  const stations = [...section.querySelectorAll<HTMLElement>(".station")];
  const stops = [...section.querySelectorAll<HTMLButtonElement>("[data-station]")];
  // Mirrors the condition that pins the section in landing.css.
  const pinned = window.matchMedia(
    "(prefers-reduced-motion: no-preference) and (min-width: 821px)",
  );
  const walks = () => pinned.matches && CSS.supports("animation-timeline: view()");
  // Where each move of the walk keyframes ends and the next hold begins.
  const moves = [0.185, 0.435, 0.685];
  // The middle of each hold, where a rail stop lands.
  const holds = [0.06, 0.31, 0.56, 0.875];
  const progress = () => {
    const box = section.getBoundingClientRect();
    return Math.min(1, Math.max(0, -box.top / (box.height - window.innerHeight)));
  };
  let current = -1;
  const update = () => {
    const next = walks() ? moves.filter((move) => progress() >= move).length : -1;
    if (next === current) return;
    current = next;
    stations.forEach((station, i) => {
      const on = i === current;
      if (on && !station.classList.contains("is-current"))
        for (const animation of station
          .querySelector("svg.iso")
          ?.getAnimations({ subtree: true }) ?? [])
          animation.currentTime = 0;
      station.classList.toggle("is-current", on);
    });
    stops.forEach((stop, i) => {
      if (i === current) stop.setAttribute("aria-current", "step");
      else stop.removeAttribute("aria-current");
    });
  };
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  pinned.addEventListener("change", schedule);
  update();
  for (const stop of stops)
    stop.addEventListener("click", () => {
      const box = section.getBoundingClientRect();
      const travel = box.height - window.innerHeight;
      const top = window.scrollY + box.top + holds[Number(stop.dataset.station)]! * travel;
      window.scrollTo({ top, behavior: "smooth" });
    });
}

// The map replays its waves (sections/coverage.css) once it is in view.
function coverageWave() {
  const section = root!.querySelector<HTMLElement>(".coverage");
  if (!section) return;
  if (reducedMotion.matches || !("IntersectionObserver" in window)) {
    section.classList.add("seen");
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      section.classList.add("seen");
    },
    { threshold: 0.35 },
  );
  observer.observe(section);
}

async function shaders() {
  const canvases = [...root!.querySelectorAll<HTMLCanvasElement>("canvas[data-shader]")];
  if (!canvases.length || !("gpu" in navigator)) return;
  const { createShader, isWebGPUSupported, createSharedDevice } = await import("shaders/js");
  if (!isWebGPUSupported()) return;
  // One device for every scene: pipelines compile once and resources pool.
  const gpu =
    (await createSharedDevice({ powerPreference: "low-power" }).catch(() => null)) ?? undefined;
  for (const canvas of canvases) {
    const scene = scenes[canvas.dataset.shader ?? ""];
    if (!scene) continue;
    // Render at half size and let CSS scale it up (landing.css, .shader): the
    // dither and noise read the same and the GPU fills a quarter of the pixels.
    // Setting the size here also keeps the canvas responsive: createShader only
    // pins a pixel size when none is set.
    canvas.style.width = "50%";
    canvas.style.height = "50%";
    // The canvas stays transparent until the first frame, so a failure simply
    // leaves the static CSS field in place.
    // Telemetry is off; the CSP would block it anyway.
    void createShader(canvas, scene, {
      disableTelemetry: true,
      ...(gpu ? { gpu } : {}),
      onReady: () => canvas.classList.add("ready"),
      onError: () => canvas.classList.remove("ready"),
    }).catch(() => canvas.classList.remove("ready"));
  }
}
