# Certificados da plataforma

O aceite técnico consolidado reúne as provas de
cofre, recuperação de chaves e mTLS controlado. Não equivale à prova fiscal
da #50, cujo aceite exige evidência da fonte no [roteiro fiscal autorizado](CAPTURE.md#execução-fiscal-manual-da-50).

Contrato da proteção de certificados, B06/F07. Decisão registrada antes da implementação na
[ADR 0003](../adr/0003-cofre-de-certificados-da-plataforma.md).
`platform/convex/certificates.ts` mantém o estado; `certificateWorker.ts`
recebe e valida o material no Node. O cofre legado permanece separado.

## Acesso e estados

Proprietários e administradores enviam, substituem, desativam e reempacotam
certificados de empresas declaradas. Metadados exigem acesso atual à empresa,
inclusive em assinaturas abertas. Demonstração não recebe credenciais. API
keys não administram o cofre; operações consumidoras usam suas concessões.

O console envia PFX/senha à action autenticada. Limites no servidor: 256 KiB
de PFX, 1024 bytes de senha e cinco reservas por minuto por organização.
Persistência contém apenas envelope cifrado e metadados; nenhuma URL de
storage expõe PFX. Tarefas agendadas recebem somente IDs. Arquivo/senha saem
do formulário ao enviar ou sair, sem localStorage/sessionStorage.

`uploading` passa a `validating` após cifrar. A action Node confere senha,
chave privada correspondente, prazo, uso de assinatura/autenticação de
cliente, RSA de pelo menos 2048 bits e CNPJ completo no OID `2.16.76.1.3.3`.
O valor desse `otherName` é aceito como `OCTET STRING` ou `PrintableString`,
os tipos do DOC-ICP-04, e também como `UTF8String` ou `IA5String`.
CN não prova identidade. Derivação no PFX é limitada a 100 mil iterações.
Validação offline não comprova cadeia ICP-Brasil nem consulta CRL/OCSP.
Ativação fiscal real continua na validação fiscal real e captura NF-e.

Uma validação aceita torna o certificado `active` e o anterior `replaced`.
Um envio inválido mantém o anterior ativo. Versões são crescentes; só o
envio mais recente pode ativar. Validação atrasada ou perda da permissão do
autor resulta em `rejected`. Após cinco minutos, envio incompleto é rejeitado
e seu envelope removido. Expiração materializa `expired`; desativação produz
`revoked`, remove o envelope e preserva metadados/auditoria. Envelopes
substituídos ficam retidos até desativação explícita. Backups anteriores
conservam cópias conforme a retenção operacional.

## Operações e transporte

Operações consumidoras passam `certificate: { id, version }` à reserva B05.
Claim, resposta, checkpoint, publicação e retry revalidam esse vínculo e as
permissões. `transportWithCertificate` verifica também antes e depois da
chamada. Expiração bloqueia uso mesmo antes do job agendado executar.
Revogação não varre operações: o executor pausa a operação ao encontrar o
impedimento. Chamadas externas iniciadas não são desfeitas; resultados antigos
não atualizam a geração corrente. Reconciliação fiscal pertence à captura NF-e.

O HTTPS recebe destino/CA do servidor, exige origem permitida, DNS público
fixado ao socket, identidade TLS do host, TLS 1.2 ou superior e certificado
de cliente. Não segue redirects. Limites padrão: headers de 16 KiB, resposta
de 1 MiB, duração total de 15 segundos incluindo DNS. Máximos configuráveis:
2 MiB e 30 segundos. Erros são sanitizados. Buffers controlados são zerados
em `finally`; strings/copias internas do V8/OpenSSL não têm apagamento garantido.

PFX com cifras antigas pode passar na validação e ser recusado pelo leitor
PKCS#12 nativo do OpenSSL 3. Para manter a mesma compatibilidade, o transporte
usa o parser limitado da validação para extrair chave e cadeia em memória,
confere o par e cria um contexto TLS nativo. Não habilita providers legados
nem desliga a validação do servidor. O cofre mantém os bytes originais;
buffers PEM temporários são zerados após criar o contexto. A prova em Node
cobre mTLS com PFX AES e RC2 sintéticos, inclusive os caminhos negados.

