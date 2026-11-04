# Telas principais do console

**Contrato de referência.** Organizações, empresas, documentos, projetos e
chaves e webhooks, nos documentos de `docs/plataforma/` ligados por
[docs/README.md](../../../../docs/README.md); validação no navegador em
[navegador.md](../../../../docs/desenvolvimento/navegador.md).

**Entradas cobertas.** O console local servido pelo dev do worktree, com uma
conta autenticada pela tela de login. A REST entra só para importar a NF-e do
seed.

**Pré-condições.** Worktree da plataforma com setup concluído, dev pronto
(`start-dev.mjs`) e a conta de `seed-account.mjs`.

**Passos e resultado esperado.**

| Tela          | Rota (estado dados)                       | Dados                                        | Vazio                                  | Erro (rota forjada)          |
| ------------- | ----------------------------------------- | -------------------------------------------- | -------------------------------------- | ---------------------------- |
| Organização   | `/app/<org>`                              | Início com a NF-e 69 e a importação concluída | Início com "Sua tarefa" sem etapas feitas | "Organização indisponível."  |
| Empresas      | `/app/<org>/companies`                    | Empresa de demonstração                      | "Nenhuma empresa disponível."          | "Empresa indisponível."      |
| Documentos    | `/app/<org>/documents?company=<id>`       | NF-e 69, R$ 24,69                            | "Comece por uma empresa"               | Alerta "Empresa indisponível" |
| Chaves de API | `/app/<org>/developer/keys/<projeto>`     | "Chave de verificação", só o prefixo          | "Nenhum projeto disponível"            | "Projeto indisponível."      |
| Webhooks      | `/app/<org>/developer/webhooks/<projeto>` | Destino `https://webhook.example.com/freecorps` | "Nenhum projeto disponível"         | "Projeto indisponível."      |

No estado carregando, a mesma rota de dados mostra os esqueletos de
carregamento, porque o navegador retém as respostas do Convex.

**Prova.** Execução de 04/11/2026 neste worktree, sobre `485c71c` com a skill
em edição, da preparação à limpeza: `start-dev.mjs` iniciou o dev pelo
supervisor, `seed-account.mjs` reaproveitou a conta, `capture-screens.mjs`
gravou `antes` e, com uma mudança descartável na descrição de Empresas,
`depois`. As 40 capturas tiveram veredito `conforme`, sem violação do axe; entre as
rodadas mudaram as de Empresas com a descrição (dados e vazio) e, pela
animação dos esqueletos, as de carregando. Depois de parar as animações na
captura, duas rodadas sem mudança, de dados e carregando, saíram idênticas byte
a byte. `stop-dev.mjs` parou o dev pelo
supervisor: a operação do worktree voltou a `idle` e nenhum processo dele
ficou rodando.

**Limitações.**

- O estado carregando é provocado no navegador (respostas do Convex retidas),
  não por lentidão real do backend.
- O erro cobre identificadores forjados ou de outra conta; falha do backend
  durante a navegação não é exercitada.
- O veredito é uma leitura da tela (título, esqueleto, alerta); a comparação
  antes e depois continua sendo das imagens.
- Chaves e webhooks não têm estado vazio próprio sem projeto: a rota vazia
  mostra a escolha de projeto, igual nas duas.
