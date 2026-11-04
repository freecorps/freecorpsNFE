import { describe, expect, it } from "vite-plus/test";
import { captureArgs, capturePlan, judgeCapture, screens, states, stopDecision } from "./lib.mjs";

const seed = {
  data: { slug: "verificacao-1", companyId: "c1", projectId: "p1" },
  empty: { slug: "vazia-1" },
};

describe("argumentos de capture-screens", () => {
  it("exige um rótulo curto e aceita filtros de tela e estado", () => {
    expect(captureArgs(["--label", "antes"])).toEqual({
      label: "antes",
      screens: [],
      states: [],
      help: false,
    });
    expect(
      captureArgs(["--label", "depois", "--screen", "chaves", "--state", "erro", "--state", "vazio"]),
    ).toMatchObject({ screens: ["chaves"], states: ["erro", "vazio"] });
    expect(captureArgs(["--help"]).help).toBe(true);
  });

  it("recusa rótulo ausente ou inválido, tela e estado desconhecidos", () => {
    expect(() => captureArgs([])).toThrow("--label");
    expect(() => captureArgs(["--label", "Antes Da Mudança"])).toThrow("--label");
    expect(() => captureArgs(["--label", "antes", "--screen", "faturas"])).toThrow("Tela");
    expect(() => captureArgs(["--label", "antes", "--state", "lento"])).toThrow("Estado");
    expect(() => captureArgs(["--label"])).toThrow("exige um valor");
    expect(() => captureArgs(["--label", "antes", "--fix"])).toThrow("desconhecido");
  });
});

describe("plano de capturas", () => {
  it("cobre as cinco telas nos quatro estados", () => {
    const plan = capturePlan(seed);
    expect(plan).toHaveLength(screens.length * states.length);
    expect(new Set(plan.map((capture) => capture.file)).size).toBe(plan.length);
    expect(screens.map((screen) => screen.id)).toEqual([
      "organizacao",
      "empresas",
      "documentos",
      "chaves",
      "webhooks",
    ]);
  });

  it("usa a organização com dados, a vazia e identificadores forjados no erro", () => {
    const path = (screen: string, state: string) =>
      capturePlan(seed, { screens: [screen], states: [state] })[0]!.path;
    expect(path("documentos", "dados")).toBe("/app/verificacao-1/documents?company=c1");
    expect(path("documentos", "carregando")).toBe(path("documentos", "dados"));
    expect(path("chaves", "vazio")).toBe("/app/vazia-1/developer/keys");
    expect(path("webhooks", "dados")).toBe("/app/verificacao-1/developer/webhooks/p1");
    expect(path("organizacao", "erro")).toBe("/app/organizacao-inexistente");
    expect(path("empresas", "erro")).toContain("empresa-inexistente");
  });
});

describe("veredito da captura", () => {
  it("confere cada estado pelo que a tela mostrou", () => {
    const data = { heading: "Início", busy: false, alert: false };
    expect(judgeCapture("dados", data)).toBe("conforme");
    expect(judgeCapture("vazio", { ...data, busy: true })).toMatch(/^divergente/);
    expect(judgeCapture("dados", { ...data, alert: true })).toMatch(/^divergente/);
    expect(judgeCapture("dados", { ...data, heading: "" })).toMatch(/^divergente/);
    expect(judgeCapture("erro", { ...data, alert: true })).toBe("conforme");
    expect(judgeCapture("erro", data)).toMatch(/^divergente/);
    expect(judgeCapture("carregando", { ...data, busy: true })).toBe("conforme");
    expect(judgeCapture("carregando", data)).toMatch(/^não exercitado/);
  });
});

describe("parada do dev", () => {
  const record = { startedBySkill: true, pid: 42, identity: "abc" };

  it("encerra só o dev que a skill iniciou, com a mesma identidade", () => {
    expect(stopDecision(record, "abc").stop).toBe(true);
    expect(stopDecision(null, null).stop).toBe(false);
    expect(stopDecision({ startedBySkill: false }, null).stop).toBe(false);
    expect(stopDecision(record, null)).toMatchObject({ stop: false, reason: /terminou/ });
    expect(stopDecision(record, "outro")).toMatchObject({ stop: false, reason: /outro processo/ });
  });
});
