import { afterEach, beforeEach, vi } from "vite-plus/test";

// O offline.ts dos testes de navegador (projeto console-browser): a página não tem `node:http`,
// e a rede da tela sai por `fetch` e `XMLHttpRequest`. Nenhum dos dois chega à rede sem um
// substituto explícito do teste; uma tentativa reprova o teste mesmo quando o código captura o
// erro. Como offline.ts, pega chamadas acidentais, não é sandbox de rede.
let attempted = false;
function blocked(): never {
  attempted = true;
  throw new Error("Unmocked HTTP is forbidden in the browser test suite");
}
class BlockedXMLHttpRequest {
  open() {
    blocked();
  }
  send() {
    blocked();
  }
}
beforeEach(() => {
  attempted = false;
  vi.stubGlobal("fetch", blocked);
  vi.stubGlobal("XMLHttpRequest", BlockedXMLHttpRequest);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (attempted)
    throw new Error("A test attempted unmocked HTTP, even if its code caught the error");
});
