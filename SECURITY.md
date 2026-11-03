# Segurança

Não há política de suporte ou prazo de correção prometido para versões
públicas. Consulte a cobertura e as limitações em
[docs/README.md](docs/README.md).

Relate suspeitas de vulnerabilidade em privado, por um destes canais:

- **GitHub:** na aba Security do repositório, "Report a vulnerability". O
  relato fica visível só para quem relatou e para os mantenedores.
- **E-mail:** `seguranca@nfe.freecorps.com.br`.

Issues, PRs e discussões são públicos; use-os só depois que a correção e a
divulgação forem combinadas. A primeira resposta sai em até 5 dias úteis.
Envie revisão afetada, reprodução mínima com dados inventados, impacto e
resultado esperado e observado. Não envie API keys, PFX, senhas, CSC, XML de
clientes, dumps ou URLs assinadas. Não teste acesso a dados de terceiros. O
mantenedor combina a correção e a divulgação com quem relatou.

Num repositório público, um segredo que chegou a um push está exposto desde
aquele momento. Removê-lo em um novo commit não o revoga: o responsável
rotaciona a credencial na origem e registra a troca. Fixtures sintéticas
devem ter origem explícita e continuar excluídas dos artefatos
distribuíveis.
