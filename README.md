# freecorpsNFE

Infraestrutura fiscal para software brasileiro. A plataforma importa XML de
NF-e modelo 55, preserva os arquivos originais e
disponibiliza documentos normalizados para consulta pelo console, API REST e
SDK TypeScript. A interface e os guias públicos são em português do Brasil.

O produto atual está em `apps/console` e `platform/convex`, com Better Auth.
O corte substituiu o serviço antigo no mesmo endereço, com banco vazio e
contas novas. **A emissão NFS-e da plataforma existe só em sandbox, pela API
e pelo SDK, com transporte simulado e sem validade fiscal;** produção depende
de um gate por empresa, desligado ([ISSUANCE.md](docs/plataforma/ISSUANCE.md)). O
backoffice Clerk e o motor de emissão NFS-e/NFC-e do serviço antigo foram
aposentados na #345 e não fazem parte deste repositório.

O perfil hospedado é sandbox, com transporte fiscal e crons desativados, com
uma exceção: desde 22/10/2026, a captura de NF-e lê a distribuição real da
Receita, em produção, para cada empresa que a ligou no console com o próprio
A1. As consultas são agendadas por stream, sem cron
([ADR 0007](docs/adr/0007-captura-fiscal-no-site.md),
[liberação fiscal](docs/plataforma/CAPTURE.md#liberação-fiscal-no-site) e
[runbook](docs/operacao/captura-fiscal.md)). Desde 07/10/2026 a entrega de
webhooks por HTTPS está ativa no serviço hospedado; o `bootstrap` ainda
publica com webhooks desativados. Consulte as
[capacidades e limites](docs/v1.0/ACCEPTANCE.md#capacidades-e-limites) e as
[evidências e pendências](docs/v1.0/EVIDENCE.md).

## O que existe

- Organizações, membros, empresas, projetos e API keys com escopos e concessões.
- Importação de NF-e 55, deduplicação, XML original, JSON normalizado,
  itens, eventos e histórico de processamento. A importação de lotes NFS-e
  ABRASF saiu em 02/11/2026; as NFS-e já importadas ficam só para leitura
  ([IMPORTS.md](docs/plataforma/IMPORTS.md#lotes-nfs-e-abrasf-retirados)).
- Validação técnica de NF-e, referências fiscais e consulta cadastral.
- Cofre de certificados A1, captura NF-e por NSU e fila de webhooks com
  assinatura, retentativas e controle de acesso.
- Consumo, cotas, auditoria, exportação e procedimentos de recuperação.
- Site público e guias estáticos, console e SDK cliente independente.

Validação XML não comprova autorização fiscal. Os contratos e limites estão no
[índice da plataforma](docs/README.md); a release global e a homologação
fiscal continuam com aceite próprio.

## Estrutura do repositório

| Caminho                        | Responsabilidade                                                                |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `apps/console/`                | Console React, site e guias públicos, Worker com proxy de autenticação e da API |
| `platform/convex/`             | Backend atual: Better Auth, permissões, documentos, API e tarefas               |
| `packages/contracts/`          | Contratos externos e origem da geração de OpenAPI                               |
| `packages/fiscal-core/`        | Identificação fiscal e decimais exatos compartilhados                           |
| `packages/fiscal-nfe/`         | Parsing, validação, normalização e conector de distribuição NF-e                |
| `packages/fiscal-nfse/`        | Núcleo de emissão NFS-e: DPS, assinatura, eventos, PTAX, rotas e adaptador ADN  |
| `packages/sdk/`                | Cliente TypeScript e verificador de webhooks                                    |
| `scripts/`                     | Worktrees, builds, validação, publicação e provas de distribuição               |
| `tests/` e `apps/console/e2e/` | Testes automatizados, fixtures e jornadas no navegador                          |
| `docs/`                        | Índice por tarefa, contratos, procedimentos, aceite, evidências e histórico     |

O monorepo usa Bun Workspaces e Vite+, React 19, TypeScript e TanStack Router.
Convex mantém banco, storage e agendamento; actions Node executam os
conectores. O Cloudflare Worker serve o console e os arquivos estáticos e
encaminha a autenticação e a API REST pública. Versões e scripts ficam em
[package.json](package.json), com resolução em `bun.lock`.

## Desenvolvimento local

Use Git, Vite+, Bun 1.4.0 e Node com npm. O CI usa Node 24.22.1; o runtime
Node 24.22.1 das actions locais é instalado separadamente pelo setup. Instale as
dependências na raiz:

```powershell
vp install --frozen-lockfile
```

### Plataforma atual

Leia [docs/worktrees.md](docs/worktrees.md) antes de preparar o ambiente.
O fluxo local isolado dispensa conta Convex e credenciais da Freecorps:

```powershell
bun run worktree:create feat/minha-tarefa --from origin/main --app platform
cd ../freecorpsNFE-worktrees/feat-minha-tarefa
bun run dev
```

Use o caminho impresso pelo script se o checkout tiver outro nome ou uma
pasta de worktrees configurada. Cada worktree tem dependências, banco e
portas próprios. `bun run dev` inicia backend e frontend juntos e imprime a
URL do site, com frontend a partir da porta 5174.

Abra `/signup`, cadastre um e-mail fictício e consulte o código de verificação
em outro terminal do mesmo worktree, mantendo o dev aberto:

```powershell
bun run worktree:mail conta@development.invalid
```

O e-mail fica no coletor local. O perfil `vazio` não cria contas, empresas
ou API keys. O setup gera os segredos locais e mantém transporte fiscal,
crons e webhooks desativados. Use fixtures sintéticas nos testes.

Se o editor criou o checkout, aguarde o setup automático. Os scripts e a ação
versionada em `t3.json` preparam a plataforma; `--app legacy` é recusado. Um
worktree antigo do backoffice legado continua listável e removível, mas setup,
dev e sync o recusam sem apagar o banco local.

Use `bun run dev`, que passa pelo roteador do projeto e imprime o aplicativo
iniciado. `vp dev` pula esse fluxo. `bun run dev` roda só em worktree; no
checkout principal, ele recusa e aponta `bun run worktree:create`.
Para instalação operacional da plataforma, siga
[instalação própria](docs/operacao/instalacao-propria.md).

## Comandos e verificação

Execute os comandos abaixo na raiz. `bun run help` lista todos os scripts com
a aplicação e o ambiente que cada um atinge; o catálogo fica em
`scripts/lib/commands.mjs`. Builds não publicam a aplicação, e nenhum script
publica em produção: isso cabe ao workflow `Deploy production`.

| Comando                                      | Aplicação  | Ambiente  | O que faz                                                                    |
| -------------------------------------------- | ---------- | --------- | ---------------------------------------------------------------------------- |
| `bun run help`                               | todas      | nenhum    | Lista os comandos, a aplicação e o ambiente de cada um                       |
| `bun run dev`                                | plataforma | worktree  | Convex local e console do worktree                                           |
| `bun run packages:build`                     | pacotes    | nenhum    | Compila os pacotes fiscais; repetir após editá-los com o dev aberto          |
| `bun run sdk:build`                          | pacotes    | nenhum    | Compila e empacota o SDK                                                     |
| `vp check`                                   | todas      | nenhum    | Confere formatação, lint e tipos                                             |
| `vp test run`                                | todas      | local     | Executa a suíte de testes uma vez, sem cache                                 |
| `vp run test:<área>`                         | uma área   | local     | Testes de uma área, com cache: `platform`, `console`, `packages` etc.        |
| `bun run platform:test`                      | plataforma | local     | Testes da plataforma e dos pacotes, com cache local                          |
| `bun run test:changed`                       | todas      | local     | Só os testes alcançados pelas mudanças desde `origin/main`                   |
| `bun run platform:check`                     | plataforma | nenhum    | Compila pacotes fiscais e confere tipos da plataforma e do console           |
| `bun run console:build`                      | plataforma | validação | Compila console/site com as URLs de validação, sem publicar                  |
| `vp run docs:dev`                            | plataforma | local     | Servidor da documentação (`apps/docs`) em `localhost:5180/docs`              |
| `vp run docs:build`                          | plataforma | nenhum    | Gera a documentação estática em `apps/docs/dist`, sem o console              |
| `bun run build`                              | plataforma | validação | Pacotes fiscais, tipos da plataforma e console; não publica                  |
| `bun run contracts:check --base origin/main` | plataforma | nenhum    | Confere artefatos REST e compatibilidade com a base                          |
| `bun run ci:local`                           | todas      | local     | Valida alterações; grafo Validate, fronteiras, resumo e recibo por tentativa |
| `bun run ci:prove`                           | todas      | local     | Prova um commit limpo, sem cache no grafo, com resumo e recibo               |
| `bun run worktree:list`                      | todas      | worktree  | Lista aplicativo, portas e ambientes registrados                             |
| `bun run worktree:doctor`                    | todas      | worktree  | Confere a configuração e o isolamento do ambiente atual                      |
| `bun run worktree:status --json`             | todas      | local     | Consulta operação e último resultado do setup, sem iniciar serviços          |
| `bun run worktree:wait`                      | todas      | local     | Aguarda o setup com prazo, sem repetir nem interromper a preparação          |
| `bun run worktree:cleanup`                   | todas      | worktree  | Encerra os processos registrados do worktree                                 |
| `bun run worktree:remove <nome>`             | todas      | worktree  | Remove o ambiente conforme as proteções do script                            |

Os scripts `validation:*` leem, escrevem ou publicam no ambiente de validação,
como indica o nome; seguem [validacao.md](docs/operacao/validacao.md).

Nomes antigos continuam no `package.json` só para apontar o substituto e
falham sem executar nada: `xml:build` → `packages:build`,
`xml:boundaries` → `ci:boundaries` e `console:deploy` →
`validation:console:deploy`. A raiz não tem aplicativo próprio: `vp build` e
`vp preview` são comandos internos do Vite+ e não compilam o console; use
`bun run build`.

Para checks avulsos em um checkout recém-instalado, compile os pacotes fiscais
e o SDK antes de conferir tipos. Os testes resolvem os pacotes pelo código-fonte
e não dependem desse build. `ci:local` organiza essas dependências. As áreas de
teste e o ciclo rápido estão na seção "Verificando" do [AGENTS.md](AGENTS.md).
As provas adicionais por tipo de mudança estão em
[CONTRIBUTING.md](CONTRIBUTING.md) e [ci.md](docs/desenvolvimento/ci.md).
Testes com transporte simulado não comprovam integração fiscal real.

## API e SDK

O contrato atual está em [SDK e quickstart](docs/v1.0/SDK.md), com
[referência REST](docs/v1.0/API-REFERENCE.md) e
[OpenAPI](docs/v1.0/openapi.json). API keys pertencem a projetos e exigem
escopos e concessões de empresa/ambiente. Sessões humanas usam Better Auth.
No serviço hospedado, a API fica em `https://api.nfe.freecorps.com.br`,
servida pelo Worker; o backend registra chave ou membro, IP e hora de cada
acesso, conforme [RETENTION.md](docs/plataforma/RETENTION.md).

Na aplicação, `/` é o site público, `/docs/` contém os guias e `/app` abre as
organizações. As rotas de conta incluem `/signup` e `/login`.
O [SDK](packages/sdk/README.md) e as bibliotecas fiscais estão no npm desde
01/11/2026; `@freecorps/contracts` continua privado.

## Publicação e operação

Cada push na `main` dispara `Deploy production`, que valida o commit e
publica `platform/convex` e `apps/console` nos endereços configurados
`nfe.freecorps.com.br` e `api.nfe.freecorps.com.br`. Atualizações usam
`release` e preservam os dados. `bootstrap` continua manual. O nome do workflow e o tipo `prod` do Convex
não habilitam emissão nem alteram o perfil sandbox do produto.

Leia [docs/operacao/deploy-producao.md](docs/operacao/deploy-producao.md) antes de publicar. Variáveis `VITE_*`
entram no bundle durante o build; segredos ficam no backend ou no Worker
correspondente. `validation:console:deploy` atende ao ambiente de validação e não
substitui o fluxo de release da plataforma.

## Documentação

O [índice da documentação](docs/README.md) organiza os documentos pela
tarefa (preparar o ambiente, localizar o domínio, entender as regras,
implementar, validar e publicar) e separa referência atual, procedimento,
decisão, planejamento, evidência e legado.

- [Arquitetura atual](docs/ARQUITETURA.md) e [decisões](docs/adr/).
- [Worktrees](docs/worktrees.md), [CI](docs/desenvolvimento/ci.md) e
  [publicação](docs/operacao/deploy-producao.md).
- [Capacidades e aceite](docs/v1.0/ACCEPTANCE.md) e
  [evidências](docs/v1.0/EVIDENCE.md).
- [Contribuição](CONTRIBUTING.md), [segurança](SECURITY.md),
  [instruções para agentes](AGENTS.md) e [skills do projeto](.agents/README.md).

Plataforma e motor usam a Licença de Código Disponível Freecorps 1.0; o SDK
cliente usa MIT. O repositório continua privado. Condições para schemas,
dados, dependências e servidor Convex estão em [LICENSING.md](LICENSING.md).
