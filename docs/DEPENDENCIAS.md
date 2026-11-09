# Dependências

## Versões nos manifests

Toda dependência externa direta dos `package.json` da raiz, de `apps/*`, de
`platform` e de `packages/*` declara a versão exata que o `bun.lock` resolve,
sem `^` nem `~`, salvo exceção registrada abaixo. A regra vale para
`dependencies`, `devDependencies` e `overrides`; `workspace:*` e aliases
`npm:` com versão exata seguem como estão.

Exata sem exceção:

- criptografia e assinatura: `xml-crypto`, `node-forge`;
- parsing e geração fiscal: `fast-xml-parser`, `libxml2-wasm`,
  `@xmldom/xmldom`, `pdf-lib`;
- `convex` e os componentes `@convex-dev/*`.

Nesses pacotes, um minor novo pode mudar assinatura, canonicalização,
validação de XML, DANFE, DANFSe ou o runtime do backend. Ele entra por uma
mudança própria, com lockfile, patches e inventário revisados juntos,
conforme a skill `dependency-maintenance`.

Nas demais dependências, `~` ou `^` só entram com justificativa escrita
nesta seção, ao lado do nome do pacote: o que a faixa resolve e por que a
versão exata não serve. Hoje não há exceção.

Ao adicionar uma dependência, salve a versão exata:

```sh
bunx vp add --save-exact <pacote>
```

Ao atualizar, edite a versão no manifest e rode `bunx vp install`; confira
no diff do `bun.lock` que só mudaram os pacotes pretendidos. O Dependabot
abre PRs apenas de GitHub Actions; atualização de npm não passa por ele.

## Patches e componentes modificados

Dois pacotes rodam com patch, aplicado pelo `patchedDependencies` da raiz:
`@convex-dev/better-auth` e `convex-test`.
[patches/README.md](../patches/README.md) registra o motivo de cada um, a
prova antes de retirá-lo e a próxima revisão. Um patch amarra o pacote à
versão exata do manifest; subir essa versão exige portar o patch ou
retirá-lo com equivalente comprovado.

O rate-limiter da plataforma não é patch: é o pacote do workspace
[packages/convex-rate-limiter](../packages/convex-rate-limiter/README.md),
derivado do `@convex-dev/rate-limiter` 0.3.2, com código, testes e versão
próprios. As decisões de 09/11/2026 sobre cada patch estão na #142.

## Correções de segurança

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
