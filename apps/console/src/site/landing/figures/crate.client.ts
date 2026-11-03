// The last carton is set onto the stack when the pallet scrolls into view and
// again on every click; the label is scanned right after it lands.
export function mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void {
  if (options.reducedMotion) return;
  svg.classList.add("is-live");
  const settle = () => {
    svg.classList.remove("settle");
    void svg.getBoundingClientRect();
    svg.classList.add("settle");
    for (const animation of svg.getAnimations({ subtree: true })) animation.currentTime = 0;
  };
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      settle();
    },
    { threshold: 0.5 },
  );
  seen.observe(svg);
  svg.addEventListener("click", settle);
}