## Chaves, auditoria e recuperação

`FNFE_PLATFORM_CERT_KEYS` é um secret JSON com `active` e `keys`, mapa de
versões para chaves aleatórias de 32 bytes em hexadecimal. O worktree gera
material exclusivo. Formato 1 usa AES-256-GCM com nonce de 12 bytes e tag de
16 bytes: chave de dados aleatória por certificado/versão, protegida pela
mestra, mais PFX e senha cifrados separadamente. Todos os blocos autenticam
organização, empresa, ID, versão e finalidade; a chave protegida autentica
também a versão mestra. Contexto divergente e adulteração são recusados.

Para girar a mestra, adicionar uma versão ao secret, manter as anteriores e
mudar `active`. `certificateWorker.rewrap`, chamado por gestor autenticado,
reprotege a chave de dados sem abrir PFX/senha nem mudar a versão fiscal.
O commit verifica revisão esperada para não ressuscitar material revogado.
Substituir o certificado exige novo upload e invalida o vínculo antigo.

`certificateAudit` registra ator, organização/empresa, ação, resultado,
versão fiscal, versão mestra disponível e operação no transporte. Não contém
corpo remoto, PFX, senha ou material de chave.

O uso no transporte tem uma ação por finalidade: `transport` na captura NF-e,
sob a política `FNFE_FISCAL_PROOF`; `nfse-transport` na emissão NFS-e em
produção restrita; `nfse-production` na emissão NFS-e na produção fiscal;
`nfse-probe` na verificação de mTLS feita por operador.
As políticas não se cruzam e o orçamento da prova de captura só conta
`transport`. A política da emissão está em
[ISSUANCE.md](ISSUANCE.md#política-do-cofre-na-emissão).

Roteiro de recuperação:

1. Custodiar versões mestras separadamente dos snapshots, com acesso restrito.
2. Restaurar banco e contexto original em alvo descartável, com integrações,
   crons e operação fiscal desligados.
3. Repor todas as versões exigidas pelo snapshot antes de abrir envelopes.
4. Conferir bytes/fingerprint sintéticos; testar falta de chave, versão errada
   e contexto adulterado, sempre com falha explícita e sem segredo no erro.
5. Reempacotar sob nova mestra. Só retirar versões sem dependentes atuais
   **e sem backups retidos que ainda precisem delas**.

Exportação comum de documentos exclui certificados/chaves. A proteção de certificados prova
recuperação criptográfica; snapshot, relações, RPO/RTO e custódia pertencem ao [restore](../operacao/restauracao.md).

O [ensaio de restauração](../operacao/restauracao.md) usa banco e storage locais reais, duas
versões de mestra e custódia separada. As actions leem o conjunto por
`currentCertificateKeyring()` a cada operação: no runtime Node local, uma
referência de módulo ao objeto `env` gerado pode preservar valores anteriores
à rotação. O helper consulta o `process.env` atual sem alterar código gerado.

## Reprodução

```powershell
bun x vp test run tests/platform.certificateCrypto.test.ts tests/platform.certificates.test.ts
bun build scripts/fiscal/prove-certificate-transport.ts --target node --outfile .ci-results/77/local-tls.mjs
node .ci-results/77/local-tls.mjs
node --experimental-strip-types apps/console/e2e/certificates.mjs
```

`scripts/fiscal/prove-certificates-hosted.ts`, compilado para Node, usa um dev
isolado com expiração e endpoint sintético via [túnel TCP Pinggy por SSH](https://pinggy.io/docs/usages/),
sem terminar TLS no relay. Usa o OpenSSH instalado, sem credenciais pessoais.
Recusa produção/validação compartilhada, exige árvore
limpa, publica o SHA e desliga a origem da prova ao terminar. Descritor
`hosted-target.json`, deploy key `hosted.env`, arquivo `known_hosts` e
ambiente ficam em `.ci-results/77`, ignorada pelo Git. Não copiar a pasta
inteira para evidências. Matriz e recibos.
