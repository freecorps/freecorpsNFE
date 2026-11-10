# Cofre versionado de certificados da plataforma

Status: **Aceita** pelo mantenedor, que aprovou o plano antes da
implementação. A data da decisão não foi registrada.

## Situação em 21/10/2026

> O cofre legado citado aqui (`convex/vault.ts`, `convex/nfceVault.ts`)
> foi removido pela PR [#373](https://github.com/freecorps/freecorpsNFE-arquivo/pull/373), no commit [`e1156c5`](https://github.com/freecorps/freecorpsNFE-arquivo/commit/e1156c58a126bcc664403163e63bd69c17e3b611). O cofre da plataforma
> é o único em uso.
> O código histórico continua no Git: `git show e1156c5^:<caminho>` mostra
> cada arquivo como era antes da remoção. O texto abaixo registra a decisão
> como foi tomada e não foi reescrito.

A proteção de certificados usa envelope encryption com AES-256-GCM: uma chave de dados aleatória
de 256 bits por certificado/versão cifra PFX e senha; uma chave mestra
versionada, fora do banco, protege essa chave de dados. O contexto autenticado
inclui organização, empresa, ID do certificado, versão e finalidade de cada
bloco. A decisão foi registrada antes da implementação, após aprovação do
plano pelo mantenedor. O cofre legado conserva seu contrato.

| Alternativa          | Acesso e operação                                                                                                                   | Custo e instalação própria                                                                   | Rotação e recuperação                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Secret do deployment | Código Node autorizado e administradores do deployment têm acesso à chave; exige restringir ambos                                   | Sem serviço externo adicional; operador fornece chaves em instalação própria                 | Versões explícitas e reempacotamento da chave de dados; custódia separada para recuperar versões retidas            |
| KMS externo          | Políticas de identidade e auditoria do provedor separam administração e uso; código autorizado ainda pode solicitar descriptografia | Serviço, chamadas e credenciais adicionais; instalação própria depende do provedor escolhido | Rotação gerenciada não reescreve os blobs; recuperação depende da disponibilidade e das permissões da chave externa |

Escolhemos secret do deployment nesta entrega para manter a instalação
reproduzível sem adicionar um provedor. KMS pode substituir a proteção da
chave de dados em outra versão do envelope. A separação não protege de código
malicioso com acesso ao deployment: controle de deploy e acesso administrativo
continuam parte da proteção. Não se promete apagar strings da memória do V8;
buffers controlados são zerados em `finally` e segredos não são retornados,
incluídos em logs nem gravados em argumentos de tarefas agendadas.

Versão do certificado identifica a credencial fiscal e invalida trabalho
antigo após substituição. Versão da chave mestra identifica a proteção do
envelope; reempacotar a chave de dados não altera a identidade fiscal. O banco
guarda apenas envelopes e metadados. A UI lê somente metadados autorizados.
Descriptografia acontece nas actions Node de validação e transporte, nunca
em queries de leitura nem no navegador.

O upload não prova acesso fiscal. Validação verifica o PFX, correspondência
da chave privada, prazo, uso para autenticação e CNPJ do titular no OID
ICP-Brasil `2.16.76.1.3.3`. O recorte inicial exige CNPJ completo igual ao da
empresa; procurações e compartilhamento entre filiais exigem política própria.
Revogação nesta entrega é a desativação no serviço. Sem uma consulta de
revogação à autoridade, o painel não deve afirmar que o certificado está
regular perante a ICP-Brasil. Operação fiscal real continua na validação fiscal real e captura NF-e.

Recuperação na restauração precisa do envelope, contexto original e versões da chave
mestra mantidas em custódia separada do snapshot. Apagar a última cópia de uma
chave antes de expirar os backups torna aqueles certificados irrecuperáveis.
Exportação comum de documentos nunca contém PFX, senha ou chaves.

Fontes consultadas para esta decisão:

- [Envelope encryption no AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html).
- [Efeito da rotação no AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html).
- [Atribuição de OIDs ICP-Brasil, DOC-ICP-04.01](https://www.gov.br/iti/pt-br/central-de-conteudo/doc-icp-04-01-v-3-4-atribuicao-de-oid-na-icp-brasil-pdf).
- [HTTPS e material de cliente no Node](https://nodejs.org/api/https.html).
