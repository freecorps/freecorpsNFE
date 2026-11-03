# Rascunho da próxima versão dos termos da captura fiscal

> **Texto aprovado pelo mantenedor em 28/10/2026, sem revisão jurídica
> (#586). Não vigente.** Este texto
> não está no console, não tem versão nem hash e não substitui a versão
> aceita hoje, [`captura-fiscal-2026-10-22`](arquivo/captura-fiscal-2026-10-22.md).
> Trechos entre colchetes dependem de decisão; nenhum pode ser preenchido por
> suposição. Ativar uma versão nova pede novo aceite das empresas já
> liberadas, com prazo de 30 dias ([publicar uma versão nova](README.md#publicar-uma-versão-nova)).

Preparado em 25/10/2026 para a #428. Cobre o que a versão atual não diz: a
guarda por cinco anos depois do encerramento, o papel de operadora da
Freecorps, plano e custo, a regra de 60 dias e os dados de pessoas físicas
dentro das NF-e. Cada afirmação aponta abaixo para o documento ou o código
que a sustenta.

## Texto proposto

O texto segue o formato que o console mostra: um parágrafo por linha e listas
com `- `. Os colchetes saem antes de arquivar; o console recusa um arquivo
com colchetes.

---

Ao ativar, você declara que representa a empresa ou tem autorização dela para que a Freecorps, em nome da organização contratante:

- consulte, com o certificado A1 da empresa, a distribuição de NF-e do Ambiente Nacional em produção, só para leitura, automaticamente e sem intervenção sua a cada consulta;
- guarde os documentos recebidos e os mostre e entregue à organização pelo console, pela API e por webhooks.

A consulta não emite, não cancela e não manifesta nada, e não gera evento para os emitentes. A Receita entrega o que tem: algumas notas chegam só como resumo, sem itens, e o XML completo pode não vir.

Os documentos recebidos têm dados de terceiros: fornecedores, transportadores e outras pessoas citadas nas notas, inclusive pessoas físicas, com nome, CPF e endereço quando o emitente os declarou. A organização é a controladora desses dados e decide sobre eles; a Freecorps os trata como operadora, só para prestar o serviço e conforme as instruções da organização, nos termos da cláusula de operadora, parte dos termos de uso do freecorpsNFE. Pedidos de titulares sobre esses dados são encaminhados à organização.

A Freecorps guarda os documentos recebidos enquanto a organização existir. Depois do encerramento da organização, há 30 dias para exportá-los; em seguida, os documentos, seus originais e a auditoria da captura ficam guardados até 31 de dezembro do quinto ano seguinte ao do encerramento, em favor da empresa e por conta da obrigação fiscal dela, e depois são apagados. Fiscalização, processo ou pedido formal de autoridade pode exigir guardar por mais tempo. Desativar a captura não apaga nada: os documentos já recebidos continuam disponíveis para consulta e exportação.

A Receita pode suspender a geração de NSU para um CNPJ que fica 60 dias sem consultar, e cada documento só fica disponível na distribuição por até 90 dias. Com a captura ativa, as consultas automáticas evitam essa suspensão. Se a captura ficar desligada ou parada por mais de 90 dias, documentos desse período podem não ser mais recebidos, e a Freecorps não tem como recuperá-los.

Outros sistemas que consultam o mesmo CNPJ, como o ERP ou o contador, continuam recebendo tudo. Mesmo assim, consultas em excesso de todos eles somadas podem levar a Receita a bloquear o CNPJ por cerca de uma hora, para todos. Você escolhe o intervalo mínimo entre consultas quando não há documentos pendentes, de 1 a 24 horas.

A captura em Produção exige plano vigente atribuído à organização, com cotas de consultas e de bytes, inclusive no plano gratuito. Cada consulta conta na cota de capturas; os bytes efetivamente recebidos contam na cota de bytes. Quando uma dessas cotas acaba, a captura para em atenção e volta sozinha quando houver saldo e plano elegível. Sem plano elegível, novas consultas não são realizadas; os documentos já recebidos continuam disponíveis. [Preço, cotas e condições comerciais: proposta na #429, ainda sem aprovação. Hoje não há preço publicado.]

A Freecorps pode suspender a captura de uma empresa por fraude, uso do certificado sem autorização, risco à segurança, ordem de autoridade ou bloqueio pela Receita, ou violação dos termos de uso. Ela avisa os Proprietários e Administradores por e-mail, com o motivo, e a empresa pode contestar pelo suporte. Os documentos já recebidos continuam disponíveis.

Você pode desativar a qualquer momento; os documentos já recebidos continuam disponíveis. Uma versão nova destes termos pede um novo aceite no console. Se ninguém a aceitar em 30 dias, as consultas à Receita esperam o aceite, sem desativar a captura; os documentos já recebidos continuam disponíveis.

---

## De onde vem cada afirmação

| Trecho                                             | Fonte                                                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consulta automática, só leitura, sem manifestação  | [ADR 0007](../adr/0007-captura-fiscal-no-site.md), §3 e §4; [CAPTURE.md](../plataforma/CAPTURE.md#liberação-fiscal-no-site)                                           |
| Notas só com resumo, XML completo que pode não vir | [CAPTURE.md](../plataforma/CAPTURE.md#fonte-e-cobertura) e ADR 0007, §3                                                                                               |
| Console, API e webhooks em Produção                | ADR 0007, §3                                                                                                                                                          |
| Pessoas físicas nas notas                          | O parser aceita CPF de emitente e destinatário (`packages/fiscal-nfe/src/parser.ts`) e o XML original é guardado inteiro ([DOCUMENTS.md](../plataforma/DOCUMENTS.md)) |
| Controladora e operadora                           | [RETENTION.md](../plataforma/RETENTION.md#guarda-após-o-encerramento-d01) e [RIGHTS.md](../plataforma/RIGHTS.md#papéis-e-responsáveis)                                |
| 30 dias, guarda até 31/12 do quinto ano, expurgo   | [RETENTION.md](../plataforma/RETENTION.md#guarda-implementada-d01): a guarda conta do ano do encerramento                                                             |
| Retenção legal além do prazo                       | `fiscalGuard:hold`, em [RETENTION.md](../plataforma/RETENTION.md#guarda-implementada-d01)                                                                             |
| Desativar não apaga                                | Tabela "Efeito" de [CAPTURE.md](../plataforma/CAPTURE.md#liberação-fiscal-no-site)                                                                                    |
| 60 dias sem consulta e 90 dias na fonte            | [CAPTURE.md](../plataforma/CAPTURE.md#fonte-e-cobertura), NT 2014.002 v1.40, e as Consequências da ADR 0007                                                           |
| Perda depois de 90 dias                            | [Lacunas e histórico limitado](../plataforma/CAPTURE.md#lacunas-e-histórico-limitado-419)                                                                             |
| Intervalo de 1 a 24 horas                          | `captureRelease.enable` e `captureRelease.updateInterval`                                                                                                             |
| Cota de capturas do plano                          | [CAPTURE.md](../plataforma/CAPTURE.md#liberação-fiscal-no-site) e [USAGE.md](../plataforma/USAGE.md#unidades-e-período)                                               |
| Suspensão pela Freecorps                           | `captureRelease.set` (`emergency_withdraw`), [captura-fiscal.md](../operacao/captura-fiscal.md); motivos na seção 8 dos [termos de uso](../v1.0/TERMS-DRAFT.md)       |
| Novo aceite em 30 dias                             | `termsStanding` e `captureRelease.acceptTerms`, [CAPTURE.md](../plataforma/CAPTURE.md#liberação-fiscal-no-site)                                                       |

## Mudanças em relação à versão aceita

- Diz em nome de quem a Freecorps age (a organização contratante) e o papel
  de operadora.
- Troca "dados de fornecedores" por terceiros e pessoas físicas, com os dados
  que aparecem.
- Acrescenta a guarda depois do encerramento, a regra de 60 dias, o limite de
  90 dias da fonte, a cota do plano e a suspensão pela Freecorps.
- Usa "documentos já recebidos", como o console depois da #424, no lugar de
  "documentos já capturados".

## Decisões de 28/10/2026

- A cláusula de operadora é parte dos termos de uso e se aceita com eles no
  console ([OPERADORA-DRAFT.md](../v1.0/OPERADORA-DRAFT.md)).
- Novo aceite: o console pede a versão nova às empresas liberadas; 30 dias
  depois da data da versão, as consultas esperam o aceite, sem retirar a
  liberação. Implementado na #428
  ([CAPTURE.md](../plataforma/CAPTURE.md#liberação-fiscal-no-site)).
- Suspensão pela Freecorps: os motivos e o aviso seguem a seção 8 dos
  [termos de uso](../v1.0/TERMS-DRAFT.md). O workflow de retirada de
  emergência registra o motivo de cada caso; o aviso por e-mail é manual.

## Pendências para decisão

- Plano e preço da captura fiscal. O texto não cita valor.
- Se o texto deve dizer a base legal da empresa para os dados de terceiros
  (a obrigação fiscal de guardar as notas) ou deixar isso ao contrato.
- Se a decisão sobre publicar política e termos de uso antes de ampliar a
  captura real (#428) muda o que este texto precisa citar.
