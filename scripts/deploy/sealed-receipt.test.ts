import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ageBinaries, hasAge as ageAvailable } from "../../tests/helpers/age";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import plan from "../../deploy/offsite-backup.json";
import {
  ageEncrypt,
  custodyRecipients,
  PUBLIC_RECEIPT,
  SEALED_RECEIPT,
  writeSealedReceipt,
} from "../lib/sealed-receipt.mjs";
import { repoUrl } from "../lib/repo-root.mjs";

const directories: string[] = [];
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "fnfe-sealed-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const receipt = { action: "list", result: "passed", runId: "4242", summary: { companies: 1 } };
const sensitive = { value: { companies: [{ name: "Empresa Sintética Ltda", companyId: "c1" }] } };

describe("recibo público e recibo cifrado dos workflows", () => {
  it("lê as chaves dos custodiantes do plano de backup", () => {
    const recipients = custodyRecipients(plan);
    expect(recipients.length).toBeGreaterThanOrEqual(2);
    for (const bad of [{}, { recipients: [] }, { recipients: [{ recipient: "age1curta" }] }])
      expect(() => custodyRecipients(bad)).toThrow();
  });

  it("deixa no público só o resumo e o hash, e cifra a resposta completa", () => {
    const directory = scratch();
    let received = "";
    const shown = writeSealedReceipt({
      directory,
      receipt,
      sensitive,
      plan,
      encrypt: (plaintext, recipients) => {
        received = plaintext;
        expect(recipients).toEqual(custodyRecipients(plan));
        return Buffer.from("cifrado");
      },
    });
    const published = readFileSync(join(directory, PUBLIC_RECEIPT), "utf8");
    expect(published).not.toContain("Empresa Sintética");
    expect(JSON.parse(published)).toEqual(shown);
    expect(shown.sealed).toEqual({
      sha256: sha256(received),
      state: "sealed",
      file: SEALED_RECEIPT,
      ciphertextSha256: sha256("cifrado"),
    });
    expect(JSON.parse(received)).toEqual({ ...receipt, ...sensitive });
    expect(readFileSync(join(directory, SEALED_RECEIPT), "utf8")).toBe("cifrado");
  });

  it("sem cifra, registra a falta e não grava nada sensível", () => {
    for (const encrypt of [
      () => null,
      () => Buffer.alloc(0),
      () => {
        throw new Error("age ausente");
      },
    ]) {
      const directory = scratch();
      writeFileSync(join(directory, SEALED_RECEIPT), "de um run anterior");
      const shown = writeSealedReceipt({ directory, receipt, sensitive, plan, encrypt });
      expect(shown.sealed).toMatchObject({ state: "unavailable" });
      expect(existsSync(join(directory, SEALED_RECEIPT))).toBe(false);
      expect(readFileSync(join(directory, PUBLIC_RECEIPT), "utf8")).not.toContain("Empresa");
    }
    const directory = scratch();
    const shown = writeSealedReceipt({
      directory,
      receipt,
      sensitive,
      plan: {},
      encrypt: () => Buffer.from("x"),
    });
    expect(shown.sealed).toMatchObject({ state: "unavailable" });
    // A plan that cannot be read leaves the run's outcome alone: the receipt only lacks the seal.
    const unreadable = writeSealedReceipt({
      directory: scratch(),
      receipt,
      sensitive,
      plan: () => {
        throw new Error("ENOENT deploy/offsite-backup.json");
      },
      encrypt: () => Buffer.from("x"),
    });
    expect(unreadable).toMatchObject({ result: "passed", sealed: { state: "unavailable" } });
    expect(
      writeSealedReceipt({
        directory: scratch(),
        receipt,
        sensitive,
        plan: () => plan,
        encrypt: () => Buffer.from("x"),
      }).sealed,
    ).toMatchObject({ state: "sealed" });
  });

  it("uma recusa sem resposta do Convex grava só o recibo público", () => {
    const directory = scratch();
    const refused = { action: "list", result: "refused", code: "RUN_INVALID" };
    expect(writeSealedReceipt({ directory, receipt: refused })).toEqual(refused);
    expect(existsSync(join(directory, SEALED_RECEIPT))).toBe(false);
  });

  it("passa os destinatários ao age pela entrada, sem stderr no resultado", () => {
    const calls: { bin: string; args: string[]; input: unknown }[] = [];
    const spawn = ((bin: string, args: string[], options: { input: unknown }) => {
      calls.push({ bin, args, input: options.input });
      return { status: 0, stdout: Buffer.from("ok"), stderr: Buffer.from("") };
    }) as unknown as typeof spawnSync;
    expect(ageEncrypt("texto", ["age1a", "age1b"], { bin: "/bin/age", spawn })?.toString()).toBe(
      "ok",
    );
    expect(calls).toEqual([
      { bin: "/bin/age", args: ["-r", "age1a", "-r", "age1b"], input: "texto" },
    ]);
    const failing = (() => ({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("segredo"),
    })) as unknown as typeof spawnSync;
    expect(ageEncrypt("texto", ["age1a"], { spawn: failing })).toBeNull();
    const missing = (() => ({
      error: new Error("ENOENT"),
      status: null,
    })) as unknown as typeof spawnSync;
    expect(ageEncrypt("texto", ["age1a"], { spawn: missing })).toBeNull();
  });

  const { age, keygen } = ageBinaries();
  const hasAge = ageAvailable();
  it.skipIf(!hasAge)("com o age instalado, o custodiante decifra a resposta completa", () => {
    const directory = scratch();
    const identity = join(directory, "identity.txt");
    expect(spawnSync(keygen, ["-o", identity], { windowsHide: true }).status).toBe(0);
    const recipient = spawnSync(keygen, ["-y", identity], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim();
    const shown = writeSealedReceipt({
      directory,
      receipt,
      sensitive,
      plan: { recipients: [{ recipient }] },
      encrypt: (plaintext, recipients) => ageEncrypt(plaintext, recipients, { bin: age }),
    });
    expect(shown.sealed).toMatchObject({ state: "sealed" });
    const opened = spawnSync(age, ["-d", "-i", identity, join(directory, SEALED_RECEIPT)], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout;
    expect(JSON.parse(opened)).toEqual({ ...receipt, ...sensitive });
    expect(sha256(opened)).toBe((shown.sealed as { sha256: string }).sha256);
  });
});

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
};
type Workflow = { env?: Record<string, string>; jobs: Record<string, { steps: Step[] }> };
const workflow = (file: string) =>
  parse(readFileSync(new URL(`.github/workflows/${file}`, repoUrl), "utf8")) as Workflow;

describe("workflows de operação no repositório público", () => {
  const backup = workflow("offsite-backup.yml").env!;
  const operational = [
    ["capture-fiscal.yml", "capture-release"],
    ["nfse-gate-emergency.yml", "issuance-gate"],
    ["nfse-gate-enable.yml", "issuance-gate"],
    ["nfse-production-probe.yml", "issuance-gate"],
  ] as const;

  it.each(operational)(
    "%s: instala o age fixado sem bloquear a ação e publica só os dois recibos",
    (file, directory) => {
      const job = Object.values(workflow(file).jobs).find((each) =>
        each.steps.some((step) => step.env?.CONVEX_DEPLOY_KEY),
      )!;
      const install = job.steps.findIndex((step) => step.name?.includes("Install pinned age"));
      const runner = job.steps.findIndex((step) => step.env?.CONVEX_DEPLOY_KEY);
      expect(install).toBeGreaterThanOrEqual(0);
      expect(install).toBeLessThan(runner);
      const step = job.steps[install]!;
      expect(step["continue-on-error"]).toBe(true);
      // The same release and checksum the backup verifies.
      expect(step.env).toEqual({ AGE_VERSION: backup.AGE_VERSION, AGE_SHA256: backup.AGE_SHA256 });
      expect(step.run).toContain("sha256sum -c -");
      const upload = job.steps.find((each) => each.uses?.startsWith("actions/upload-artifact@"))!;
      expect(
        upload
          .with!.path.trim()
          .split("\n")
          .map((line) => line.trim()),
      ).toEqual([
        `.ci-results/${directory}/${PUBLIC_RECEIPT}`,
        `.ci-results/${directory}/${SEALED_RECEIPT}`,
      ]);
    },
  );
});
