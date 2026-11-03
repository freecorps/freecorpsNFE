// The console counts the sheets that pass the schema. Clicking it reruns the
// validation now: the belt indexes, the curtain sweeps and the count goes up.
export function mount(svg: SVGSVGElement, options: { reducedMotion: boolean }): void {
  const console_ = svg.querySelector<SVGGElement>("[data-console]");
  const count = svg.querySelector<SVGTextElement>(".count");
  if (!console_ || !count) return;
  let passed = 3;
  const show = () => (count.textContent = `${passed} conferidas`);
  show();
  // One sheet is checked per cycle, at the end of the sweep.
  svg.addEventListener("animationiteration", (event) => {
    if ((event as AnimationEvent).animationName !== "validator-bar") return;
    passed += 1;
    show();
  });
  console_.addEventListener("click", () => {
    if (options.reducedMotion) {
      passed += 1;
      show();
      return;
    }
    for (const animation of svg.getAnimations({ subtree: true })) animation.currentTime = 0;
  });
}
