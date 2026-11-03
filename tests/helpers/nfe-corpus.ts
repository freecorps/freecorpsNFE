import { readFileSync } from "node:fs";
import type { CheckResult } from "../../packages/fiscal-core/src/index";
import type { Validation } from "../../packages/fiscal-nfe/src/index";

export const corpusRoot = new URL("../fixtures/nfe/4.00/", import.meta.url);
export const corpus: {
  parser: string;
  normalizer: string;
  rule: string;
  evaluatedAt: string;
  cases: Array<{
    id: string;
    path: string;
    sha256: string;
    expected: Partial<Record<keyof Validation, CheckResult["status"]>>;
    expectedCodes: Record<keyof Validation, string>;
  }>;
} = JSON.parse(readFileSync(new URL("manifest.json", corpusRoot), "utf8"));
export const fixture = (id: string) =>
  readFileSync(new URL(corpus.cases.find((c) => c.id === id)!.path, corpusRoot));
