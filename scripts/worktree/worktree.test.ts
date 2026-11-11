/**
 * O que dá para testar sem tocar em disco, git ou rede: parsing de argumento,
 * nome de pasta, contenção de caminho e leitura/escrita de arquivo de ambiente.
 *
 * O ciclo de vida em si (criar worktree, subir backend local, reservar porta)
 * não é testado aqui de propósito — ele É efeito colateral, e um teste dele
 * seria um teste do git e do CLI do Convex. O que protege aquela parte é o
 * `bun run worktree doctor`, que roda contra o worktree de verdade.
 */
import { describe, it, expect } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { optionalPort, optionalString, parseArgs, usage } from "../lib/worktree/cli.mjs";
import { formatEnvFile, parseEnv } from "../lib/worktree/env-file.mjs";
import { classifyPruneCandidate, parseBranchTracking } from "../lib/worktree/merged.mjs";
import { pruneEntries } from "../lib/worktree/registry.mjs";
import { expandHome } from "../lib/worktree/location.mjs";
import { slugifyWorktreeName, worktreePaths } from "../lib/worktree/paths.mjs";
import {
  LEGACY_SEED_PROFILE,
  assertLegacySeedProfile,
  syncWorktree,
} from "../lib/worktree/sync.mjs";

describe("parseArgs", () => {
  it("separa posicional de flag", () => {
    const { flags, positional } = parseArgs(["feat/x", "--from", "origin/main"]);
    expect(positional).toEqual(["feat/x"]);
    expect(flags.get("from")).toBe("origin/main");
  });

  it("aceita --chave=valor", () => {
    expect(parseArgs(["--dir=minha-pasta"]).flags.get("dir")).toBe("minha-pasta");
  });

  // As duas formas explícitas precisam significar o que dizem. Sem normalizar,
  // `--no-fetch=false` chegaria ao chamador como a string "false" — truthy — e
  // desligaria o fetch que o operador mandou manter, e `--no-fetch=true`
  // falharia num `=== true`. As duas leituras erradas em direções opostas.
  it("converte flag booleana escrita como --chave=valor", () => {
    expect(parseArgs(["--no-fetch=false"]).flags.get("no-fetch")).toBe(false);
    expect(parseArgs(["--no-fetch=true"]).flags.get("no-fetch")).toBe(true);
    expect(parseArgs(["--no-fetch"]).flags.get("no-fetch")).toBe(true);
  });

  it("não converte valor de flag que não é booleana", () => {
    expect(parseArgs(["--seed=false"]).flags.get("seed")).toBe("false");
  });

  // Sem a lista de flags booleanas, `--force` engoliria o próximo token — e num
  // `remove <nome> --force <outra-coisa>` isso apaga o worktree errado.
  it("não deixa flag booleana consumir o próximo token", () => {
    const { flags, positional } = parseArgs(["feat-x", "--force", "feat-y"]);
    expect(flags.get("force")).toBe(true);
    expect(positional).toEqual(["feat-x", "feat-y"]);
  });

  it("trata flag no fim da linha como true", () => {
    expect(parseArgs(["--seed"]).flags.get("seed")).toBe(true);
  });

  it("não deixa uma flag consumir outra flag como valor", () => {
    const { flags } = parseArgs(["--branch", "--force"]);
    expect(flags.get("branch")).toBe(true);
    expect(flags.get("force")).toBe(true);
  });
});

describe("optionalString / optionalPort", () => {
  // `--seed` sem valor vira `true`, que jamais é um perfil válido.
  it("descarta true e string vazia", () => {
    expect(optionalString(true)).toBeUndefined();
    expect(optionalString("")).toBeUndefined();
    expect(optionalString("completo")).toBe("completo");
  });

  it("converte porta e recusa o que não é número", () => {
    expect(optionalPort("5175")).toBe(5175);
    expect(optionalPort(undefined)).toBeUndefined();
    expect(() => optionalPort("abc")).toThrow(/número/);
  });
});

describe("usage", () => {
  it("apresenta sync como o comando que só publica funções", () => {
    expect(usage()).toMatch(/ {2}sync {12}Reaplica ambiente, schema e funções/);
    expect(usage()).toContain("sem inserir nem apagar dados");
    expect(usage()).not.toContain("--seed <perfil>");
    expect(usage()).toContain("`seed [vazio]` e `--seed vazio` equivalem a `sync`");
  });
});

