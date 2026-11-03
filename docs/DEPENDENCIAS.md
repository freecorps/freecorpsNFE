# Dependências com correções de segurança

O projeto instala e audita com Bun 1.4.0, selecionado pelo Vite+:

```sh
bunx vp install --frozen-lockfile
bunx vp exec bun audit
```

Em 09/09/2026, Clerk React foi atualizado de 5.61.3 para 5.61.9, na mesma
versão principal, para corrigir
[GHSA-w24r-5266-9c3c](https://github.com/advisories/GHSA-w24r-5266-9c3c).
Clerk atendia somente ao backoffice legado, que usava allowlist de e-mail no
servidor e não os predicados combinados afetados pelo advisory. Com a
aposentadoria do backoffice na #345, `@clerk/clerk-react` deixou de ser
dependência direta; o lock ainda o registra como peer opcional do `convex`. A
plataforma usa Better Auth.

O override de sharp entrou quando Wrangler 4.130.0 trazia Miniflare
5.20260908.0-alpha, que fixava sharp 0.35.2; a versão 0.35.4 aplicava a
correção de
[GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
na mesma linha de patches. Hoje Wrangler 4.147.0 traz Miniflare
5.20261001.0-alpha, que fixa sharp 0.35.4, e `overrides.sharp = "0.35.5"`.
Sharp pertence ao tooling de desenvolvimento; a aplicação não oferece
processamento HEIF.

O CI executa `.github/scripts/check-tooling.mjs`, que resolve a dependência
pela cadeia Wrangler → Miniflare → sharp e transforma uma imagem pela
binding Images do simulador. Isso verifica a compatibilidade do override
no caminho que usa a biblioteca nativa, além do dry-run do Wrangler.
A condição de segurança já foi cumprida: o Miniflare atual fixa a versão
corrigida 0.35.4. O override fica porque removê-lo rebaixaria sharp para
0.35.4 sem ganho; retire-o na próxima atualização do Wrangler em que o
Miniflare resolver sharp 0.35.5 ou mais novo, repetindo esse teste e a
auditoria.

Os testes de integração Clerk e de autorização do backoffice saíram com ele
na #345.
