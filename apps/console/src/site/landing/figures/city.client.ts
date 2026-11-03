// Tap (or click) a tower to keep it fully lit; tap again to hand it back to
// the wave. Hover lighting is pure CSS (city.css).
export function mount(svg: SVGSVGElement, _options: { reducedMotion: boolean }): void {
  for (const tower of svg.querySelectorAll<SVGGElement>(".ct-tower")) {
    tower.addEventListener("click", () => tower.classList.toggle("on"));
  }
}
