# Backend da plataforma fiscal

Este workspace contém o backend atual em `platform/convex`, consumido pelo
console em `apps/console`. Ele mantém contas Better Auth, organizações,
empresas, projetos e chaves, importação e consulta de documentos, certificados,
captura NF-e, webhooks, consumo e auditoria. Emissão fiscal permanece indisponível.

Os contratos por módulo estão no [índice da documentação](../docs/README.md).
Consulte as [capacidades e limites](../docs/v1.0/ACCEPTANCE.md#capacidades-e-limites) e as
[evidências](../docs/v1.0/EVIDENCE.md) para distinguir implementação, ambiente
publicado e aceite. É o único projeto Convex do repositório; o backend legado
foi aposentado na #345.

## Desenvolvimento

Instale as dependências na raiz com `vp install --frozen-lockfile`, usando
Bun 1.4.0 e o lockfile único. Prepare um worktree, que usa a plataforma por
padrão, e use `bun run dev` nele, conforme o
[guia de worktrees](../docs/worktrees.md). O setup configura o banco local,
Better Auth e o coletor de e-mail sem credenciais externas.

Execute os checks na raiz:

```powershell
bun run packages:build
bun run sdk:build
bun run platform:check
bun run platform:test
```

Antes de alterar funções, leia as
[guidelines geradas do projeto](convex/_generated/ai/guidelines.md).
Arquivos em `platform/convex/_generated/` são gerados pelo Convex.

## Ambientes e publicação

Use [deploy-producao.md](../docs/operacao/deploy-producao.md) para o endereço definitivo,
[validacao.md](../docs/operacao/validacao.md) para a validação compartilhada e
[instalacao-propria.md](../docs/operacao/instalacao-propria.md) para instalação própria.
Os scripts `validation:*` verificam o alvo de validação; não são comandos
genéricos para qualquer deployment. Não inicie `convex dev` neste diretório
com credenciais compartilhadas. Confira o alvo antes de publicar funções,
alterar variáveis ou executar escritas.
