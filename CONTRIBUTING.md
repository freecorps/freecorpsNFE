# Contribuir

Leia o [README](README.md), o [índice da documentação](docs/README.md), o
contrato do domínio afetado e as decisões em `docs/adr/`. Use `main` como
base. A plataforma fica em `apps/console` e `platform/convex`, com pacotes em
`packages/*`. Abra uma PR por assunto, com problema,
comportamento resultante, prova e limitações. Descreva textos visíveis em
português do Brasil.

Prepare o ambiente com [docs/worktrees.md](docs/worktrees.md): pré-requisitos,
instalação com `vp install --frozen-lockfile`, criação do worktree e conta de
teste. Os testes usam dados sintéticos e transporte simulado. O repositório é
público, inclusive issues, PRs, logs e artefatos do CI: use só dados
fictícios em commits, screenshots, recibos e comentários. Não use produção
como seed nem inclua segredos ou documentos reais.

Rode a menor prova do comportamento e depois os checks aplicáveis. A escolha
por área está na seção "Verificando" do [AGENTS.md](AGENTS.md#verificando); o
que o CI confere e como reproduzi-lo com `bun run ci:local`, em
[docs/desenvolvimento/ci.md](docs/desenvolvimento/ci.md). Antes de abrir a PR,
confira conforme a mudança (num checkout recém-instalado, rode antes
`bun run packages:build` e `bun run sdk:build` para conferir tipos):

```powershell
vp check
vp test run
bun run platform:check
bun run build
bun run contracts:check --base origin/main
bun run ci:boundaries
bun run licenses:check
bun run distribution:prove
```

Alterações nos pacotes também exigem `sdk:prove` e `xml:prove` em
consumidores limpos. `bun run help` mostra a aplicação e o ambiente de cada
comando. Mudanças de contrato, fluxo ou operação atualizam a documentação na
mesma PR; mudanças apenas de documentação pedem revisão do diff, links e
comandos descritos. CI aprovado não comprova autorização fiscal real.

Contribuições seguem a licença do arquivo de destino: Freecorps 1.0 por padrão,
MIT apenas no escopo explícito de [LICENSING.md](LICENSING.md). Antes de integrar
contribuições externas, registre o aceite expresso dos [termos de contribuição](CONTRIBUICOES.md)
pelo titular ou representante autorizado: o check `Contribution terms` só
passa uma PR de quem não é dono, membro ou colaborador do repositório com a
frase de aceite de `CONTRIBUICOES.md` na descrição, fora de comentário HTML.
O modelo de PR traz a frase pronta para copiar. Eles preservam autoria e concedem
os direitos necessários ao licenciamento comercial. Não presuma aceite por
abertura de PR nem aplique a concessão retroativamente. Identifique origem,
versão, alterações e licença
de qualquer material reaproveitado; conserve avisos e não relicencie terceiros.
Consulte [LICENSING.md](LICENSING.md) antes de incluir schema ou dataset.
Dependências novas exigem inventário atualizado e revisão das condições.

Relatos de vulnerabilidade seguem [SECURITY.md](SECURITY.md). Publicação e
suporte seguem o [checklist de release](docs/operacao/release.md).
