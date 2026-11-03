import { describe, expect, it, vi } from "vite-plus/test";
import { publicationSha } from "./lib/ci.mjs";
import { GATE_WORKFLOWS, verifiedRun } from "./lib/issuance-gate.mjs";
import {
  isProjectRepository,
  LOCAL_REPOSITORY,
  PROJECT_REPOSITORIES,
  projectRepository,
} from "./lib/repository.mjs";
import { requireIntegrationWriter } from "./lib/validation.mjs";
import { checkPublication, requireRehearsalWindow } from "./lib/validation-deploy.mjs";

// Desde a virada de 03/11/2026 (decisão 6 de docs/v1.0/ACCEPTANCE.md), só o
// repositório público é origem aceita; o arquivado é recusado como qualquer outro.
const sha = "a".repeat(40);
const other = "external/freecorpsNFE";
const archived = "freecorps/freecorpsNFE-arquivo";

describe("nomes do repositório do projeto", () => {
  it("aceita só o repositório público", () => {
    expect(PROJECT_REPOSITORIES).toEqual(["freecorps/freecorpsNFE"]);
    expect(LOCAL_REPOSITORY).toBe("freecorps/freecorpsNFE");
    for (const name of PROJECT_REPOSITORIES) expect(isProjectRepository(name)).toBe(true);
    for (const name of [other, archived, "freecorps/freecorpsnfe", "", undefined])
      expect(isProjectRepository(name)).toBe(false);
  });

  it("consulta o repositório do run e, fora dele, o local", () => {
    expect(projectRepository({ GITHUB_REPOSITORY: "freecorps/freecorpsNFE" })).toBe(
      "freecorps/freecorpsNFE",
    );
    expect(projectRepository({ GITHUB_REPOSITORY: other })).toBe(LOCAL_REPOSITORY);
    expect(projectRepository({})).toBe(LOCAL_REPOSITORY);
  });
});

describe.each(PROJECT_REPOSITORIES)("guardas de origem em %s", (repository) => {
  it("dá SHA de publicação só ao workflow de validação do mesmo repositório", () => {
    const env = {
      GITHUB_SHA: sha,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: repository,
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy-validation.yml@refs/heads/main`,
    };
    expect(publicationSha(env, sha)).toBe(sha);
    const elsewhere = archived;
    expect(
      publicationSha(
        {
          ...env,
          GITHUB_WORKFLOW_REF: `${elsewhere}/.github/workflows/deploy-validation.yml@refs/heads/main`,
        },
        sha,
      ),
    ).toBe("");
    expect(publicationSha({ ...env, GITHUB_REPOSITORY: other }, sha)).toBe("");
  });

  it("aceita a publicação e o escritor da validação vindos do projeto", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_SHA: sha,
      CI_TESTED_SHA: sha,
    };
    expect(checkPublication(env, sha)).toBe(sha);
    expect(() => checkPublication({ ...env, GITHUB_REPOSITORY: other }, sha)).toThrow();
    const pipeline = env;
    expect(() => requireIntegrationWriter(pipeline, false)).not.toThrow();
    expect(() =>
      requireIntegrationWriter({ ...pipeline, GITHUB_REPOSITORY: other }, false),
    ).toThrow();
  });

  it("confere o run do gate fiscal no próprio repositório", () => {
    const file = GATE_WORKFLOWS.probe.file;
    const env = {
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW_REF: `${repository}/${file}@refs/heads/main`,
      GITHUB_RUN_ID: "4242",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: sha,
    };
    const run = {
      id: 4242,
      run_attempt: 1,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: sha,
      path: file,
      status: "in_progress",
      repository: { full_name: repository },
      actor: { login: "ana-freecorps" },
      triggering_actor: { login: "ana-freecorps" },
    };
    const check = (patch: { env?: object; run?: object }) => {
      try {
        verifiedRun({
          action: "probe",
          env: { ...env, ...patch.env },
          run: { ...run, ...patch.run },
          approvals: [],
          config: { authorizedActors: ["ana-freecorps"] },
        });
        return "ok";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(check({ env: { GITHUB_REPOSITORY: other } })).toBe("RUN_INVALID");
    expect(check({ run: { repository: { full_name: other } } })).toBe("RUN_INVALID");
    expect(check({})).not.toBe("RUN_INVALID");
  });

  it("consulta a janela de ensaio no repositório do run", async () => {
    const request = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    await expect(
      requireRehearsalWindow("synthetic-token", request, { GITHUB_REPOSITORY: repository }),
    ).rejects.toThrow();
    expect(request.mock.calls[0][0]).toBe(
      `https://api.github.com/repos/${repository}/git/ref/heads/main`,
    );
  });
});
