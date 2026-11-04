# Termos da captura fiscal e termos de uso

Este diretório guarda os textos legais do serviço hospedado, cada versão num
arquivo imutável: os termos que a empresa aceita no console para ligar a
[captura fiscal no site](../plataforma/CAPTURE.md#liberação-fiscal-no-site)
(ADR 0007, emenda de 22/10/2026), os [termos de uso](#termos-de-uso), com a
cláusula de operadora, que a organização aceita (#586), e a
[política de privacidade](#política-de-privacidade). As fontes de cada
afirmação e as decisões ficam em `docs/v1.0/`:
[termos de uso](../v1.0/TERMS-DRAFT.md),
[cláusula de operadora](../v1.0/OPERADORA-DRAFT.md) e
[política de privacidade](../v1.0/PRIVACY-DRAFT.md).

| Caminho                                                  | O que é                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`arquivo/`](arquivo/)                                   | Cada versão oferecida no console, com o texto exato que a pessoa leu e aceitou |
| [`captura-fiscal-proxima.md`](captura-fiscal-proxima.md) | Próxima versão, aprovada sem jurídico em 28/10/2026 (#586); não vigente        |

## Versões arquivadas

| Versão                               | No console desde                | SHA-256 do arquivo                                                 | Situação                  |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| `captura-fiscal-2026-10-22`          | 22/10/2026, PR #406 (`a4ec90c`) | `46dfca81f3c7413e2001d76c011417a9fd03a1f4bb3a863af7e7811a37379daa` | Atual                     |
| `termos-de-uso-2026-11-01`           | 01/11/2026 (#428)               | `9473250bf91250e3bb6091f01eb1f6e05b6e5259a440027bd7761b3de23e1e3b` | Substituída em 02/11/2026 |
| `termos-de-uso-2026-11-02`           | 02/11/2026 (#142)               | `3d0ebb439785d879900f7822b6d7bfa2480737ea0acdf8824db6498f85ba5984` | Substituída em 04/11/2026 |
| `termos-de-uso-2026-11-04`           | 04/11/2026 (ADR 0012)           | `41a617856f796a8d6219d04eb4a5260effc3eb59669d6146c483ca7f2f130748` | Atual                     |
| `politica-de-privacidade-2026-11-01` | 01/11/2026 (#428)               | `02742f6e09412c1120dfde651216ce4c4c9c601a63fd453aaf3109dd04a3a899` | Atual                     |

O texto de `captura-fiscal-2026-10-22` é o mesmo desde que entrou no console.
O histórico do Git mostra uma única mudança no componente, em 23/10/2026
(`82bf10d`, PR #448, da #432): ela trocou classes de CSS e não mudou nenhuma palavra.
Até a #428 o texto vivia só no componente; o arquivo reproduz esse texto, um
parágrafo por linha.

## Uma fonte só

O arquivo é a única cópia do texto. O console o importa sem transformar
(`apps/console/src/capture-terms.tsx`) e o mostra no formulário de ativação e
na página `/termos/captura-fiscal/<versão>`, que só abre para quem entrou no
console. O servidor guarda a versão e o SHA-256 de cada arquivo em
`CAPTURE_TERMS_ARCHIVE` (`platform/convex/lib/fiscalCaptureRelease.ts`).
`apps/console/src/capture-terms.test.tsx` falha quando:

- um arquivo de `arquivo/` não está em `CAPTURE_TERMS_ARCHIVE`, ou o inverso;
- o SHA-256 do arquivo difere do registrado;
- o arquivo tem CR ou BOM, ou marcação que o console mostraria crua (ênfase,
  link, colchetes, lista numerada, recuo, título que não seja um bloco de uma
  linha `## Título`);
- o texto que o console mostra difere do arquivo.

O formatador não toca `docs/termos/arquivo/` (`vite.config.ts`), e o
`.gitattributes` fixa LF nesses arquivos. O texto aceito por alguém não muda:
um texto novo é outra versão, num arquivo novo.

Para conferir um hash, com o arquivo como está no Git:

```sh
git show HEAD:docs/termos/arquivo/captura-fiscal-2026-10-22.md | sha256sum
```

No PowerShell, num checkout com LF:

```powershell
Get-FileHash -Algorithm SHA256 docs\termos\arquivo\captura-fiscal-2026-10-22.md
```

## O que o servidor registra no aceite

`captureRelease.enable` só aceita a versão atual (`CAPTURE_TERMS_VERSION`;
outra responde `CAPTURE_RELEASE_TERMS_REQUIRED`). O evento
`console_release` de `captureReleaseEvents` grava a pessoa
(`membershipId`), a versão (`terms`) e, desde a #428, o SHA-256 do texto
(`termsSha256`), escolhidos pelo servidor. Os aceites anteriores têm só a
versão; como o texto de uma versão não muda, a versão continua apontando para
o arquivo certo, e nenhum aceite antigo foi reescrito.

`captureRelease.status` devolve `acceptedTerms`, o aceite da liberação em
vigor, lido do evento que liberou: a versão, o horário e o nome de quem
aceitou. O nome vai só para Proprietário e Administrador, os papéis que veem
os membros da organização ([ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md));
os outros papéis recebem `acceptedBy: null`. O nome é o que o membership
guarda, também de quem já saiu. Com a captura desligada, retirada pela
Freecorps ou cortada no deployment, o valor é `null`.

Para as pessoas, cada versão se chama pela data em que passou a ser pedida
(`since` em `CAPTURE_TERMS_ARCHIVE`): a linha "Captura fiscal ativa" diz
"Termos de 22/10/2026 aceitos por <nome> em <data e hora>" e o link "Ler os
termos". O identificador da versão fica na página dos termos, com a situação
("Em vigor para novas ativações", ou "Substituída em <data>; vale para as
ativações feitas antes até <último dia do prazo>, prazo para aceitar a nova")
e o hash. O link leva o endereço de onde foi aberto
(`?voltar=`, conferido como o retorno do login), e "Voltar" devolve a pessoa
à aba Captura da empresa; aberta direto, a página oferece as organizações. O
formulário de ativação mostra o texto da versão que o servidor pede; uma
página aberta antes de uma versão nova, sem esse texto, não deixa marcar o
aceite.
Evidência no navegador.

## Publicar uma versão nova

Nada disso foi feito. O mantenedor aprovou o texto da próxima versão em
28/10/2026, sem revisão jurídica (#586); falta o plano e o preço da captura.

1. Fechar o texto com o dono, sem marcadores "a definir".
2. Criar `arquivo/captura-fiscal-AAAA-MM-DD.md` no subconjunto aceito pelo
   console (parágrafos de uma linha e listas com `- `).
3. Acrescentar a versão, o hash e a data (`since`) a `CAPTURE_TERMS_ARCHIVE` e trocar
   `CAPTURE_TERMS_VERSION`. A versão anterior fica no arquivo e no registro.
4. Atualizar a tabela acima.

Trocar `CAPTURE_TERMS_VERSION` vale de imediato para novas ativações. Para
as empresas já liberadas, o dono decidiu em 28/10/2026 (#428): o console pede
o novo aceite e, 30 dias depois da data da versão nova (`since`), as
consultas à Receita esperam o aceite, sem retirar a liberação nem apagar
nada. Um Proprietário ou Administrador aceita na aba Captura, e as consultas
voltam em até uma hora. O servidor grava esse aceite como o da ativação, com
pessoa, versão e SHA-256 (evento `console_terms`), e a linha "Captura fiscal
ativa" passa a citá-lo
([CAPTURE.md](../plataforma/CAPTURE.md#liberação-fiscal-no-site)). Por isso
a data em `since` precisa ser a do dia em que a versão entra no console: ela
conta o prazo.

## Termos de uso

A primeira versão, `termos-de-uso-2026-11-01` (versão 1.0, com a cláusula
de operadora), entrou no console em 01/11/2026 (#428). As organizações
criadas desde então a aceitam na criação; as que já existiam têm até
01/12/2026, meia-noite de Brasília, para aceitar, e depois disso não criam
operações novas até o aceite. A data não depende de uma release global
([ADR 0011](../adr/0011-entregas-graduais.md)). O mantenedor aprovou o texto,
inclusive o anual da seção 5A e a custódia fria da seção 9, sem revisão
jurídica ([decisões de 01/11](../v1.0/TERMS-DRAFT.md#decisões-de-01112026)).
O registro da publicação está em
evidence/428/publicacao-2026-11-01.md.

A versão 1.1, `termos-de-uso-2026-11-02`, entrou no console em 02/11/2026. Ela
só tira da seção 1 a importação de lotes NFS-e ABRASF, retirada da plataforma
no mesmo dia (#142), e diz que as NFS-e já importadas continuam para leitura,
download e exportação; o resto do texto é o da 1.0. O mantenedor decidiu
publicá-la na hora, com o aviso e os 30 dias da seção 11: as organizações
aceitam a 1.1 até 02/12/2026, meia-noite de Brasília, inclusive as que ainda
não tinham aceitado a 1.0.

A versão 1.2, `termos-de-uso-2026-11-04`, entrou no console em 04/11/2026. Ela
leva a cobrança ao aniversário da contratação
([ADR 0012](../adr/0012-periodo-por-aniversario.md)): o primeiro parágrafo da
seção 5 diz que as cotas do Gratuito seguem o mês civil UTC e as dos planos
pagos, o mês da assinatura, e a seção 5A é nova inteira. Nela, os planos
pagos são só por cartão, cada mês da assinatura vai da data e hora da
contratação ao mesmo dia e hora do mês seguinte, o mensal e o anual são
cobrados na contratação e renovam no aniversário, e o reembolso do anual
conta os meses da assinatura. O Pix, a escolha do meio de pagamento e a
contratação recusada antes do dia 1 saem. O resto do texto é o da 1.1. O dono
aprovou o texto em 03/11/2026
([decisão](../v1.0/TERMS-DRAFT.md#decisão-de-03112026)); as organizações
aceitam a 1.2 até 04/12/2026, meia-noite de Brasília, inclusive as que ainda
não tinham aceitado a 1.1.

Cada versão é um arquivo `arquivo/termos-de-uso-AAAA-MM-DD.md`, imutável, no
subconjunto aceito pelo console, e o servidor guarda a versão, o SHA-256 e a
data em que entrou no console em `TERMS_OF_USE_ARCHIVE`
(`platform/convex/lib/termsOfUseArchive.ts`). O console importa o arquivo sem
transformar e o mostra no aceite e nas páginas públicas, sem login, `/termos`
(a versão em vigor) e `/termos/uso/<versão>`, com a versão, a data, o hash e
as outras versões. `apps/console/src/terms-of-use.test.tsx` falha nas mesmas
condições do teste da captura e quando um arquivo do diretório não é de uma
das três famílias. O que o fluxo faz com a versão em vigor está em
[ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md#termos-de-uso).

Nos testes da plataforma nenhuma versão vigora (`tests/setup/terms-of-use.ts`):
as organizações das suítes nascem sem o aceite que `organizations.create`
grava. `platform/convex/termsOfUse.test.ts` e `platform/convex/termsOfUseNotice.test.ts`
provam o aceite, o aviso e o corte com versões próprias.

Para publicar uma versão nova:

1. Fechar o texto com o dono, sem colchetes, com a versão e a data.
2. Criar `arquivo/termos-de-uso-AAAA-MM-DD.md` com os termos e a cláusula
   de operadora, no subconjunto do console.
3. No perfil com clientes, o e-mail de contas precisa estar ligado com
   `ACCOUNT_EMAIL_RECIPIENTS=*`, que tira a allowlist só no perfil
   `installation`; senão o aviso não chega a todos. O mantenedor decidiu em
   29/10/2026 (#428) tirá-la ([e-mail de contas](../plataforma/ACCOUNT-EMAIL.md#caminho-da-requisição-e-limites)).
4. Acrescentar a versão, o hash e a data (`since`) a `TERMS_OF_USE_ARCHIVE`
   e trocar `TERMS_OF_USE_VERSION`, no mesmo PR, e a linha da tabela acima.
5. Publicar a plataforma no mesmo dia. O aviso por e-mail aos proprietários e
   administradores, que a seção 11 dos termos promete, sai sozinho depois da
   publicação (#594), descrito abaixo.

`since` é o dia em que a versão entra no console: as organizações novas
aceitam desde então, e as existentes têm 30 dias para aceitar antes do
corte. A primeira versão também contou 30 dias para todas as organizações que
já existiam.

O estado `sent` da fila comprova aceitação pelo provedor, não recebimento
na caixa do destinatário; o registro da publicação distingue as duas
observações. Testes com relógio simulado comprovam a regra do prazo, não o
transcurso desse prazo na instalação.

## Política de privacidade

A política não é aceita: ela vale para todos e fica pública em
`/privacidade`, com a versão, a data, o hash e as versões anteriores
(`/privacidade/<versão>`), como promete a seção 9 dela. Cada versão é um
arquivo `arquivo/politica-de-privacidade-AAAA-MM-DD.md`, no mesmo subconjunto,
registrado com o SHA-256 e a data em `PRIVACY_POLICY_ARCHIVE`
(`platform/convex/lib/privacyPolicyArchive.ts`); `PRIVACY_POLICY_VERSION` é a
versão em vigor. `apps/console/src/privacy-policy.test.tsx` falha nas mesmas
condições dos termos. A primeira versão, `politica-de-privacidade-2026-11-01`,
vale desde 01/11/2026 (#428). Uma versão nova que mude o tratamento exige o
aviso de 30 dias da seção 9, por e-mail e no console; o aviso automático da
seção 11 dos termos não cobre a política, e esse aviso é feito à parte.

### Aviso por e-mail

Depois de cada publicação de um perfil com organizações (sandbox hospedado,
bootstrap incluído, produção fiscal da emissão, validação e instalação
própria local), o publicador chama `termsOfUseNotice:start`; na instalação
hospedada independente, que o operador publica pela CLI do Convex, quem chama
é ele
([instalação própria](../operacao/instalacao-propria.md#convex-cloud-e-servidor-próprio-hospedado)).
Com uma versão em
vigor, ele percorre as organizações em lotes de 100 e avisa **uma vez cada
organização por versão**, com uma mensagem a cada membro ativo com papel
`owner` ou `admin`, com a versão, a data de
vigência (`since` mais 30 dias, à meia-noite de Brasília) e o link para
`/termos/uso/<versão>`. Não recebem a organização encerrada, a que já aceitou
a versão e a que não tem proprietário nem administrador ativo. Como o envio
sai na publicação que põe a versão no console, os 30 dias da seção 11 contam
dela; por isso `since` é o dia dessa publicação, e o PR que muda
`TERMS_OF_USE_VERSION` não deve esperar para ser publicado.

O envio usa o canal do [e-mail de contas](../plataforma/ACCOUNT-EMAIL.md), com
as mesmas regras: no perfil de desenvolvimento (`APP_ENV=development`), que
inclui os worktrees e a instalação própria local de `scripts/selfhost.mjs`,
as mensagens ficam no coletor; nos demais, inclusive a instalação hospedada
independente (`APP_ENV=installation`), só os destinatários autorizados em
`ACCOUNT_EMAIL_RECIPIENTS` recebem, pela Cloudflare, ou todos com `*`, que
só a instalação aceita; na validação, portanto, só as contas da allowlist. Cada mensagem tem uma tentativa, sem
repetição automática; a linha da organização termina `sent`, `partial` ou
`unconfirmed` conforme o provedor aceite todas, parte ou nenhuma, sem
reenvio, e o aviso no console continua valendo. A falha da chamada a `start`
fica no recibo da publicação, que não reprova (no self-host local, só no log;
na instalação independente, na saída da CLI). Com `TERMS_OF_USE_VERSION` em
`null` ou com o
e-mail de contas desligado, nada é registrado nem enviado. Detalhes em
[ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md#termos-de-uso).
