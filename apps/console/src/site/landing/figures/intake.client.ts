// Click a source (terminal, capture unit or letterbox) and it pushes another
// document into the inbox right away: its flight and LED restart from the top.
export function mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void {
  if (options.reducedMotion) return;
  for (const source of svg.querySelectorAll<SVGGElement>("[data-source]")) {
    const id = source.dataset.source!;
    source.addEventListener("click", () => {
      const parts = [
        svg.querySelector(`[data-flyer="${id}"]`),
        svg.querySelector(`[data-src="${id}"]`),
        ...(id === "capture" ? svg.querySelectorAll(".wave") : []),
      ];
      // Skip each part's start delay so the push happens on this click.
      for (const part of parts)
        for (const animation of part?.getAnimations() ?? [])
          animation.currentTime = Math.max(0, Number(animation.effect?.getTiming().delay ?? 0));
    });
  }
}
