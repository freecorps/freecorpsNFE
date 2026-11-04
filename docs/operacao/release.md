# Preparar uma publicação por entrega

Não existe publicação automática de pacotes. Um pacote só deixa de ser
privado por aceite explícito do mantenedor na #83. Em 01/11/2026 foram
selecionados sdk, fiscal-core, fiscal-nfe e fiscal-nfse, versão 0.1.0;
contracts continua privado ([decisões](../licenses/DISTRIBUTION.md#decisões-do-mantenedor-em-01112026)). O workflow de PR apenas valida e
guarda artefatos internos. A aplicação segue [deploy-producao.md](deploy-producao.md): push na
`main` publica atualizações validadas pelo CI da PR; bootstrap continua manual. Esse fluxo
não publica pacotes npm nem abre o repositório. Distribuição de fontes,
tarballs e imagens exige os aceites específicos abaixo.

## Escopo e aceite

A [ADR 0011](../adr/0011-entregas-graduais.md) substitui o encerramento global
da plataforma 1.0. Escolha um SHA por entrega ou lote, sem aguardar o último
merge de capacidades sem relação com ele. Registre na issue responsável o
resultado, dependências, critérios, SHA, ambiente, recibos, limites e aceite.
Separe integrado, publicado e habilitado. Os checks obrigatórios continuam
valendo, assim como os gates fiscais, comerciais e de distribuição.

Pacotes são aceitos na #83 por versão/hash; a árvore pública segue a #267
somente quando esse for o artefato selecionado. Termos seguem a #428, com
data real por publicação, avisos e revisões aplicáveis. D01 permanece na #80
sem bloquear globalmente essas entregas. Aprovações já registradas não se
repetem por ritual; confira se mudanças invalidam seu escopo ou evidência.

## Versões e suporte

Cada pacote independente usa SemVer. Antes de 1.0, mudança incompatível exige
incremento minor e nota de migração; após 1.0, exige major. Correções compatíveis
usam patch. O contrato REST/OpenAPI tem versão própria e gate de compatibilidade;
não deduza sua versão de `0.1.0` do SDK. O contrato está na versão 8.0.0,
publicada com o SDK em 01/11/2026; cada major desde a 2.0.0 ampliou enums, variantes ou
campos obrigatórios. Consumidores com enums fechados precisam seguir a
migração documentada em [SDK.md](../v1.0/SDK.md#versionamento) e nas
[notas da versão](../v1.0/RELEASE-NOTES.md).

Não se promete LTS, SLA ou suporte a outros runtimes. fiscal-nfe declara Node
`>=20.20.2`; o SDK empacotado declara Node `>=22`. Os recibos identificam as
versões efetivamente exercitadas, que não comprovam todas as versões maiores
aceitas pelo manifest. A primeira release define a matriz suportada a partir
dessas provas e do aceite do mantenedor.

## Checklist do mantenedor

O [material de lançamento](../v1.0/LAUNCH.md) permanece em revisão. O
[site estático](../plataforma/PUBLIC.md) usa `noindex` por padrão; sua preparação não
publica pacotes nem constitui anúncio de disponibilidade geral.

- [ ] Fixar escopo, issue e commit candidato; conferir base, revisão e CI desse commit.
- [ ] Conferir [matriz de licenças](../../LICENSING.md), inventário, avisos e
      condições de cada origem. Resolver bloqueios dos artefatos selecionados.
- [ ] Registrar decisão por pacote/versão/hash na [avaliação por artefato](../licenses/DISTRIBUTION.md).
      É permitido aceitar SDK ou core e conservar fiscal-nfe/datasets bloqueados.
      `distribution:prove` registra as pendências de cada tarball; sucesso técnico
      não as remove. Fiscal-nfe exige também o aceite de fiscal-core.
- [ ] Conferir as [pendências abertas da #83](../licenses/DISTRIBUTION.md#pendências-abertas-em-05102026).
      Registrar para cada condição resolvida o decisor, data, escopo/versão/hash,
      referência/custodiante da evidência e ressalvas. Não marcar a revisão
      jurídica ou de direitos como concluída pelo resultado de um teste.
- [x] Revisão jurídica: substituída em 20/10/2026 pela
      [decisão do mantenedor](../licenses/DISTRIBUTION.md#decisões-do-mantenedor-em-20102026),
      sem parecer. Uma mudança no texto de `LICENSE` ou `CONTRIBUICOES.md` exige nova decisão.
- [ ] Conferir a cadeia de direitos e registrar aceites de colaboradores externos.
      O CNPJ identifica o titular declarado, mas não prova a autoria do código.
- [ ] Conferir o escopo MIT do SDK e o grafo JS/tipos produzido pelo build.
      Não adicionar arquivos ao escopo MIT apenas para contornar uma falha.
- [ ] Conferir as versões finais no registry. Npm/2FA e nomes foram conferidos
      pelo mantenedor em 29/10 na #83; repetir essa conferência se houver mudança.
      Os nomes preparados são `@freecorps/freecorpsnfe-sdk` (até 03/11/2026, `@freecorps/sdk`), `@freecorps/contracts`,
      `@freecorps/fiscal-core`, `@freecorps/fiscal-nfe` e `@freecorps/fiscal-nfse`
      (decisão 5 de 28/10).
- [ ] Regerar pacotes do candidato limpo (`packages:build`, `contracts:build`,
      `sdk:build`); executar `licenses:check`, `contracts:check`, `sdk:prove`, `xml:prove`,
      `distribution:prove` e `ci:boundaries`.
- [ ] Inspecionar tarballs e dependências; conservar LICENSE, NOTICE e avisos.
      PFX, PEM, `.env`, corpus interno, dados e evidências restritas ficam fora.
      As provas recusam cópias de fixtures, PEM/PFX e certificados versionados,
      mas não substituem a revisão humana do conteúdo selecionado.
- [ ] Repetir a varredura de secrets no histórico que será disponibilizado e
      nos artefatos. Revisar dados pessoais, screenshots, contatos e origens à parte;
      um scanner de secrets não certifica ausência de PII.
- [ ] Se a entrega for snapshot de fontes, imagem ou bundle, revisar também
      skills/importações, binários/ferramentas, fontes OFL e schemas embutidos.
      As provas dos cinco tarballs não autorizam outros formatos.
- [ ] Para site/downloads, revisar também os bytes copiados de `apps/console/public/`,
      inclusive XML sintético, exemplos/contrato/documentação e fontes com OFL.
      Registrar o aceite desse conteúdo; `noindex` não é controle de acesso.
- [ ] Conferir cobertura fiscal, runtimes e pendências em [EVIDENCE.md](../v1.0/EVIDENCE.md).
      Exigir as provas aplicáveis ao escopo anunciado, incluindo piloto no
      navegador e prova fiscal real quando a capacidade depender deles.
      A documentação pública deve refletir somente essa cobertura.
- [ ] Atualizar CHANGELOG, migrações e documentação de instalação. Confirmar
      canal privado de segurança funcional e política de suporte.
- [ ] Registrar na issue da entrega aprovação da publicação, com artefatos e hashes.
      Só então remover `private` dos artefatos aprovados em mudança revisada,
      atualizar o gate de preparação privada e repetir as provas.
- [ ] Publicar os exatos bytes aceitos; conferir instalação pelo registry e
      registrar tag, versão, integridade e recibo. Publicar release notes somente
      após essa conferência. Só `scripts/distribution/publish-packages.mjs`, rodado pelo mantenedor
      com 2FA, publica no registry. O primeiro lote, de 01/11/2026, está em
      evidence/83/2026-11-01; o do SDK com o nome novo, em evidence/73/2026-11-03.
- [ ] Na mudança que registra o recibo da publicação, gravar em
      `packages/contracts/published.json` a versão do contrato publicado, o commit
      dos bytes publicados e o SHA-256 de `docs/v1.0/openapi.json` nesse commit,
      e a data real da publicação. A partir daí o gate de contrato recusa mudança
      nesse major ([política de 26/10/2026](../v1.0/SDK.md#versionamento)).

## Publicar um lote aceito

1. No SHA escolhido, num checkout limpo, rode as provas do checklist. A
   `distribution:prove` grava os tarballs e `.ci-results/83/tarballs.json`.
2. Gere a relação de `rights` desses bytes com
   `node scripts/licenses/rights-relation.mjs <evidência>/rights.json`. Registre em
   `docs/v1.0/evidence/83/<data>/` o recibo, a relação e um `accepted.json`
   com `codeSha` e, por pacote, `name`, `version` e `sha256`.
   O lote pode listar só parte dos pacotes, como o SDK com o nome novo; os
   demais precisam já estar no registry com os bytes de um lote anterior.
3. O mantenedor aceita na #83 cada linha: pacote, versão, hash, `rights` e
   `release-acceptance`.
4. Com `npm login` na conta da organização `freecorps`, no mesmo checkout:
   `node scripts/distribution/publish-packages.mjs <evidência>/accepted.json`. O script
   confere SHA, prova e hash de cada tarball, publica na ordem das dependências
   e pede o código 2FA a cada pacote. Repetir pula o que já está publicado com
   os mesmos bytes e para se a versão existir com outros bytes. `--dry-run`
   simula sem publicar.
5. Ainda no mesmo SHA, `bun scripts/distribution/prove-distribution.mjs --registry` confere
   que o registry tem os bytes refeitos nesta revisão e repete os consumidores
   instalando do registry; o resultado fica em `.ci-results/83/registry.json`.
6. Registre o recibo da publicação e `packages/contracts/published.json` numa PR.

Os tarballs não fixam a resolução futura das dependências transitivas.
`distribution:prove` recusa versões/integridades fora do inventário; um
consumidor npm comum não executa esse gate e pode resolver uma versão nova
dentro dos intervalos declarados. Repita a prova e a revisão no aceite da
release. Se a release prometer instalação reproduzível posteriormente,
defina e valide uma estratégia de fixação do grafo antes de publicar.

O scanner usado na preparação da distribuição foi Gitleaks 8.30.1, binário oficial conferido pelo
checksum da release. Exemplo de execução com saída redigida e acesso restrito:

```powershell
gitleaks git --log-opts=HEAD --redact=100 --report-format=json --report-path=.ci-results/83/history-redacted.json
```

Essa seleção cobre a ancestralidade de HEAD, não refs locais de outros
trabalhos nem todos os refs remotos. Antes de tornar um repositório público,
o responsável deve conferir também as branches/tags que serão expostas.
Não publique o relatório bruto; registre só classificação, localização,
revisão e limites. Não use uma allowlist genérica para ignorar novas chaves.
