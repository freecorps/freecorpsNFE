// Click the mast, the beam or the building to transmit again: the pulse leaves
// the beacon now and the building answers when it lands.
export function mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void {
  if (options.reducedMotion) return;
  svg.addEventListener("click", () => {
    for (const animation of svg.getAnimations({ subtree: true })) animation.currentTime = 0;
  });
}
