---
name: dependency-maintenance
description: "Adicionar, mover ou atualizar dependências, runtimes e ferramentas, sincronizando manifests, patches, lockfile e CI."
---

# Manutenção de dependências

Trate uma atualização como sincronização dos pontos afetados. Derive versões
e comandos dos arquivos atuais do projeto. Origem e adaptações estão em
[EXTERNAS.md](../EXTERNAS.md#importação-do-t3-code-em-20102026).

## Identificar o alcance

Leia os manifests afetados, os scripts da raiz, `bun.lock`, a configuração
Vite+ e os workflows pertinentes. Busque a dependência, versões, overrides,
patches, restrições de runtime e declarações de compatibilidade.

Distinga a versão instalada para desenvolvimento da faixa suportada para
consumidores. Ao adicionar ou mover uma entrada, leia
[manifest-roles.md](manifest-roles.md).

Uma alteração pode ficar no pacote proprietário se não afetar runtime,
compilador, patches, configuração ou ferramentas compartilhadas. Nos demais
casos, confira todos os pontos aplicáveis:

- **Bun:** versão fixada em `package.json`, instalação, caches, workflows,
  scripts de worktree e formato de `bun.lock`.
- **Vite+ e TypeScript:** dependências e aliases, overrides, configuração,
  `scripts/typecheck.mjs`, builds e projetos de teste afetados.
- **Runtimes:** engines e documentação dos pacotes, Node nas actions,
  runtime Convex e compatibilidade do Worker Cloudflare. Um resultado num
  runtime não comprova os outros.
- **Patches:** registro em `patchedDependencies`, arquivo e resolução no
  lockfile. Quando viável, teste a versão nova sem o patch; remova-o somente
  se o comportamento que motivou a correção estiver resolvido. Se ainda for
  necessário, atualize-o pelo fluxo do Bun e prove o comportamento original.
- **Dependências nativas:** instalação, scripts de build autorizados e
  plataformas suportadas. Preserve a política existente.

## Instalar e verificar

Use o Bun fixado e o Vite+ do projeto. Para atualizar manifests e lockfile,
use `vp install`; a instalação de validação usa
`vp install --frozen-lockfile`, conforme o README.

Inspecione o diff semântico do lockfile: resoluções, duplicações transitivas,
peers, integridade, patches e scripts de instalação. Explique alterações fora
do pacote solicitado antes de incluí-las.

Rode a menor prova do comportamento afetado durante o trabalho e os checks
finais exigidos pelo `AGENTS.md`. Para pacotes distribuídos, use as provas de
empacotamento e consumidor existentes. Uma instalação aprovada não comprova
compatibilidade. Se a mudança afetar um caminho com regressão de desempenho,
use [performance-analysis](../performance-analysis/SKILL.md).

Conclua quando manifests e lockfile concordarem, os pontos de sincronização
estiverem resolvidos e os resultados e limitações estiverem registrados.
Atualizar dependências não autoriza publicação nem atualização de deployment.
