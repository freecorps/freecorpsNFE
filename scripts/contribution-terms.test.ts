import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { acceptanceSentence, termsDecision, TRUSTED_ASSOCIATIONS } from "./contribution-terms.mjs";

const terms = readFileSync(new URL("../CONTRIBUICOES.md", import.meta.url), "utf8");
const sentence = acceptanceSentence(terms);
const normalizeIncludes = (text: string) =>
  text
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .includes(sentence);
// The sentence as a contributor pastes it from CONTRIBUICOES.md, blockquote included.
const quoted = terms
  .slice(terms.indexOf("Para aceitação"))
  .split("\n")
  .filter((line) => line.startsWith(">"))
  .join("\n");

describe("termos de contribuição na PR", () => {
  it("lê a frase de aceite do próprio CONTRIBUICOES.md", () => {
    expect(sentence).toMatch(/^li e aceito os termos de contribuição freecorps 1\.0/);
    expect(sentence).toContain("conservo minha autoria");
  });

  it("deixa passar quem já tem direitos ou escrita no repositório e os bots", () => {
    for (const association of TRUSTED_ASSOCIATIONS)
      expect(termsDecision({ association, body: "", sentence }).ok).toBe(true);
    expect(termsDecision({ association: "NONE", authorType: "Bot", sentence }).ok).toBe(true);
  });

  it("exige a frase de aceite de quem vem de fora, colada como citação ou não", () => {
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]) {
      expect(termsDecision({ association, authorType: "User", body: "", sentence }).ok).toBe(false);
      expect(
        termsDecision({
          association,
          authorType: "User",
          body: `Correção.\n\n${quoted}\n`,
          sentence,
        }).ok,
      ).toBe(true);
      const plain = quoted.replace(/^>\s?/gm, "").replace(/\n/g, " ");
      expect(termsDecision({ association, body: plain.toUpperCase(), sentence }).ok).toBe(true);
    }
    // The PR template keeps the sentence in an HTML comment: untouched, it is not an acceptance.
    const template = readFileSync(
      new URL("../.github/pull_request_template.md", import.meta.url),
      "utf8",
    );
    expect(normalizeIncludes(template)).toBe(true);
    expect(termsDecision({ association: "NONE", body: template, sentence }).ok).toBe(false);
    // A partial sentence is not an acceptance.
    const partial = quoted.split("\n").slice(0, 1).join("\n");
    expect(termsDecision({ association: "NONE", body: partial, sentence }).ok).toBe(false);
    expect(termsDecision({ association: undefined, body: undefined, sentence }).ok).toBe(false);
  });

  it("o workflow roda o check da base, sem código da PR nem segredo", () => {
    type Step = {
      uses?: string;
      run?: string;
      with?: Record<string, string>;
      env?: Record<string, string>;
    };
    const workflow = parse(
      readFileSync(new URL("../.github/workflows/contribution-terms.yml", import.meta.url), "utf8"),
    ) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, { permissions: Record<string, string>; steps: Step[] }>;
    };
    expect(Object.keys(workflow.on)).toEqual(["pull_request_target"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const { steps, permissions } = workflow.jobs.terms!;
    expect(permissions).toEqual({ contents: "read" });
    const text = readFileSync(
      new URL("../.github/workflows/contribution-terms.yml", import.meta.url),
      "utf8",
    );
    expect(text).not.toMatch(/secrets\./);
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    for (const step of steps) if (step.run) expect(step.run).not.toContain("${{");
    expect(steps.map((step) => step.run).filter(Boolean)).toEqual([
      "node scripts/contribution-terms.mjs",
    ]);
  });
});
