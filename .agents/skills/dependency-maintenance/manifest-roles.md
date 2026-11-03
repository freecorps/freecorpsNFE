# Papéis no manifest

Compare com o pacote mais próximo que tenha o mesmo formato de integração.
Justifique cada entrada adicionada ou movida:

- `dependencies`: código executado pelo consumidor precisa dessa dependência.
  O pacote empacotado deve fornecer uma instalação funcional.
- `peerDependencies`: o consumidor fornece uma cópia compartilhada compatível.
  A faixa declara suporte; uma entrada de desenvolvimento pode fornecer a
  versão usada nos testes locais.
- `devDependencies`: apenas build, teste, tipos ou geração do repositório
  precisam da entrada. Confira se declarações publicadas não deixam uma
  dependência necessária ausente no consumidor.
- `optionalDependencies`: a funcionalidade trata a ausência da dependência.
  Verifique os comportamentos com e sem ela.
- `peerDependenciesMeta` com peer opcional: a integração fornecida pelo
  consumidor é opcional e só é exigida quando selecionada.

Preserve as fronteiras de `packages/*` verificadas por
`scripts/check-package-boundaries.mjs`. A instalação na raiz não prova que
um pacote funciona num consumidor independente.
