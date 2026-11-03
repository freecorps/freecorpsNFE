// Click a building to switch its lights off for the night, click again to
// switch them back on. The wave across the town keeps running elsewhere.
export function mount(svg: SVGSVGElement, _options: { reducedMotion: boolean }): void {
  svg.classList.add("is-live");
  for (const building of svg.querySelectorAll<SVGGElement>(".bldg")) {
    building.addEventListener("click", () => building.classList.toggle("dark"));
  }
}
