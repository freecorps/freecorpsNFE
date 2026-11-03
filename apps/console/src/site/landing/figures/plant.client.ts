// Hero line: pointing at a station or at its numbered callout lights both, so
// the reader can match each machine with its step of the story.
export function mount(svg: SVGSVGElement, _options: { reducedMotion: boolean }): void {
  const targets = svg.querySelectorAll<SVGGElement>("[data-st], .callout[data-step]");
  for (const el of targets) {
    const step = el.dataset.st ?? el.dataset.step;
    if (!step) continue;
    el.addEventListener("pointerenter", () => {
      svg.dataset.focus = step;
    });
    el.addEventListener("pointerleave", () => {
      if (svg.dataset.focus === step) delete svg.dataset.focus;
    });
  }
}
