// Click the till to ring up a new sale: the keyed items, the total, the
// receipt and the drawer all start over from the first item.
export function mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void {
  if (options.reducedMotion) return;
  svg.classList.add("is-live");
  svg.addEventListener("click", () => {
    for (const animation of svg.getAnimations({ subtree: true })) animation.currentTime = 0;
  });
}
