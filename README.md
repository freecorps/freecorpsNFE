# freecorpsNFE

freecorpsNFE é infraestrutura fiscal para software brasileiro. Importa XML de
NF-e modelo 55, guarda o arquivo original e entrega o documento normalizado
pelo [console](https://nfe.freecorps.com.br/app), pela
[API REST](docs/v1.0/API-REFERENCE.md) e pelo
[SDK TypeScript](packages/sdk/README.md).

O serviço hospedado está em [nfe.freecorps.com.br](https://nfe.freecorps.com.br),
com a API em `https://api.nfe.freecorps.com.br` e os guias em
[nfe.freecorps.com.br/docs](https://nfe.freecorps.com.br/docs). Tudo que o
usuário vê é em português do Brasil.

## O que dá para fazer

- Organizar organizações, membros, empresas, projetos e API keys com escopos e
  concessões.
- Importar NF-e 55 com deduplicação e consultar XML original, JSON normalizado,
  itens, eventos e histórico de processamento.
- Validar NF-e tecnicamente e consultar referências fiscais e cadastro.
- Guardar certificados A1 num cofre e capturar NF-e por NSU direto da Receita.
- Receber webhooks assinados, com retentativas e controle de acesso.
- Acompanhar consumo, cotas, auditoria e exportações.

Validação XML não comprova autorização fiscal. Os limites de cada recurso estão
em [capacidades e limites](docs/v1.0/ACCEPTANCE.md#capacidades-e-limites).

## Começar

Crie uma conta em [nfe.freecorps.com.br/signup](https://nfe.freecorps.com.br/signup),
crie um projeto no console e gere uma API key. Depois instale o SDK:

```bash
npm install @freecorps/sdk
```

```ts
import { FreecorpsClient } from "@freecorps/sdk";

const client = new FreecorpsClient({
  baseUrl: "https://api.nfe.freecorps.com.br",
  apiKey: process.env.FREECORPS_API_KEY!,
  environment: "sandbox",
});

const companies = await client.call("listCompanies", {
  path: {},
  query: { limit: 20 },
  body: {},
});
```

O SDK requer Node 22 ou 24. O [guia do SDK](docs/v1.0/SDK.md) cobre retentativas,
idempotência e verificação de webhooks; o contrato completo está no
[OpenAPI](docs/v1.0/openapi.json). Não coloque API keys em código, URLs ou
bundles de navegador.

Quer rodar a plataforma na sua própria infraestrutura? Siga a
[instalação própria](docs/operacao/instalacao-propria.md).

## Algumas notas

> [!WARNING]
> **A emissão NFS-e existe só em sandbox**, pela API e pelo SDK, com transporte
> simulado e sem validade fiscal. Produção depende de um gate por empresa, hoje
> desligado ([ISSUANCE.md](docs/plataforma/ISSUANCE.md)).

O serviço hospedado roda no perfil sandbox, com transporte fiscal e crons
desligados. A exceção é a captura de NF-e: desde 22/10/2026 ela lê a
distribuição real da Receita para cada empresa que a ligou no console com o
próprio A1, em consultas agendadas por stream
([ADR 0007](docs/adr/0007-captura-fiscal-no-site.md),
[runbook](docs/operacao/captura-fiscal.md)). A entrega de webhooks por HTTPS
está ativa desde 07/10/2026.

A importação de lotes NFS-e ABRASF saiu em 02/11/2026; as NFS-e já importadas
ficam só para leitura ([IMPORTS.md](docs/plataforma/IMPORTS.md#lotes-nfs-e-abrasf-retirados)).
Esta plataforma substituiu o serviço antigo no mesmo endereço. O backoffice
Clerk e o motor de emissão NFS-e/NFC-e daquele serviço saíram na #345 e não
fazem parte deste repositório.

## Documentação

O [índice da documentação](docs/README.md) organiza tudo pela tarefa.

- [SDK e quickstart](docs/v1.0/SDK.md)
- [Referência REST](docs/v1.0/API-REFERENCE.md) e [OpenAPI](docs/v1.0/openapi.json)
- [Webhooks](docs/plataforma/WEBHOOKS.md)
- [Captura fiscal](docs/plataforma/CAPTURE.md) e [certificados](docs/plataforma/CERTIFICATES.md)
- [Retenção de dados](docs/plataforma/RETENTION.md)
- [Capacidades e aceite](docs/v1.0/ACCEPTANCE.md) e [evidências](docs/v1.0/EVIDENCE.md)
- [Arquitetura](docs/ARQUITETURA.md) e [decisões (ADRs)](docs/adr/)
- [Instalação própria](docs/operacao/instalacao-propria.md) e
  [publicação em produção](docs/operacao/deploy-producao.md)

## Quer contribuir? Leia isto antes

Leia o [CONTRIBUTING.md](CONTRIBUTING.md) e os
[termos de contribuição](CONTRIBUICOES.md) antes de abrir uma issue ou PR. O
repositório é público, inclusive issues, logs e artefatos do CI: use só dados
fictícios. Vulnerabilidades vão por
[relato privado](https://github.com/freecorps/freecorpsNFE/security/advisories/new)
([SECURITY.md](SECURITY.md)).

### Instale o `vp`

O projeto usa [Vite+](https://viteplus.dev/guide/), então você precisa do
comando global `vp`. Também são necessários Git, Bun 1.4.0 e Node com npm.

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows (PowerShell):

```powershell
irm https://vite.plus/ps1 | iex
```

### Instale as dependências e crie um worktree

```bash
vp install --frozen-lockfile
bun run worktree:create feat/minha-tarefa --from origin/main --app platform
cd ../freecorpsNFE-worktrees/feat-minha-tarefa
bun run dev
```

Cada worktree tem banco, portas e segredos locais próprios, sem conta Convex
nem credenciais da Freecorps. `bun run dev` sobe backend e frontend juntos e
imprime a URL do site. Abra `/signup` com um e-mail fictício e leia o código de
verificação em outro terminal:

```bash
bun run worktree:mail conta@development.invalid
```

O passo a passo completo está em [docs/worktrees.md](docs/worktrees.md).

### Verifique as mudanças

```bash
vp check
vp test run
bun run ci:local
```

`bun run help` lista todos os scripts, com a aplicação e o ambiente que cada um
atinge. Os testes por área estão em [ci.md](docs/desenvolvimento/ci.md#testes), que
também descreve o que o CI confere. Nenhum script
publica em produção; isso cabe ao workflow `Deploy production`, disparado a
cada push na `main`.

### Onde fica cada coisa

| Caminho                 | O que tem                                                         |
| ----------------------- | ----------------------------------------------------------------- |
| `apps/console/`         | Console React, site, guias públicos e o Worker Cloudflare         |
| `platform/convex/`      | Backend: Better Auth, permissões, documentos, API e tarefas       |
| `packages/contracts/`   | Contratos externos e geração do OpenAPI                           |
| `packages/fiscal-core/` | Identificação fiscal e decimais exatos                            |
| `packages/fiscal-nfe/`  | Parsing, validação, normalização e distribuição NF-e              |
| `packages/fiscal-nfse/` | Núcleo de emissão NFS-e                                           |
| `packages/sdk/`         | Cliente TypeScript e verificador de webhooks                      |
| `scripts/`              | Worktrees, builds, validação, publicação e provas de distribuição |
| `docs/`                 | Contratos, procedimentos, decisões e evidências                   |

## Licença

A plataforma e o motor usam a Licença de Código Disponível Freecorps 1.0; o SDK
cliente usa MIT. O código é público desde 03/11/2026. As condições para schemas,
dados, dependências e servidor Convex estão em [LICENSING.md](LICENSING.md).
