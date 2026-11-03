# Licenças dos contratos

O código próprio usa a Licença de Código Disponível Freecorps 1.0 em `LICENSE`,
exceto os quatro arquivos de integração a seguir, licenciados em MIT pelo
texto de `LICENSE-MIT`:

- `src/external.ts`
- `src/references.ts`
- `src/registry.ts`
- `src/webhooks.ts`

Esses arquivos e seus tipos podem ser incorporados ao cliente SDK MIT e usados
sob MIT, inclusive comercialmente. Os demais arquivos não recebem essa exceção.
No pacote, esses quatro arquivos são `dist/external`, `dist/references`,
`dist/registry` e `dist/webhooks`, `.js` e `.d.ts`, com o cabeçalho MIT.
Zod mantém MIT; seus avisos acompanham o pacote em `THIRD_PARTY_NOTICES.txt`.
`@freecorps/fiscal-core` é dependência própria, sob a licença do seu pacote.

O pacote 0.1.0 continua privado até a comprovação da cadeia de direitos e o
aceite de release. A decisão de 28/10/2026 o inclui entre os pacotes que vão ao
npm na release. Titular: FREECORPS TECNOLOGIA DA INFORMACAO LTDA, CNPJ 63.113.119/0001-90.
