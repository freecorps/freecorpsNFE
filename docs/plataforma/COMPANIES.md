# Empresas e primeiros passos

Contrato B02/F02 implementado na gestão de empresas, sobre os memberships da
[gestão de organizações](ORGANIZATIONS.md). Empresa pertence a uma organização. O par
organização+CNPJ é sua identidade de cadastro, protegido na transação que
consulta o índice e insere o documento. O mesmo CNPJ em outra organização
não compartilha dados, permissões nem estado do onboarding.

## Cadastro e origem

CNPJ é texto do formulário até o banco. O normalizador aceita 14 posições
ou a máscara completa, converte letras ASCII para maiúsculas e remove apenas
a pontuação prevista. Preserva zeros, rejeita formato inválido e confere os
dois DVs por módulo 11, usando ASCII menos 48. A
[fixture identificada](../../packages/contracts/fixtures/cnpj.json) inclui o
exemplo alfanumérico oficial e um exemplo numérico sintético com seus cálculos.
Isso valida a estrutura do identificador, não sua existência na Receita.
Não há campo CPF neste recorte.

Nome e endereço são declarados pelo gestor. A atualização exige versão atual,
mantém CNPJ fixo e grava autor, data e origem dos campos. Repetir cadastro com
o mesmo CNPJ retorna a empresa existente, sem substituir seus dados. A UI
explica a recuperação e oferece um link para essa empresa. Pedidos concorrentes
que criam a mesma identidade resultam em uma empresa e um evento de criação.

