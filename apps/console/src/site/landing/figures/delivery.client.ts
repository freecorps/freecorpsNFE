// Click the dispatch box or the tube to post another webhook: the box reads
// POST, a new capsule leaves and the floors relight when it lands.
export function mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void {
  if (options.reducedMotion) return;
  svg.addEventListener("click", () => {
    for (const animation of svg.getAnimations({ subtree: true })) animation.currentTime = 0;
  });
}
