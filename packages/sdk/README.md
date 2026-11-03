# SDK Freecorps

Cliente TypeScript da API v1 da Freecorps NF-e, publicado no npm:

```sh
npm install @freecorps/sdk
```

```ts
import { FreecorpsClient } from "@freecorps/sdk";
const client = new FreecorpsClient({
  baseUrl: process.env.FREECORPS_BASE_URL!,
  apiKey: process.env.FREECORPS_API_KEY!,
  environment: "sandbox",
});
const companies = await client.call("listCompanies", {
  path: {},
  query: { limit: 20 },
  body: {},
});
```

No serviço hospedado, `baseUrl` é `https://api.nfe.freecorps.com.br`, sem `/v1`.

Requer Node 22 ou 24 com Fetch, AbortSignal e Web Crypto. O receptor SQLite de
referência requer Node 22.13+ ou 24. O subpath `@freecorps/sdk/webhooks` usa
somente Web Crypto; não importa Zod, Convex, React ou bibliotecas de login.
Outros runtimes não são declarados como testados.

`call` recebe o nome da operação da referência OpenAPI e seus parâmetros tipados.
O timeout padrão de 30 segundos cobre todas as tentativas. `timeoutMs` aceita
inteiros de 1 a 2.147.483.647 ms; valores fora dessa faixa são recusados antes
de qualquer chamada. São no máximo dois
retries, apenas em leituras JSON e operações classificadas como idempotentes. Escritas
idempotentes exigem `idempotencyKey`, preservada byte a byte nas tentativas.
429/502/503/504 e falha de transporte permitem retry; Retry-After é respeitado
até o prazo total, inclusive se o gateway não retornar JSON. Um erro JSON com
`retryable=false` impede retry automático. O erro exposto só anuncia `retryable`
quando a operação permite repetição segura. Upload, confirmação, controles de operação, cadastro/edição e
rotação de webhook não têm retry automático. `downloadOriginal` faz uma tentativa
de leitura binária. Inspecione o recurso após timeout.

O verificador recebe bytes originais, headers em minúsculas, segredo(s), `now`
e `toleranceMs` opcional. A tolerância padrão é de cinco minutos. A expiração
`validUntil` de cada segredo é conferida contra o timestamp e o relógio atual.
Falha criptográfica é diferente de evento duplicado ou versão antiga; o receptor
deve persistir esses controles junto do efeito de negócio.

Guia: https://nfe.freecorps.com.br/docs/sdk. Webhooks:
https://nfe.freecorps.com.br/docs/webhooks. Exemplo:
https://nfe.freecorps.com.br/developer/quickstart.ts. Não coloque API keys em código,
URLs ou bundles de navegador. O cliente e os contratos externos incorporados usam MIT. Consulte
[LICENSING.md](LICENSING.md).
