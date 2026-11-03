// Aplica o tema do console antes da primeira pintura, sem piscar. A CSP só aceita scripts do
// próprio site, por isso este arquivo e não um script inline. Mesma chave e mesma regra de
// apps/console/src/ui/theme.ts. A página pública (/) segue o próprio estilo e fica de fora.
(function () {
  if (location.pathname === "/" || location.pathname === "/index.html") return;
  var preference = "system";
  try {
    var stored = localStorage.getItem("fnfe:console-theme");
    if (stored === "light" || stored === "dark") preference = stored;
  } catch {
    // Sem acesso ao armazenamento: segue o sistema.
  }
  var dark =
    preference === "dark" ||
    (preference === "system" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  // Página do painel: o HTML compartilhado traz a página pública, que landing.css esconde aqui
  // antes da primeira pintura (sem piscar a landing nem pedir as fontes dela).
  root.dataset.console = "";
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.themePreference = preference;
  // O CSS do painel chega depois (import dinâmico): fundo e controles já no tema escolhido.
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.backgroundColor = dark ? "#09100d" : "#f7f8f4";
})();
