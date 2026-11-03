// Clicking the card machine (or anywhere on the figure) charges the card: it
// plays the same sequence as "Simular pagamento", restarting it if it already ran.
export function mount(svg: SVGSVGElement, _options: { reducedMotion: boolean }): void {
  const scene = svg.closest<HTMLElement>("[data-stripe]");
  if (!scene) return;
  svg.addEventListener("click", () => {
    scene.classList.remove("paid");
    void scene.offsetWidth;
    scene.classList.add("paid");
  });
}