describe("compatibilidade do seed vazio", () => {
  it("aceita só o nome antigo vazio ou a ausência de perfil", () => {
    for (const value of [undefined, null, "", LEGACY_SEED_PROFILE])
      expect(() => assertLegacySeedProfile(value)).not.toThrow();
    for (const value of ["basico", "completo", "demo", "true"])
      expect(() => assertLegacySeedProfile(value)).toThrow(/worktree sync/);
  });

  it("recusa sincronizar fora de um worktree linked", async () => {
    const base = mkdtempSync(join(tmpdir(), "fnfe-sync-"));
    try {
      execFileSync("git", ["init", "-q", base], { stdio: "ignore" });
      await expect(syncWorktree(worktreePaths(base))).rejects.toThrow(/worktree linked/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("slugifyWorktreeName", () => {
  it("troca a barra da branch por hífen", () => {
    expect(slugifyWorktreeName("feat/minha-coisa")).toBe("feat-minha-coisa");
  });

  it("normaliza barra invertida do Windows também", () => {
    expect(slugifyWorktreeName("fix\\issue-1")).toBe("fix-issue-1");
  });

  it("colapsa caractere que não serve em nome de pasta", () => {
    expect(slugifyWorktreeName("feat/tema: light & dark")).toBe("feat-tema-light-dark");
  });

  // Um nome que começa ou termina com ponto vira arquivo oculto ou quebra no
  // Windows; as bordas caem.
  it("apara ponto e hífen das bordas", () => {
    expect(slugifyWorktreeName("--feat/x..")).toBe("feat-x");
  });

  it("limita o comprimento", () => {
    expect(slugifyWorktreeName("a".repeat(200))).toHaveLength(80);
  });

  // O Windows recusa nome de dispositivo do DOS como pasta, e o `git worktree
  // add` falharia com um erro que não explica nada.
  it("desvia dos nomes reservados do Windows", () => {
    expect(slugifyWorktreeName("con")).toBe("wt-con");
    expect(slugifyWorktreeName("NUL")).toBe("wt-NUL");
    expect(slugifyWorktreeName("com1")).toBe("wt-com1");
    expect(slugifyWorktreeName("LPT9")).toBe("wt-LPT9");
  });

  // O nome é reservado com QUALQUER extensão: `aux.txt` também não vale.
  it("desvia do nome reservado mesmo com extensão", () => {
    expect(slugifyWorktreeName("aux.txt")).toBe("wt-aux.txt");
  });

  it("não desvia de nome que só começa com a palavra reservada", () => {
    expect(slugifyWorktreeName("console")).toBe("console");
    expect(slugifyWorktreeName("com10")).toBe("com10");
    expect(slugifyWorktreeName("nul-fix")).toBe("nul-fix");
  });

  it("continua dentro do limite depois do prefixo", () => {
    expect(slugifyWorktreeName(`con.${"a".repeat(200)}`)).toHaveLength(80);
  });
});

describe("expandHome", () => {
  it("expande ~ sozinho e com barra", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/worktrees")).toBe(resolve(homedir(), "worktrees"));
    expect(expandHome("~\\worktrees")).toBe(resolve(homedir(), "worktrees"));
  });

  it("deixa caminho absoluto em paz", () => {
    expect(expandHome("D:/meus-worktrees")).toBe("D:/meus-worktrees");
  });
});

describe("parseEnv", () => {
  it("lê par chave=valor e ignora comentário e linha vazia", () => {
    const values = parseEnv(
      ["# comentário", "", "VITE_SITE_URL=http://localhost:5174", "  "].join("\n"),
    );
    expect(values.get("VITE_SITE_URL")).toBe("http://localhost:5174");
    expect(values.size).toBe(1);
  });

  it("tira aspas do valor", () => {
    expect(parseEnv("A=\"um\"\nB='dois'").get("A")).toBe("um");
    expect(parseEnv("A=\"um\"\nB='dois'").get("B")).toBe("dois");
  });

  // O `=` do base64url de um segredo não pode partir o valor ao meio.
  it("preserva = dentro do valor", () => {
    expect(parseEnv("BETTER_AUTH_SECRET=abc=def=").get("BETTER_AUTH_SECRET")).toBe("abc=def=");
  });

  it("sobrevive a CRLF", () => {
    expect(parseEnv("A=1\r\nB=2\r\n").get("B")).toBe("2");
  });
});

describe("formatEnvFile", () => {
  it("escreve o cabeçalho como comentário e termina com quebra", () => {
    const text = formatEnvFile({ A: "1", B: "2" }, "gerado");
    expect(text).toBe("# gerado\nA=1\nB=2\n");
  });

  // Ida e volta: o que o setup escreve é o que o doctor lê de volta.
  it("faz round-trip com o parseEnv", () => {
    const values = { CONVEX_DEPLOYMENT: "local:abc", VITE_SITE_URL: "http://x/" };
    expect(Object.fromEntries(parseEnv(formatEnvFile(values, "h")))).toEqual(values);
  });
});

type ReservaDeWorktree = {
  path: string;
  branch?: string | null;
  port?: number;
  convexPort?: number;
};
const podar = pruneEntries as (
  entries: Record<string, ReservaDeWorktree>,
  livePaths: Set<string>,
) => Record<string, ReservaDeWorktree | undefined>;

describe("pruneEntries", () => {
  const a = "c:/wt/a";
  const b = "c:/wt/b";
  const vivos = new Set([a, b]);

  it("descarta worktree que o git já não conhece", () => {
    const kept = podar(
      { [a]: { path: a, port: 5174 }, "c:/wt/morto": { path: "x", port: 5175 } },
      vivos,
    );
    expect(Object.keys(kept)).toEqual([a]);
  });

  // A janela real: o `dev` reserva o Convex ANTES do frontend, então entre as
  // duas escritas existe uma entrada com `convexPort` e sem `port`. Descartá-la
  // apagava o par que o backend estava prestes a usar.
  it("mantém a entrada que só tem reserva de Convex", () => {
    const kept = podar({ [a]: { path: a, convexPort: 3212 } }, vivos);
    expect(kept[a]!.convexPort).toBe(3212);
    expect(kept[a]!.port).toBeUndefined();
  });

  it("mantém a entrada que só tem reserva de frontend", () => {
    const kept = podar({ [a]: { path: a, port: 5174 } }, vivos);
    expect(kept[a]!.port).toBe(5174);
    expect(kept[a]!.convexPort).toBeUndefined();
  });

  it("descarta a entrada sem reserva nenhuma válida", () => {
    const kept = podar({ [a]: { path: a, port: 99, convexPort: 7 } }, vivos);
    expect(kept[a]).toBeUndefined();
  });

  // Os campos caem de forma INDEPENDENTE: um convexPort fora da janela não pode
  // levar junto uma porta de frontend que continua válida.
  it("limpa só o campo inválido, preservando o outro", () => {
    const kept = podar({ [a]: { path: a, port: 5174, convexPort: 3211 } }, vivos);
    expect(kept[a]!.port).toBe(5174);
    expect(kept[a]!.convexPort).toBeUndefined();
  });

  it("preserva os pares distintos de dois worktrees vivos", () => {
    const kept = podar(
      {
        [a]: { path: a, port: 5174, convexPort: 3210 },
        [b]: { path: b, port: 5175, convexPort: 3212 },
      },
      vivos,
    );
    expect([kept[a]!.port, kept[b]!.port]).toEqual([5174, 5175]);
    expect([kept[a]!.convexPort, kept[b]!.convexPort]).toEqual([3210, 3212]);
  });

  it("preserva campos que não são porta, como a branch", () => {
    const kept = podar({ [a]: { path: a, branch: "feat/x", port: 5174 } }, vivos);
    expect(kept[a]!.branch).toBe("feat/x");
  });
});

// Mesmo motivo do alias acima: `merged.mjs` é JS sem tipos, e o teste precisa
// descrever o formato dos fatos para não indexar `any`.
type FatosDeWorktree = {
  branch?: string | null;
  detached?: boolean;
  isMain?: boolean;
  isCurrent?: boolean;
  isBaseBranch?: boolean;
  running?: boolean;
  dirty?: boolean;
  merged?: boolean;
  upstream?: string | null;
  gone?: boolean;
  fresh?: boolean;
};
const lerRastreio = parseBranchTracking as (
  output: string,
) => Map<string, { upstream: string | null; gone: boolean }>;
const classificar = classifyPruneCandidate as (
  facts: FatosDeWorktree,
  options?: { base?: string },
) => { prune: boolean; reason: string; canDeleteBranch?: boolean };

describe("parseBranchTracking", () => {
  it("lê nome, upstream e rastreio separados por TAB", () => {
    const branches = lerRastreio("main\torigin/main\t[behind 11]");
    expect(branches.get("main")).toEqual({ upstream: "origin/main", gone: false });
  });

  // A diferença que sustenta o prune inteiro: sem upstream é branch que nunca
  // saiu daqui; com upstream e `[gone]` é branch que o servidor apagou.
  it("separa branch sem upstream de branch com upstream apagado", () => {
    const branches = lerRastreio(
      ["local-so-minha\t\t", "feat/x\torigin/feat/x\t[gone]"].join("\n"),
    );
    expect(branches.get("local-so-minha")).toEqual({ upstream: null, gone: false });
    expect(branches.get("feat/x")).toEqual({ upstream: "origin/feat/x", gone: true });
  });

  it("não confunde ahead/behind com gone", () => {
    const branches = lerRastreio("feat/x\torigin/feat/x\t[ahead 2, behind 1]");
    expect(branches.get("feat/x")!.gone).toBe(false);
  });

  it("ignora linha vazia e sobrevive a CRLF", () => {
    const branches = lerRastreio("main\torigin/main\t\r\n\r\nfeat/x\t\t\r\n");
    expect([...branches.keys()]).toEqual(["main", "feat/x"]);
  });
});

describe("classifyPruneCandidate", () => {
  const base = { base: "origin/main" };
  const candidato: FatosDeWorktree = {
    branch: "t3code/resolve-issue-176",
    detached: false,
    isMain: false,
    isCurrent: false,
    isBaseBranch: false,
    running: false,
    dirty: false,
    merged: false,
    upstream: "origin/t3code/resolve-issue-176",
    gone: false,
  };

  it("poda a branch que a base já contém, e aí a branch pode cair junto", () => {
    const verdict = classificar({ ...candidato, merged: true }, base);
    expect(verdict.prune).toBe(true);
    expect(verdict.canDeleteBranch).toBe(true);
    expect(verdict.reason).toContain("origin/main");
  });

  // O caso do squash merge: nada é ancestral de nada, e o único sinal é a
  // branch remota ter sumido.
  it("poda o worktree cujo upstream foi apagado", () => {
    const verdict = classificar({ ...candidato, gone: true }, base);
    expect(verdict.prune).toBe(true);
    expect(verdict.reason).toContain("origin/t3code/resolve-issue-176");
  });

  // A assimetria que impede o prune de destruir trabalho: upstream apagado é
  // indício, não prova. Branch remota some por PR fechada sem merge e por
  // faxina de servidor, e nesses casos o commit local não está em lugar nenhum.
  it("não deixa apagar a branch quando o único sinal é o upstream sumido", () => {
    const verdict = classificar({ ...candidato, gone: true }, base);
    expect(verdict.canDeleteBranch).toBe(false);
    expect(verdict.reason).toContain("mantenho a branch");
  });

  // Com a prova em mãos, o indício não rebaixa nada.
  it("deixa a prova de merge vencer o indício quando os dois aparecem", () => {
    const verdict = classificar({ ...candidato, merged: true, gone: true }, base);
    expect(verdict.canDeleteBranch).toBe(true);
  });

  it("mantém a branch que ainda não foi integrada", () => {
    expect(classificar(candidato, base)).toEqual({
      prune: false,
      reason: "ainda não está em origin/main",
    });
  });

  // Um worktree recém-criado na ponta da base também "já está na base": sem
  // esta trava, a limpeza feita por outra tarefa apagaria o trabalho que acabou
  // de começar.
  it("mantém o worktree recém-criado sem commits próprios", () => {
    const novo = { ...candidato, upstream: null, merged: true, fresh: true };
    expect(classificar(novo, base)).toEqual({
      prune: false,
      reason: "foi criado há pouco e ainda não tem commits próprios",
    });
    expect(classificar({ ...novo, fresh: false }, base).prune).toBe(true);
    // `git worktree add -b x origin/main` já deixa a base como upstream.
    expect(classificar({ ...novo, upstream: "origin/main" }, base).prune).toBe(false);
    // Publicada e integrada, a branch acabou, por mais nova que seja.
    expect(classificar({ ...novo, upstream: "origin/x" }, base).prune).toBe(true);
  });

  it("mantém a branch que nunca foi para o remoto", () => {
    const verdict = classificar({ ...candidato, upstream: null }, base);
    expect(verdict).toEqual({ prune: false, reason: "nunca foi para o remoto" });
  });

  it("recusa o checkout principal e o worktree atual", () => {
    expect(classificar({ ...candidato, merged: true, isMain: true }, base).prune).toBe(false);
    expect(classificar({ ...candidato, merged: true, isCurrent: true }, base).prune).toBe(false);
  });

  it("recusa worktree destacado, que não tem branch para julgar", () => {
    const verdict = classificar({ ...candidato, branch: null, detached: true, merged: true }, base);
    expect(verdict.prune).toBe(false);
    expect(verdict.reason).toContain("destacado");
  });

  it("recusa o worktree que está na própria branch base", () => {
    const verdict = classificar(
      { ...candidato, branch: "main", isBaseBranch: true, merged: true },
      base,
    );
    expect(verdict.prune).toBe(false);
  });

  // As duas redes que protegem trabalho vivo vêm ANTES do veredito de merge:
  // uma branch mergeada ainda pode ter alteração solta em cima, e um worktree
  // rodando não pode sumir embaixo de quem está usando.
  it("deixa alteração não commitada vencer o merge", () => {
    const verdict = classificar({ ...candidato, merged: true, dirty: true }, base);
    expect(verdict.prune).toBe(false);
    expect(verdict.reason).toContain("não commitada");
  });

  it("deixa dev rodando vencer o merge", () => {
    const verdict = classificar({ ...candidato, merged: true, gone: true, running: true }, base);
    expect(verdict.prune).toBe(false);
    expect(verdict.reason).toContain("rodando");
  });

  it("usa a base recebida no motivo, em vez de fixar origin/main", () => {
    const verdict = classificar({ ...candidato, merged: true }, { base: "upstream/producao" });
    expect(verdict.reason).toBe("já está em upstream/producao");
  });
});
