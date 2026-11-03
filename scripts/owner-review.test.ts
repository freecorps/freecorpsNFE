import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { dispatcherOf, ownerReview, ownersOf, parseCodeowners } from "./lib/owner-review.mjs";

// A forma do CODEOWNERS real: um dono só, por decisão do dono do projeto de 26/10/2026.
const codeowners = `# donos
/.github/workflows/ @dona-do-projeto
/deploy/ @dona-do-projeto
/scripts/deploy-platform.mjs @dona-do-projeto
`;
// Um segundo dono hipotético, para o caminho da PR aprovada por outra pessoa.
const twoOwners = codeowners.replaceAll("@dona-do-projeto", "@dona-do-projeto @outro-dono");
const from = "a".repeat(40);
const to = "f".repeat(40);
const head = "e".repeat(40);

/** Histórico sintético: cada commit com o pai e os arquivos que mudou. */
function history(commits: { sha: string; files: string[] }[]) {
  return (args: string[]) => {
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-list")
      return commits
        .map((commit, index) => `${commit.sha} ${index ? commits[index - 1].sha : from}`)
        .join("\n");
    if (args[0] === "diff")
      return commits.find((commit) => commit.sha === args.at(-1))!.files.join("\n");
    throw new Error(args.join(" "));
  };
}

/** API do GitHub sintética: autor de cada commit, PR de cada commit e revisões. */
function api({
  authors,
  pulls = {},
  reviews = {},
}: {
  authors: Record<string, string | null>;
  pulls?: Record<string, unknown[]>;
  reviews?: Record<number, unknown[]>;
}) {
  return async (path: string) => {
    let match = /^commits\/(\w+)\/pulls/.exec(path);
    if (match) return pulls[match[1]] ?? [];
    match = /^commits\/(\w+)$/.exec(path);
    if (match) return { author: authors[match[1]] ? { login: authors[match[1]] } : null };
    match = /^pulls\/(\d+)\/reviews/.exec(path);
    if (match) return reviews[Number(match[1])] ?? [];
    throw new Error(path);
  };
}

const merged = (number: number, author: string) => ({
  number,
  merged_at: "2026-10-26T00:00:00Z",
  base: { ref: "main" },
  head: { sha: head },
  user: { login: author },
});
const review = (login: string, state = "APPROVED", commit = head) => ({
  user: { login },
  state,
  commit_id: commit,
});
const gate = (
  commits: { sha: string; files: string[] }[],
  github: ReturnType<typeof api>,
  dispatcher?: string,
  file = codeowners,
) =>
  ownerReview({
    from,
    to,
    run: history(commits),
    github,
    codeowners: { from: file, to: file },
    dispatcher,
  });

it("reads the CODEOWNERS of the repository, with wolf-stievano as its only owner, and refuses forms it does not understand", () => {
  const rules = parseCodeowners(readFileSync(".github/CODEOWNERS", "utf8"));
  expect(rules.length).toBeGreaterThan(50);
  expect([...new Set(rules.flatMap((rule) => rule.owners))]).toEqual(["wolf-stievano"]);
  expect(ownersOf("scripts/deploy-platform.mjs", rules)).toEqual(["wolf-stievano"]);
  expect(ownersOf(".github/workflows/deploy.yml", rules)).toEqual(["wolf-stievano"]);
  expect(ownersOf("scripts/lib/owner-review.mjs", rules)).toEqual(["wolf-stievano"]);
  expect(ownersOf("platform/convex/captureProcessing.ts", rules)).toEqual(["wolf-stievano"]);
  expect(ownersOf("docs/README.md", rules)).toEqual([]);
  expect(ownersOf("deployer.md", parseCodeowners("/deploy/ @a"))).toEqual([]);
  expect(ownersOf("deploy", parseCodeowners("/deploy @a"))).toEqual(["a"]);
  for (const line of ["*.mjs @a", "deploy/ @a", "/deploy/** @a", "/deploy/ a", "/deploy/"])
    expect(() => parseCodeowners(line), line).toThrow();
});

it("lets commits that touch no protected path through without asking GitHub", async () => {
  const result = await gate(
    [{ sha: "1".repeat(40), files: ["docs/README.md"] }],
    api({ authors: {} }),
  );
  expect(result).toEqual({ problems: [], checked: [] });
});

it("accepts a protected commit of a merged pull request approved by another owner at its head", async () => {
  const sha = "1".repeat(40);
  const result = await gate(
    [{ sha, files: ["scripts/deploy-platform.mjs", "docs/README.md"] }],
    api({
      authors: { [sha]: "dona-do-projeto" },
      pulls: { [sha]: [merged(7, "dona-do-projeto")] },
      reviews: { 7: [review("outro-dono")] },
    }),
    undefined,
    twoOwners,
  );
  expect(result.problems).toEqual([]);
  expect(result.checked).toEqual([
    {
      sha,
      files: ["scripts/deploy-platform.mjs"],
      author: "dona-do-projeto",
      via: "pull",
      pull: 7,
      approvers: ["outro-dono"],
    },
  ]);
});

