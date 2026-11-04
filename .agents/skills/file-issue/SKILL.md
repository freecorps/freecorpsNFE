---
name: file-issue
description: "Redigir uma issue pública ou abri-la no GitHub quando o dev pedir: defeito, pedido de recurso ou pendência encontrada no trabalho."
---

# Abrir uma issue

O repositório é público: a issue fica visível e indexada no instante em que
é criada, e editar ou apagar depois não desfaz a exposição, porque o GitHub
guarda o histórico de edições. Trate cada título, corpo e anexo como
publicação.

Redigir a issue não autoriza abri-la, comentar em outra nem mudar labels.
Siga o escopo já autorizado na sessão, sem pedir de novo o que ele inclui.
Termine primeiro o rascunho revisável e só então peça a autorização que
faltar. Para dividir um plano em várias issues, use
[to-tickets](../to-tickets/SKILL.md); para avaliar issues existentes,
[triage](../triage/SKILL.md). O tracker e a convenção de destino local estão
em [EXTERNAS.md](../EXTERNAS.md#fluxo-das-skills-de-engenharia).

## 1. Decida se o relato pode ser público

Vulnerabilidade não vira issue. Acesso a dado de outra organização, projeto
ou empresa, contorno de permissão, escopo ou concessão de API key, injeção,
credencial exposta e qualquer falha que um terceiro possa explorar seguem o
relato privado do [SECURITY.md](../../../SECURITY.md): aba Security, "Report
a vulnerability". Na dúvida, trate como vulnerabilidade e pergunte ao dev.
Credencial que já vazou também é aviso imediato ao dono do projeto, com o que
vazou e onde (AGENTS.md, "Se vazar, diga").

Este passo termina com uma resposta explícita: público ou privado.

## 2. Procure a issue que já existe

Busque pelo conceito do problema, não só pelas palavras do pedido, em
issues abertas e fechadas:

```bash
gh issue list --state all --search "<termos>" --limit 30 --json number,title,state,url
```

Repita com sinônimos do domínio e leia as candidatas. Uma resposta vazia
depois de erro de acesso não prova que não existe issue. Se houver uma que
cobre o caso, proponha comentar nela ou reabri-la em vez de abrir outra; isso
também depende de autorização. Confira em
[ACCEPTANCE.md](../../../docs/v1.0/ACCEPTANCE.md) se o "defeito" não é um
limite declarado da versão.

## 3. Escreva título e corpo

Tudo em pt-BR. O título descreve o problema observado ou o resultado
desejado, não o mecanismo da solução:

> **RUIM** — `Ajustar validator de imports`
>
> **BOM** — `Importação de NF-e recusa XML com assinatura em namespace padrão`

Siga o formulário do tipo de issue em `.github/ISSUE_TEMPLATE/`. A CLI não
preenche formulários YAML, então reproduza os campos como seções Markdown e
aplique o label que o formulário aplicaria:

| Tipo | Formulário | Seções do corpo | Label |
| --- | --- | --- | --- |
| Defeito | `bug.yml` | Onde, Versão ou revisão, Como reproduzir, O que era esperado e o que aconteceu | `bug` |
| Recurso | `recurso.yml` | Problema, Proposta, Contexto fiscal (se houver) | `enhancement` |
| Pendência interna | nenhum | Problema, Proposta, Referências | conforme o assunto |

O corpo abre pelo problema de quem usa ou opera, com a prova mínima:
passos de reprodução com dados inventados, código de erro, `requestId`,
revisão afetada e referências `caminho:linha` ao código. Termine com o
critério que diria que a issue está resolvida. Relacione issues e PRs com
`Relacionado a #123`; criar sub-issues ou bloqueios só entra quando o vínculo
fizer parte do pedido. Escreva um parágrafo por linha, sem quebra manual: o
GitHub transforma cada quebra em `<br>`.

Use só labels que já existem (`gh label list`). Labels de fila e prioridade
(`prioridade/*`, `fila/*`, `prazo/*`) são decisão do mantenedor; aplique-os
apenas quando o dev pedir.

### O que nunca entra

Vale a regra de dado real do AGENTS.md. No texto e nos anexos:

- XML, valores, itens ou chave de acesso de nota real; CNPJ, CPF, nome ou
  e-mail de cliente. Use os valores sintéticos de `tests/fixtures/`.
- API key, token, senha, CSC, certificado, URL assinada, cookie, cabeçalho
  `Authorization` e conteúdo de `.env*` ou `deployment.env`.
- Log, dump ou resposta copiada de produção; resuma o que importa com
  contagens, códigos e sufixos.
- Caminho da máquina local, nome de deployment Convex não público, nome de
  pessoa ou e-mail pessoal sem autorização dela.

Captura de tela não passa por varredura nenhuma: recorte o necessário e
confira cada pixel com dado de empresa, documento ou credencial antes de
anexar.

## 4. Varra e releia antes de publicar

Grave título e corpo em arquivos UTF-8 separados, no destino local de
`EXTERNAS.md` (`.ci-results/<assunto>/`), e rode:

```bash
node scripts/public-copy/scan-public-text.mjs <titulo.txt> <corpo.md>
```

O script aplica as regras do `Public scan` e mostra arquivo, linha e tipo de
cada achado, sem o valor. Um achado é corrigido reescrevendo o trecho com dado
sintético ou resumo; nunca imprima o valor para conferir. Saída 0 não basta:
nomes restritos, nomes de clientes e pessoas e o conteúdo de imagens ficam
fora do script. Releia o texto inteiro procurando isso.

O passo termina com o script em 0 e a releitura feita.

## 5. Abra e confira

Com a publicação autorizada, passe o título varrido como argumento literal e
o corpo por arquivo:

```bash
gh issue create --title "<título>" --body-file <corpo.md> --label <label>
```

Leia de volta com `gh issue view <número> --json number,url,title,labels,state`
e informe a URL. Depois de timeout ou resposta ambígua, procure pelo título
antes de repetir o comando, para não abrir a mesma issue duas vezes.

Se algo proibido chegou a ser publicado, avise o dono do projeto no mesmo
turno, com o que vazou e onde, e peça a revogação da credencial. Editar a
issue não remove a versão anterior do histórico; apagar a issue exige um
administrador do repositório.
