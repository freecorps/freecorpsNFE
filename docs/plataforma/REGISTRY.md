# Consulta cadastral CNPJ

A consulta CNPJ integra OpenCNPJ em `platform/convex` e na página da empresa do console.
Requer empresa declarada, exceto a [consulta antes do cadastro](#consulta-antes-do-cadastro).
A API exige projeto com `registry:read` no ambiente
permitido. No console, a leitura segue o acesso à empresa e a atualização exige
também papel de escrita (owner, admin ou operator), sem projeto
([ADR 0005](../adr/0005-console-sem-projeto.md)).
Cadastro manual continua disponível sem consulta. Não configura certificado,
conexão fiscal ou regularidade fiscal.

## Provedor e condições

Escolha conferida em 22/09/2026: OpenCNPJ, API pública gratuita, sem credencial,
para consulta pontual de CNPJ numérico ou alfanumérico. Host fixo
`https://api.opencnpj.org/{cnpj}?datasets=receita`, sem redirects, timeout
de dez segundos e resposta limitada a 256 KiB. Não há scraping ou fallback.

Referências do provedor na revisão `7ce70a6d026509bad88d30db6acb563db635b6e5`:

- [Contrato e formatos](https://github.com/Hitmasu/OpenCNPJ/blob/7ce70a6d026509bad88d30db6acb563db635b6e5/src/Page/src/pages/ApiPage.tsx).
- [Condições de uso](https://github.com/Hitmasu/OpenCNPJ/blob/7ce70a6d026509bad88d30db6acb563db635b6e5/src/Page/src/pages/FaqPage.tsx): uso comercial gratuito, sem suporte dedicado; dados periódicos, sem garantia de presença imediata de novas empresas.
- [Limites](https://github.com/Hitmasu/OpenCNPJ/blob/7ce70a6d026509bad88d30db6acb563db635b6e5/src/Page/src/pages/LimitsPage.tsx): consultas pontuais; proteção contra volume elevado contínuo com 429. Processamento massivo usa outros produtos.
- [Cache do serviço](https://github.com/Hitmasu/OpenCNPJ/blob/7ce70a6d026509bad88d30db6acb563db635b6e5/src/Worker/README.md), também observado nas respostas: `Cache-Control: public, max-age=86400, s-maxage=86400`.

As condições permitem enriquecimento comercial. Esta integração conserva só
uma projeção cadastral por até 30 dias, para atores autorizados daquela empresa;
não replica a base ou redistribui QSA/contatos. A licença MIT do software não
foi usada como licença dos dados. Não foi encontrada política separada com prazo
de retenção do consumidor; 30 dias é a minimização adotada pelo produto.
Mudança dos termos exige reavaliar o adapter. Não existe SLA contratado.

A [pesquisa documental de 21/10/2026](../licenses/DATA-SOURCES.md) revalidou
FAQ, limites e origem na revisão `57a3cbef3f5ecdfd7f974f82eb4b1c8f48f58674`
do OpenCNPJ. Define fundamento de reuso e atribuição à Receita, ao catálogo
e ao provedor. Após o 401 dos metadados, a captura fornecida pelo mantenedor
confirmou o rótulo Creative Commons Attribution, sem versão identificada.
O [teste de legítimo interesse](../licenses/CNPJ-LEGITIMATE-INTEREST.md) cobre
nome/endereço de pessoas naturais, cache e cadastro confirmado. A avaliação
enquadra consulta/cache como tratamento da Freecorps e cadastro confirmado
como tratamento em nome do cliente. O canal já foi ativado e ensaiado; o
[procedimento CNPJ](../operacao/cnpj-direitos.md), as funções de restrição e o
aviso público acompanham esta entrega. O fundamento de dados abertos não
substitui o atendimento dos direitos.

CNPJá pública foi considerada, mas limita cinco consultas/minuto por IP e o
material examinado não comprovou formato alfanumérico. NFE.io documenta alfa
em homologação, sem compromisso de produção na revisão consultada. OpenCNPJ
respondeu 200 para ambos os formatos na prova controlada, sem provar cobertura
universal. Fontes comparadas: [CNPJá](https://cnpja.com/api/open) e
[NFE.io](https://nfe.io/docs/release-notes/2026-3-cnpj-alfanumerico/consultas/).

## Contrato

`GET /v1/registry/cnpj/{cnpj}?companyId=...` lê somente o cache.
`POST /v1/registry/cnpj/{cnpj}/refresh`, corpo `{"companyId":"..."}` e
`Idempotency-Key`, reserva uma operação e retorna
`{data:{operationId,reused},requestId}`. Acompanhe `/v1/operations/{id}` e leia
o cadastro depois. `succeeded` encerra a tentativa; `status` do resultado
cadastral distingue encontrado, ausente e indisponível.

Ambas exigem API key e `X-Environment`. Organização/projeto vêm da chave;
empresa e CNPJ devem corresponder ao cadastro autorizado. Revogação, expiração,
concessão removida, escopo insuficiente e outro ambiente são negados inclusive
com cache quente. As rotas são aditivas no OpenAPI/SDK.

Por compatibilidade, `registryStatus` nos endpoints antigos `/v1/companies`
permanece o marcador reservado `not-consulted` do contrato 1.0.0. Não use esse
marcador para inferir o resultado desta consulta. Consumidores usam `getRegistry`;
o console usa a query cadastral atual. Remover o marcador ou ampliar seu enum
exige migração major, separada desta entrega.

O resultado contém origem, `status`, `freshness`, dados, `sourceUpdatedAt`,
`consultedAt`, `lastAttemptAt`, `expiresAt`, `refreshAfter` e `version`.
`not_consulted` significa ausência de cache. `not_found` significa ausência
na base publicada, nunca inexistência comprovada na Receita. `unavailable` e
`unsupported_format` são explícitos, sem sucesso vazio.

`sourceUpdatedAt` permanece `null`: a resposta individual não informa essa data.
A data global de `/info` não identifica a versão servida pelo cache HTTP e não
é atribuída ao cadastro. `fresh` significa prazo do cache local, sem prometer
atualização em tempo real da fonte.

## Persistência e execução

Cache por provedor+CNPJ, sem organização na resposta: 24 horas para encontrado,
uma hora para ausente e um minuto entre tentativas após erro. Atualizar dentro
do prazo reutiliza o resultado. Erro conserva os dados e a data da consulta
bem-sucedida, marcando stale. Falhas não estendem a retenção dos dados anteriores.
Expiração/stale e expurgo usam mutations agendadas, sem cron ou polling na UI.
Expurgo durante uma chamada apaga os dados antigos no prazo e conserva somente
a reserva até o fim da lease, impedindo outra consulta simultânea ao mesmo CNPJ.

Reutiliza B05, com autorização, geração, lease, fencing e idempotência. Compartilha
`capturePool`, duas execuções simultâneas, com limite adicional global de 30
chamadas/minuto e dez solicitações de atualização por organização/minuto.
São limites locais conservadores, não cotas prometidas pelo provedor.

`registryCalls` tem um recibo por operação que reservou chamada externa, custo
zero. `dispatched_or_uncertain` admite queda antes/depois do envio, sem afirmar
recepção pelo provedor. `responded` confirma resposta processada, inclusive erro.
Cache hit não gera recibo externo. O recibo B05 de operação é uma unidade distinta.
Reconciliação usa o recibo; chamada incerta falha com `REGISTRY_RESULT_UNKNOWN`,
sem retransmissão. Nova tentativa exige nova solicitação e respeita limites.

Não se guarda payload bruto, QSA, e-mail ou telefone. Cache contém razão social,
endereço e situação. Histórico de operação guarda só provedor/CNPJ. Recibos
externos não contêm payload cadastral.

## Confirmação

Owner/admin confirma razão social e/ou endereço, inicialmente desmarcados.
O servidor carrega a sugestão pelo CNPJ da empresa, exige cache encontrado e
vigente e confere versões da empresa/cache. Não aceita payload ou origem do
cliente. Operator pode atualizar; viewer só lê. Demonstração não chama a fonte
nem lê o cache compartilhado; a API responde 404 nesse caso.

Aplicação preserva campos não selecionados, valores anteriores, autor, origem
e datas em `registryApplications`, com evento na empresa. Edição manual posterior
altera a origem só dos campos modificados. Histórico cadastral confirmado
permanece com a empresa; não é cache descartável.

## Provas

`platform/convex/registry.test.ts` e, para a consulta antes do cadastro,
`platform/convex/companies.test.ts` simulam o transporte. O runner
`node --experimental-strip-types apps/console/e2e/registry.mjs` exige worktree
platform ativo, usa dados sintéticos e exercita operação nativa com cache hit.
Não chama provedor. `bun scripts/fiscal/prove-registry-provider.mjs` é prova online
separada, só leitura, com os CNPJs públicos do Banco do Brasil numérico e alfa.
Guarda metadados/hashes sanitizados, sem semear banco ou salvar resposta bruta.
Não executar como teste offline ou em loop. Evidências.

A conferência de 30/09/2026 repetiu as consultas
públicas numérica e alfanumérica, conferiu cache/confirmação no Convex local
com dados sintéticos e registrou a revisão atual dos documentos do provedor.
As condições de redistribuição seguem na
#83; a viabilidade da consulta não autoriza publicar a base nem os payloads.

## Consulta antes do cadastro

Owner e admin, os mesmos papéis que cadastram empresa, consultam um CNPJ
antes de a empresa existir, só pelo console; não há rota REST que crie
empresa. `registry.lookup` recebe organização, CNPJ e uma chave de
idempotência do cliente. O ambiente é o do deployment (`PRODUCT_ENV`), nunca
o do chamador: sem empresa, não há liberação que sirva produção num
deployment sandbox. Se a organização já tem empresa com esse CNPJ, responde
`{kind:"existing",companyId}` sem consultar a fonte. Caso contrário grava uma
consulta em `registryLookups` (organização, CNPJ, autor, chave, ambiente e
datas, sem dado cadastral) e responde `{kind:"lookup",lookupId,reused}`. A
mesma chave devolve a mesma consulta, sem outra chamada nem outra cobrança,
enquanto a consulta existe (24 horas); depois disso a chave abre uma consulta
nova. A mesma chave com outro CNPJ é `IDEMPOTENCY_CONFLICT`.

Valem as regras da atualização: limite de dez solicitações por organização e
minuto (`registry-refresh`), cache vigente sem chamada, uma chamada por CNPJ
de cada vez, limite global de 30 chamadas/minuto e cota `registry` do plano
no ambiente do deployment, cobrada só quando a fonte é chamada. A chamada sai
por uma action agendada com reserva de 30 segundos no cache. Uma falha
inesperada da action é gravada como `unavailable`, com o mesmo intervalo de
um minuto de qualquer erro. Quando uma reserva vence sem resposta, seja da
consulta ou de uma operação que ela aguardava, a mutation agendada `settle`
a libera, aplica esse intervalo e descarta uma resposta posterior; uma reserva
mais nova ainda em curso fica intacta e é conferida no seu próprio prazo. O
estado da chamada fica na própria consulta, não em `registryCalls`, que
pertence às operações.

`registry.lookupStatus` mostra o estado a owner e admin da organização dona da
consulta: `pending`, `found`, `expired`, `not_found`, `unavailable`,
`unsupported_format` ou `quota`. Só `found` traz nome, endereço, situação,
`consultedAt`, `sourceUpdatedAt`, `expiresAt` e `cacheVersion`. `expired`
significa que o cache encontrado passou das 24 horas: a tela pede nova
consulta. A query não lê o relógio; `pending` e `expired` vêm de campos que
as mutations agendadas atualizam. O cache continua global; este caminho só o
mostra pela consulta da própria organização, e o ID de uma consulta alheia é
negado. CNPJ com restrição aparece como `unavailable`, sem dados e sem
chamada.

O cadastro com dados consultados está em [COMPANIES.md](COMPANIES.md#cadastro-e-origem).
No console, o formulário "Cadastrar uma empresa" chama `registry.lookup` com
uma chave por tentativa, reaproveitada só quando a resposta se perdeu, e
acompanha `registry.lookupStatus` ao vivo. A query que falha porque a consulta
foi apagada responde `ACCESS_DENIED`, que não se distingue de uma permissão
perdida; a tela diz "Esta consulta não está mais disponível" e oferece nova
consulta. A tela está descrita em
[frontend.md](../desenvolvimento/frontend.md#telas-por-área).
A consulta é apagada por mutation agendada 24 horas depois de criada,
independentemente da idade do cache que ela mostra, e sai também no expurgo
de encerramento da organização (classe `closure`). Ela não guarda dado
cadastral, então a restrição e o expurgo do cache já cobrem o que ela
mostraria. O [teste de legítimo interesse](../licenses/CNPJ-LEGITIMATE-INTEREST.md)
e o aviso público registram a consulta feita por gestor antes do cadastro,
confirmada pelo mantenedor em 31/10/2026.

## Direitos dos titulares

O [procedimento CNPJ](../operacao/cnpj-direitos.md) usa a caixa de privacidade
já existente. Uma decisão deferida executada por administrador em
`registryStore:restrict` remove o cache e grava `registryRestrictions` por
CNPJ, fora do prazo descartável do cache. Leitura retorna `unavailable` sem
dados, atualização e aplicação são negadas, fila não consulta a fonte e
resposta em trânsito não repovoa o cache. Uma liberação exige nova decisão;
não restaura dados nem dispara consulta. Os estados do contrato REST não mudam.

Correção do cadastro confirmado continua com o cliente controlador. A função
administrativa `eraseApplicationHistory` remove em lotes somente o histórico
da empresa/CNPJ/organização conferidos, quando houver restrição ativa e versão
de empresa correspondente. Não altera cadastro atual nem documentos fiscais.
Ambas são internas, sem endpoint de cliente. O aviso público está em
`/docs/privacidade-cnpj` e acompanha o mesmo deploy das funções.