it("refuses self approval, stale or withdrawn approvals, non-owners and commits without a pull request", async () => {
  const sha = "1".repeat(40);
  const files = [".github/workflows/deploy.yml"];
  const cases: Record<string, { reviews: unknown[]; author: string | null; prAuthor?: string }> = {
    "aprovação do próprio autor": {
      reviews: [review("dona-do-projeto")],
      author: "dona-do-projeto",
    },
    "aprovação de commit anterior": {
      reviews: [review("outro-dono", "APPROVED", "d".repeat(40))],
      author: "dona-do-projeto",
    },
    "aprovação retirada": {
      reviews: [review("outro-dono"), review("outro-dono", "CHANGES_REQUESTED")],
      author: "dona-do-projeto",
    },
    "quem não é dono": { reviews: [review("someone")], author: "dona-do-projeto" },
    "autor do commit aprova a PR de outro": {
      reviews: [review("outro-dono")],
      author: "outro-dono",
      prAuthor: "dona-do-projeto",
    },
    "autor sem conta": { reviews: [review("outro-dono")], author: null },
  };
  for (const [label, { reviews, author, prAuthor }] of Object.entries(cases)) {
    const result = await gate(
      [{ sha, files }],
      api({
        authors: { [sha]: author },
        pulls: { [sha]: [merged(9, prAuthor ?? author ?? "dona-do-projeto")] },
        reviews: { 9: reviews },
      }),
      undefined,
      twoOwners,
    );
    expect(result.problems, label).toHaveLength(1);
  }
  const direct = await gate(
    [{ sha, files }],
    api({ authors: { [sha]: "dona-do-projeto" } }),
    undefined,
    twoOwners,
  );
  expect(direct.problems[0]).toMatch(
    /^1111111 toca \.github\/workflows\/deploy\.yml sem aprovação/,
  );
  const open = await gate(
    [{ sha, files }],
    api({
      authors: { [sha]: "dona-do-projeto" },
      pulls: { [sha]: [{ ...merged(9, "dona-do-projeto"), merged_at: null }] },
      reviews: { 9: [review("outro-dono")] },
    }),
    undefined,
    twoOwners,
  );
  expect(open.problems).toHaveLength(1);
});

it("counts the owner's dispatch as approval of the whole SHA, including the owner's own commits", async () => {
  const mine = "1".repeat(40);
  const theirs = "2".repeat(40);
  const noAccount = "3".repeat(40);
  const commits = [
    { sha: mine, files: ["deploy/platform-release.json"] },
    { sha: theirs, files: ["scripts/deploy-platform.mjs"] },
    { sha: noAccount, files: [".github/workflows/deploy.yml"] },
  ];
  const github = api({
    authors: { [mine]: "dona-do-projeto", [theirs]: "someone", [noAccount]: null },
  });
  const dispatched = await gate(commits, github, "dona-do-projeto");
  expect(dispatched.problems).toEqual([]);
  expect(dispatched.checked.map((proof) => [proof.sha, proof.via, proof.approvers])).toEqual([
    [mine, "dispatch", ["dona-do-projeto"]],
    [theirs, "dispatch", ["dona-do-projeto"]],
    [noAccount, "dispatch", ["dona-do-projeto"]],
  ]);
  // Quem não é dono não aprova nada, nem o que não escreveu.
  const byOther = await gate(commits, github, "someone");
  expect(byOther.checked).toEqual([]);
  expect(byOther.problems).toHaveLength(3);
});

it("refuses on a push the owner's protected commit: a push approves nothing by itself", async () => {
  const sha = "1".repeat(40);
  const commits = [{ sha, files: ["deploy/platform-release.json", "docs/README.md"] }];
  const github = api({ authors: { [sha]: "dona-do-projeto" } });
  const pushed = await gate(commits, github);
  expect(pushed.checked).toEqual([]);
  expect(pushed.problems).toEqual([
    "1111111 toca deploy/platform-release.json sem aprovação de um dono (autor dona-do-projeto)",
  ]);
  expect((await gate(commits, github, "dona-do-projeto")).problems).toEqual([]);
});

