// Bloqueia a leitura direta de arquivos de credencial por agentes (PreToolUse).
// Em 26/10/2026 um agente imprimiu ~/.convex/config.json tentando mascará-lo
// com sed, e o token de acesso do Convex foi parar na saída da ferramenta.
// Um comando pode usar a credencial (a CLI do Convex lê o próprio arquivo),
// mas não pode citar o arquivo para ler, filtrar ou copiar. Para saber se uma
// credencial existe, rode a CLI e veja se ela pede login.
import { readFileSync } from "node:fs";

/** Caminhos que guardam credencial. Comparados em minúsculas, com `/`. */
export const credentialPatterns = [
  // Token da CLI (~/.convex) e estado local do Convex (.convex): o diretório
  // inteiro, para `cat ~/.convex/*` ou `cp -r ~/.convex` não passarem.
  // `npx convex` e `convex.json` não têm o ponto e continuam livres.
  /(^|[^a-z0-9_])\.convex\b/,
  /\.dpapi\b/, // senha ou conta protegida por DPAPI (scripts/fiscal-proof.mjs)
  /\.(pfx|p12)\b/, // certificado A1
  /(^|[/\\\s"'=])deployment\.env\b/, // deploy key da rodada fiscal
  /(^|[/\\\s"'=])\.env\.local\b/, // CONVEX_DEPLOY_KEY e afins
];

/** Texto da chamada que pode citar um arquivo, por ferramenta. */
export function citedText(tool, input) {
  if (tool === "Bash" || tool === "PowerShell") return input?.command ?? "";
  if (tool === "Read" || tool === "Edit" || tool === "Write") return input?.file_path ?? "";
  // Procurar o nome de um desses arquivos no código é inofensivo; abrir é que não.
  if (tool === "Grep") return [input?.path, input?.glob].join(" ");
  if (tool === "Glob") return [input?.path, input?.pattern].join(" ");
  return "";
}

export function blocked(tool, input) {
  const text = citedText(tool, input).replaceAll("\\\\", "\\").toLowerCase();
  return credentialPatterns.some((pattern) => pattern.test(text));
}

// Executado pelo hook; importado, só exporta as regras para o teste.
if (process.argv[1]?.endsWith("guard-credentials.mjs")) {
  let event = {};
  try {
    event = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    // Entrada ilegível: o hook não decide; a chamada segue como sem ele.
    process.exit(0);
  }
  if (blocked(event.tool_name, event.tool_input)) {
    process.stderr.write(
      "Bloqueado: o comando cita um arquivo de credencial (.convex/, *.dpapi, *.pfx, *.p12, deployment.env, .env.local). " +
        'Não leia nem imprima credenciais; use a CLI que as consome ou peça ao dono. Veja AGENTS.md, "Credenciais e dados reais".\n',
    );
    process.exit(2);
  }
}