O cadastro aceita dados da [consulta antes do cadastro](REGISTRY.md#consulta-antes-do-cadastro).
`companies.create` recebe opcionalmente
`registry: {lookupId, expectedCacheVersion, fields}`, com `fields` entre
`name` e `address`. Na mesma transação, o servidor exige consulta da própria
organização para o mesmo CNPJ, não expirada, sem cota esgotada, e cache
encontrado, vigente, sem restrição e na versão revisada; outra versão é
`REGISTRY_CHANGED`. Os campos marcados recebem os valores do cache, nunca os
enviados, com origem `registry`; os demais seguem os valores digitados e a
origem `declared`. Os valores enviados, de todos os campos, passam pela
validação do cadastro e ficam como `before` em `registryApplications`, com o
evento `company.registry_applied`. O console envia nos campos marcados os
próprios valores consultados, porque um campo marcado mostra o valor da fonte;
nesses campos, `before` e `after` coincidem. Se a empresa já existe, a resposta é
`reused: true` e nada é alterado. Endereço consultado incompleto é recusado
pela mesma validação; o cadastro manual continua disponível. No console, cada
campo mostra o valor consultado, enquanto "Usar nome" ou "Usar endereço" está
marcado e a consulta vale, ou o que a pessoa digitou, mesmo vazio. A consulta
encontrada marca só os campos sem nada digitado, e nunca um endereço
incompleto. Editar um campo consultado o desmarca e torna o texto editado o
valor digitado; desmarcar volta ao digitado. Assim, texto da fonte só é salvo
como `declared` depois de editado. A página da empresa mostra a origem de cada
campo no cadastro.

## Exclusão de cadastro feito por engano

O CNPJ não muda depois do cadastro. Um CNPJ errado se corrige excluindo a
empresa e cadastrando de novo. `companies.remove` exige gestor, a versão atual
e o CNPJ digitado como confirmação (`CONFIRMATION_MISMATCH` se não confere).
A demonstração não é excluída. Só sai a empresa sem histórico:
`COMPANY_HAS_HISTORY` recusa quando há documento, artefato ou listagem,
importação, emissão, sequência ou simulação de DPS, evento do gate de
produção, captura, concessão a projeto (ativa ou revogada, que cobre chaves,
operações e exportações), webhook, conexão Stripe ou certificado que não seja
uma tentativa `rejected`; um certificado ainda em envio ou validação também
recusa. A consulta `companies.deletion` responde se a exclusão é possível; o
console só mostra o formulário nesse caso, na aba Resumo.

Na mesma transação saem concessões de membros, histórico da empresa,
tentativas de certificado rejeitadas com sua trilha, perfil NFS-e, sugestões
cadastrais aplicadas e o gate da empresa; a seleção do onboarding que apontava
para ela fica vazia. O CNPJ volta a ficar livre na organização. A trilha
operacional da organização registra `company.deleted`. Uma empresa com
histórico continua cadastrada; arquivamento ainda não existe.

O tipo `CompanySuggestion` preparou B08 com nome/URL da fonte, data da consulta,
data de atualização da fonte quando conhecida e campos sugeridos. A
[consulta cadastral](REGISTRY.md) implementa B08: mostra a origem e permite
selecionar e confirmar os campos. Os comandos não aceitam origem externa
enviada pelo cliente. A ausência de consulta não bloqueia cadastro manual.
No REST de empresas, `registryStatus: not-consulted` e
`fiscalAccess: not-configured` continuam marcadores fixos de compatibilidade.

## Permissões

| Papel na organização | Leitura da empresa     | Gestão do cadastro e concessões | Capacidade futura de operar documentos |
| -------------------- | ---------------------- | ------------------------------- | -------------------------------------- |
| Owner/admin          | Todas da organização   | Permitida                       | Permitida pelo papel                   |
| Operator             | Apenas concessão ativa | Negada                          | Permitida pelo papel e concessão       |
| Developer/viewer     | Apenas concessão ativa | Negada                          | Negada                                 |

As capacidades não configuram certificado nem habilitam uma operação fiscal.
Cada função autentica a sessão, confere membership ativo e organização do
recurso. Os membros sem gestão precisam de concessão explícita por empresa.
A concessão não amplia o papel vigente. Gestores herdam acesso; uma concessão
não pode retirar nem substituir esse acesso herdado.

Conceder/revogar exige as versões atuais de membership e concessão. Remover
um membro incrementa `companyAccessEpoch`, invalidando todas as concessões
anteriores em uma escrita. O campo é opcional para compatibilidade com os
memberships existentes, equivalendo a zero quando ausente. A reentrada por
convite conserva essa geração; um gestor deve conceder novamente. Mudanças de
papel recalculam capacidades em cada consulta, sem copiar permissões para a sessão.

Listas de empresas, membros e histórico são paginadas por índice. A UI usa
consultas reativas e remonta formulários ao mudar organização, empresa ou
versão de acesso. Uma empresa revogada desaparece da lista e da página aberta.
Um ID de empresa não disponível no contexto retorna o mesmo estado vazio,
sem informar a existência em outra organização.

## Perfil de emissão NFS-e

O perfil de emissão guarda os dados fiscais que a emissão usa; salvá-lo não
emite, não reserva número de DPS e não envia nada ao fisco. A emissão em
sandbox, com o provedor simulado, fica na tela Emissão NFS-e do console;
produção fica atrás de um gate por empresa ([ISSUANCE.md](ISSUANCE.md)). Não há
REST nem SDK para o perfil nesta fase.

Cada empresa declarada tem no máximo um perfil (`nfseProfiles`, função
`platform/convex/nfseProfiles.ts`). O servidor normaliza e valida todos os
campos em `platform/convex/lib/nfseProfile.ts`; o formulário repete as regras
só como orientação.

| Campo                    | Regra                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inscrição municipal      | Opcional. Pontos, traços, barras e espaços são removidos; restam até 15 letras ou números. Vai na DPS só pelo canal de Campinas (IMA); a Sefin Nacional não a recebe (E0120). |
| Código IBGE do município | Sete dígitos, com prefixo de UF válido e da mesma UF do endereço da empresa.                                                                                                  |
| `opSimpNac`              | 1 não optante, 2 MEI, 3 ME/EPP.                                                                                                                                               |
| `regApTribSN`            | Obrigatório apenas para ME/EPP (`opSimpNac` 3) e recusado nos demais: 1 tudo pelo Simples, 2 federais pelo Simples e ISSQN fora, 3 tudo fora.                                 |
| `regEspTrib`             | 0 nenhum, 1 ato cooperado, 2 estimativa, 3 microempresa municipal, 4 notário ou registrador, 5 profissional autônomo, 6 sociedade de profissionais.                           |
| Série da DPS             | Um a cinco dígitos, diferente de zero, gravada sem zeros à esquerda. É a série da Sefin Nacional.                                                                             |
| Série da DPS em Campinas | Opcional, de 10001 a 49999 (faixa de integração da Prefeitura, L0022). Usada no canal `campinas-adn`; sem ela, vale a série acima se estiver na faixa.                        |
| E-mail do prestador      | Opcional, até 80 caracteres. Vai em `prest/email` quando o pedido de emissão não traz `issuerEmail`.                                                                          |
| Atividades               | Uma a 50 atividades.                                                                                                                                                          |

Cada atividade tem código interno (até 40 letras, números, `.`, `_` ou `-`,
único na lista sem diferenciar maiúsculas), rótulo (até 80 caracteres), CNAE
(sete dígitos, `6202-3/00` vira `6202300`), item da LC 116 (`01.05`; `1.05` e
`0105` também são aceitos), código de tributação nacional `cTribNac` (seis
dígitos, que precisam começar pelo item e subitem da LC 116), NBS opcional
(nove dígitos), código de tributação municipal `cTribMun` opcional (três
dígitos: o sufixo que o município acrescenta ao `cTribNac`, como `001` em
`010501001`; o código de nove dígitos é recusado), classificação IBS/CBS
opcional e descrição padrão opcional (até 1000 caracteres). Duas atividades
com a mesma classificação (CNAE, item, `cTribNac`, NBS e `cTribMun`) também
são recusadas. O erro indica o código e a posição da atividade.

A classificação IBS/CBS é o mínimo do grupo `IBSCBS` da DPS 1.01 (NT 005/2025):
indicador da operação `cIndOp` (seis dígitos, Anexo VII), `CST` (três dígitos)
e `cClassTrib` (seis dígitos, Anexo VI), os três juntos. A plataforma escreve
`finNFSe` 0 e `indDest` 0 (o destinatário é o tomador) e não declara valores
de IBS/CBS. Os códigos são decisão da contabilidade; os exemplos do formulário
(`100501`, `000`, `000001`) são os que o legado usou na homologação de
Campinas e não foram conferidos para cada regime.

A classificação IBS/CBS continua opcional ao salvar o perfil, mas a emissão a
exige em qualquer canal quando o Ato Conjunto RFB/CGIBS 4/2026 torna o grupo
obrigatório para o fato gerador da nota: não optante desde 01/10/2026, ou
desde 01/12/2026 nos subitens 1.03, 1.05, 1.09 e 16.01; optante do Simples
Nacional, MEI incluído, desde 01/01/2027. Sem ela, o pedido é recusado com
`NFSE_ROUTE_PROFILE_INCOMPLETE` e `missing: ["ibsCbs"]`. O formulário mostra,
para o regime escolhido, a competência a partir da qual a classificação é
exigida, montada da mesma tabela do servidor (`IBSCBS_RULES`), e avisa da
exportação recusada só quando alguma já seria. Como `dCompet` cai sempre no
mês da competência e as datas do Ato começam no dia 1º, a competência dá a
mesma resposta que o fato gerador. Veja
[ISSUANCE.md](ISSUANCE.md#grupo-ibscbs).

O canal de Campinas (`campinas-adn`) exige `cTribMun`, NBS e IBS/CBS na
atividade e uma série na faixa de integração, também antes dessas datas. A
Sefin Nacional ignora `cTribMun` e a série de Campinas. Veja
[ISSUANCE.md](ISSUANCE.md#canal-de-campinas).

### Número inicial da DPS

Se a empresa já emitiu DPS com uma série fora da plataforma, o Id da DPS
(município, CNPJ, série e número) coincidiria com o de uma nota alheia. Por
isso, owner ou admin define o primeiro número de cada série do perfil em cada
ambiente (`nfseProfiles.setDpsStart`, de 1 a 999999999999999). A mudança só é
aceita enquanto a plataforma não reservou nenhum número daquela série e
ambiente; depois, `DPS_START_LOCKED`. Cada definição grava quem e quando em
`dpsSequences` e registra `company.nfse_dps_start_set` no histórico e na
auditoria. `nfseProfiles.sequences` lista, para quem lê o perfil, o início, o
próximo número e se a numeração já está em uso. Série fora do perfil é
`INVALID_DPS_SERIES`; sem perfil, `NFSE_PROFILE_REQUIRED`; empresa de
demonstração, `DEMONSTRATION_READ_ONLY`.

A alíquota de ISS não fica no perfil: ela virá por competência em cada pedido
de emissão. O ambiente também não: o perfil vale para a empresa e o gate de
ambiente pertence à emissão.

Leem o perfil os membros com acesso à empresa, pela mesma regra da página da
empresa. Criar e alterar exige owner ou admin, a mesma regra do cadastro e dos
certificados; developer, operator e viewer veem o resumo somente leitura. A
empresa de demonstração não recebe perfil (`DEMONSTRATION_READ_ONLY`) e a
seção não aparece para ela. Cada gravação exige a versão atual
(`NFSE_PROFILE_CHANGED` quando outra sessão salvou antes), incrementa
`version` e registra `company.nfse_profile_created` ou
`company.nfse_profile_updated` no histórico da empresa e na auditoria
operacional. Salvar o mesmo conteúdo não cria versão nem evento. O perfil sai
com a empresa no [encerramento da organização](RETENTION.md#encerramento-implementado-d01).

No console, o perfil fica na aba Fiscal da empresa (`?aba=fiscal`), em modo
resumo; owner e admin abrem o formulário por "Criar perfil de emissão" ou
"Editar perfil". O formulário confere as regras acima em todos os campos antes
de enviar e mostra cada erro junto ao campo, com um resumo no topo; um erro do
servidor que indica a atividade marca o campo correspondente dela. O número
inicial da DPS é o passo 2 da mesma aba: antes do perfil salvo, a aba explica
que ele vem depois; com o perfil, cada série diz se ainda pode mudar ou se já
travou, e o seletor de série lista só as livres, avisando que as travadas não
aparecem. As duas séries dizem no formulário e no resumo em qual canal valem:
a Série da DPS na Sefin Nacional e a de Campinas só no canal `campinas-adn`.
O código IBGE pode ser preenchido pela busca por nome na tabela de municípios
(`references.search`), sem função nova no backend.

## Onboarding

Escolha, empresa selecionada e dispensa de orientação persistem por organização.
No console, "Cadastrar minha empresa" grava o caminho manual e abre o
formulário de cadastro; a demonstração continua disponível depois da escolha.
Cada etapa mostra um status próprio: sem caminho escolhido, aguardando cadastro,
sem empresa liberada para quem não administra ou aguardando importação.
A criação manual preenche uma seleção inicialmente vazia. Trocar o caminho
não remove empresas; selecionar uma empresa ajusta o caminho à sua finalidade.
Versões impedem que uma aba antiga substitua uma escolha mais recente.

A demonstração usa o exemplo de CNPJ do manual da Receita e endereço sintético,
com identificação visual e cadastro somente para leitura. Nunca se converte
silenciosamente em empresa declarada, nem o inverso. Começa sem PFX. A etapa
de primeiro documento permanece `pending-import` até a empresa selecionada
ter um documento em sandbox, quando passa a `imported`; dispensar orientação
não conclui essa etapa.

Projetos e chaves pertencem à gestão de projetos e chaves. Provedor cadastral pertence a B08. O tema
verde e a tipografia Geist permanecem os mesmos. As provas e seus limites
ficam no registro da gestão de empresas.