it("does not let a dispatcher approve a CODEOWNERS that makes them an owner, nor an owner the range removed", async () => {
  const sha = "1".repeat(40);
  const github = api({ authors: { [sha]: "intruso" } });
  const dispatch = (dispatcher: string, file: { from: string; to: string }) =>
    ownerReview({
      from,
      to,
      run: history([{ sha, files: [".github/workflows/deploy.yml", "deploy/x.json"] }]),
      github,
      codeowners: file,
      dispatcher,
    });
  const selfAdded = { from: codeowners, to: twoOwners.replaceAll("outro-dono", "intruso") };
  expect((await dispatch("intruso", selfAdded)).problems).toHaveLength(1);
  expect((await dispatch("dona-do-projeto", selfAdded)).problems).toEqual([]);
  // Quem a faixa tira do CODEOWNERS já não aprova por dispatch.
  const removed = { from: twoOwners, to: codeowners };
  expect((await dispatch("outro-dono", removed)).problems).toHaveLength(1);
  expect((await dispatch("dona-do-projeto", removed)).problems).toEqual([]);
});

it("accepts a pull request approval only from an owner of the path in each CODEOWNERS version", async () => {
  const sha = "1".repeat(40);
  const files = ["deploy/platform-release.json", "platform/convex/captures.ts"];
  const approvedBy = (approver: string, file: { from: string; to: string }) =>
    ownerReview({
      from,
      to,
      run: history([{ sha, files }]),
      github: api({
        authors: { [sha]: "dona-do-projeto" },
        pulls: { [sha]: [merged(7, "dona-do-projeto")] },
        reviews: { 7: [review(approver)] },
      }),
      codeowners: file,
    });
  // Outra pessoa é dona só no CODEOWNERS publicado, não no novo.
  const real = readFileSync(".github/CODEOWNERS", "utf8");
  const published = real.replaceAll(" @wolf-stievano", " @wolf-stievano @outra-pessoa");
  expect((await approvedBy("outra-pessoa", { from: published, to: real })).problems).toHaveLength(
    1,
  );
  // Quem o próprio commit põe no CODEOWNERS também não aprova.
  expect((await approvedBy("outra-pessoa", { from: real, to: published })).problems).toHaveLength(
    1,
  );
  // Dono nas duas versões, a mesma aprovação passa.
  const both = await approvedBy("outra-pessoa", { from: published, to: published });
  expect(both.problems).toEqual([]);
  expect(both.checked[0]).toMatchObject({ via: "pull", pull: 7, approvers: ["outra-pessoa"] });
});

it("takes the dispatcher from a workflow_dispatch only when the same person triggered the attempt", () => {
  const dispatch = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTOR: "dona-do-projeto",
    GITHUB_TRIGGERING_ACTOR: "dona-do-projeto",
  };
  expect(dispatcherOf(dispatch)).toBe("dona-do-projeto");
  // Repetir o dispatch de outra pessoa não herda a aprovação dela.
  expect(dispatcherOf({ ...dispatch, GITHUB_TRIGGERING_ACTOR: "someone" })).toBeNull();
  // Sem saber quem disparou a tentativa, ninguém aprova.
  expect(dispatcherOf({ ...dispatch, GITHUB_TRIGGERING_ACTOR: undefined })).toBeNull();
  expect(dispatcherOf({ ...dispatch, GITHUB_EVENT_NAME: "push" })).toBeNull();
  expect(dispatcherOf({ ...dispatch, GITHUB_ACTOR: undefined })).toBeNull();
});

it("refuses an unknown or unrelated published revision unless an owner dispatches", async () => {
  const github = api({ authors: {} });
  const run = history([]);
  const unknown = { from: null, to, run, github, codeowners: { from: null, to: codeowners } };
  expect((await ownerReview(unknown)).problems).toHaveLength(1);
  expect((await ownerReview({ ...unknown, dispatcher: "DONA-DO-PROJETO" })).problems).toEqual([]);
  expect((await ownerReview({ ...unknown, dispatcher: "someone" })).problems).toHaveLength(1);
  const unrelated = await ownerReview({
    ...unknown,
    from,
    codeowners: { from: codeowners, to: codeowners },
    run: () => {
      throw new Error("not an ancestor");
    },
  });
  expect(unrelated.problems).toEqual([`${from} não é ancestral de ${to}`]);
});

it("refuses a known published revision whose CODEOWNERS it cannot read, even on the owner's dispatch", async () => {
  const sha = "1".repeat(40);
  const review = (published: string | null) =>
    ownerReview({
      from,
      to,
      run: history([{ sha, files: ["deploy/platform-release.json"] }]),
      github: api({ authors: { [sha]: "dona-do-projeto" } }),
      codeowners: { from: published, to: codeowners },
      dispatcher: "dona-do-projeto",
    });
  expect((await review(null)).problems).toEqual([
    `CODEOWNERS ilegível na revisão publicada ${from}; o gate não confere a faixa`,
  ]);
  expect((await review(codeowners)).problems).toEqual([]);
});

