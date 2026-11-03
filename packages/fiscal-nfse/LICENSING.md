# Licenças do artefato fiscal-nfse

O código próprio usa a Licença de Código Disponível Freecorps 1.0, em `LICENSE`.
Titular: FREECORPS TECNOLOGIA DA INFORMACAO LTDA, CNPJ 63.113.119/0001-90.
A dependência fiscal-core tem a mesma licença própria. Dependências externas
mantêm suas licenças, preservadas em `THIRD_PARTY_NOTICES.txt`.

## Schemas oficiais

O artefato incorpora em `src/schemas.json` e, por ele, em `dist/schemas.json`
o pacote "Esquemas XSD v1.01-20260209" do Portal NFS-e, Receita Federal
(https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual),
e o pacote "NFSe – Esquemas XSD (Produção Restrita)" de 20/10/2026, da mesma
fonte (https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita).
Os originais ficam em `schemas/`, e `schemas/manifest.json` registra fonte,
data de obtenção e SHA-256 de cada arquivo. O rodapé do portal publica o
conteúdo do site sob Creative Commons Atribuição-SemDerivações 3.0 Não
Adaptada (https://creativecommons.org/licenses/by-nd/3.0/legalcode). Em
20/10/2026 o mantenedor decidiu redistribuir os arquivos sob essa licença (em
02/11/2026, também os do pacote da produção restrita),
com esta atribuição, sem alterar o conteúdo: `dist/schemas.json` traz os bytes
originais de cada arquivo, conferidos contra os hashes de `schemas/manifest.json`.
Só ao carregar, em memória, o validador remove o BOM de alguns arquivos e, em
`TSSerieDPS`, os caracteres `^` e `$`, que no regex de XSD são literais e
impediriam qualquer série válida. Nenhuma cópia ajustada é distribuída. A licença do
código próprio não relicencia os schemas.

`xmldsig-core-schema.xsd` conserva o aviso do W3C ("Copyright 2001 The
Internet Society and W3C"). Aplica-se o aviso:

```text
W3C SOFTWARE NOTICE AND LICENSE
https://www.w3.org/Consortium/Legal/copyright-software-19980720

Copyright (c) 1994-2002 World Wide Web Consortium, (Massachusetts Institute of
Technology, Institut National de Recherche en Informatique et en Automatique,
Keio University). All Rights Reserved. http://www.w3.org/Consortium/Legal/

This W3C work (including software, documents, or other related items) is
being provided by the copyright holders under the following license. By
obtaining, using and/or copying this work, you (the licensee) agree that you
have read, understood, and will comply with the following terms and
conditions:

Permission to use, copy, modify, and distribute this software and its
documentation, with or without modification, for any purpose and without fee
or royalty is hereby granted, provided that you include the following on ALL
copies of the software and documentation or portions thereof, including
modifications, that you make:

1. The full text of this NOTICE in a location viewable to users of the
   redistributed or derivative work.
2. Any pre-existing intellectual property disclaimers, notices, or terms and
   conditions. If none exist, a short notice of the following form (hypertext
   is preferred, text is permitted) should be used within the body of any
   redistributed or derivative code: "Copyright (c) [$date-of-software] World
   Wide Web Consortium, (Massachusetts Institute of Technology, Institut
   National de Recherche en Informatique et en Automatique, Keio University).
   All Rights Reserved. http://www.w3.org/Consortium/Legal/"
3. Notice of any changes or modifications to the W3C files, including the date
   changes were made. (We recommend you provide URIs to the location from
   which the code is derived.)

THIS SOFTWARE AND DOCUMENTATION IS PROVIDED "AS IS," AND COPYRIGHT HOLDERS
MAKE NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO, WARRANTIES OF MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR
PURPOSE OR THAT THE USE OF THE SOFTWARE OR DOCUMENTATION WILL NOT INFRINGE ANY
THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.

COPYRIGHT HOLDERS WILL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL OR
CONSEQUENTIAL DAMAGES ARISING OUT OF ANY USE OF THE SOFTWARE OR
DOCUMENTATION.

The name and trademarks of copyright holders may NOT be used in advertising or
publicity pertaining to the software without specific, written prior
permission. Title to copyright in this software and any associated
documentation will at all times remain with copyright holders.
```

O artefato não incorpora tabelas oficiais nem datasets. Os testes usam
somente dados e certificados sintéticos, fora do tarball.

Publicado no npm em 0.1.0, aceito pelo mantenedor em 01/11/2026 por versão e hash do tarball.
O aceite inclui o de fiscal-core, publicado na mesma versão. A prova técnica
não certifica autorização fiscal nem emissão aceita pelo fisco.
