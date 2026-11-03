// Click the till to send the DPS again: the bar, the confirmation and
// the phone notification start over.
export function mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void {
  if (options.reducedMotion) return;
  svg.classList.add("is-live");
  svg.addEventListener("click", () => {
    for (const animation of svg.getAnimations({ subtree: true })) animation.currentTime = 0;
  });
}