it("lets the owner's dispatch approve a path protected only in the published CODEOWNERS", async () => {
  const sha = "1".repeat(40);
  const published = `${codeowners}/scripts/old-publisher.mjs @dona-do-projeto
`;
  const range = (dispatcher?: string) =>
    ownerReview({
      from,
      to,
      run: history([{ sha, files: ["scripts/old-publisher.mjs"] }]),
      github: api({ authors: { [sha]: "dona-do-projeto" } }),
      codeowners: { from: published, to: codeowners },
      dispatcher,
    });
  expect((await range()).problems).toHaveLength(1);
  const dispatched = await range("dona-do-projeto");
  expect(dispatched.problems).toEqual([]);
  expect(dispatched.checked[0]).toMatchObject({ via: "dispatch", approvers: ["dona-do-projeto"] });
});

it("locks a path whose owner one publication replaces, until the change goes in two publications", async () => {
  const sha = "1".repeat(40);
  const reassigned = codeowners.replace("/deploy/ @dona-do-projeto", "/deploy/ @outro-dono");
  const added = codeowners.replace(
    "/deploy/ @dona-do-projeto",
    "/deploy/ @dona-do-projeto @outro-dono",
  );
  const dispatch = (dispatcher: string, file: { from: string; to: string }) =>
    ownerReview({
      from,
      to,
      run: history([{ sha, files: ["deploy/platform-release.json"] }]),
      github: api({ authors: { [sha]: "dona-do-projeto" } }),
      codeowners: file,
      dispatcher,
    });
  // Nenhum dos dois é dono de deploy/ nas duas versões: a publicação fica fechada.
  for (const dispatcher of ["dona-do-projeto", "outro-dono"])
    expect(
      (await dispatch(dispatcher, { from: codeowners, to: reassigned })).problems,
    ).toHaveLength(1);
  // A saída: primeiro somar o novo dono e publicar, depois tirar o antigo.
  expect((await dispatch("dona-do-projeto", { from: codeowners, to: added })).problems).toEqual([]);
  expect((await dispatch("outro-dono", { from: added, to: reassigned })).problems).toEqual([]);
});

it("keeps a path protected when the range removes it from CODEOWNERS", async () => {
  const sha = "1".repeat(40);
  const result = await ownerReview({
    from,
    to,
    run: history([{ sha, files: ["deploy/platform-release.json"] }]),
    github: api({ authors: { [sha]: "dona-do-projeto" } }),
    codeowners: { from: codeowners, to: "/.github/ @dona-do-projeto\n" },
  });
  expect(result.problems).toHaveLength(1);
});

it("lets the deploy workflow read pull requests and protects the gate itself", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
  expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
  const rules = parseCodeowners(readFileSync(".github/CODEOWNERS", "utf8"));
  expect(ownersOf("scripts/lib/platform-unchanged.mjs", rules)).not.toEqual([]);
});

it("protects every module the publisher and its build scripts import, which run beside the keys", () => {
  const rules = parseCodeowners(readFileSync(".github/CODEOWNERS", "utf8"));
  const graph = new Set<string>();
  const visit = (file: string) => {
    if (graph.has(file)) return;
    graph.add(file);
    const source = readFileSync(file, "utf8");
    // Static `from`, side-effect `import "…"`, dynamic `import(…)` and `require(…)`, any quote.
    const relative =
      /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g;
    for (const [, , specifier] of source.matchAll(relative)) {
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (existsSync(target)) visit(target);
    }
  };
  // The publisher and the scripts it spawns with run(): same user, same runner.
  const publisher = "scripts/deploy-platform.mjs";
  const spawned = [
    ...readFileSync(publisher, "utf8").matchAll(/\brun\(\s*(["'`])(scripts\/[^"'`]+)\1/g),
  ].map(([, , script]) => script);
  expect(spawned).toEqual(["scripts/build-fiscal-packages.mjs", "scripts/selfhost.mjs"]);
  for (const entry of [publisher, ...spawned]) visit(entry);
  expect(graph).toContain("scripts/lib/selfhost-server.mjs");
  expect([...graph].filter((file) => !ownersOf(file, rules).length)).toEqual([]);
});

it("protects the lockfile and the manifest of the root and of every workspace", () => {
  const rules = parseCodeowners(readFileSync(".github/CODEOWNERS", "utf8"));
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const manifests = ["bun.lock", "package.json"];
  for (const workspace of root.workspaces as string[]) {
    const parent = workspace.replace(/\/\*$/, "");
    const directories = workspace.endsWith("/*")
      ? readdirSync(parent, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${parent}/${entry.name}`)
      : [workspace];
    for (const directory of directories)
      if (existsSync(`${directory}/package.json`)) manifests.push(`${directory}/package.json`);
  }
  expect(manifests.length).toBeGreaterThan(5);
  expect(manifests.filter((file) => !ownersOf(file, rules).length)).toEqual([]);
});
