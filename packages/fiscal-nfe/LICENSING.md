# Licenças do artefato fiscal-nfe

O código próprio usa a Licença de Código Disponível Freecorps 1.0, em `LICENSE`.
Titular: FREECORPS TECNOLOGIA DA INFORMACAO LTDA, CNPJ 63.113.119/0001-90.
A dependência fiscal-core tem a mesma licença própria. Dependências externas
mantêm suas licenças, preservadas em `THIRD_PARTY_NOTICES.txt`.

## Schemas oficiais

O artefato incorpora em `dist/schemas.json` os XSDs da NF-e publicados no
Portal Nacional da NF-e (https://www.nfe.fazenda.gov.br), elaborados pelo
ENCAT, pelas Secretarias de Fazenda e pela Receita Federal. Origem, versões,
hashes e conversões estão em `schemas/manifest.json`. O portal não declara
licença para esses arquivos. Em 20/10/2026 o mantenedor decidiu
redistribuí-los como especificação técnica oficial, de uso obrigatório pelos
emissores, sem alterar seu conteúdo. A licença do código próprio não os
relicencia. O catálogo só converte cada arquivo para UTF-8 sem BOM.

Em 26/10/2026 entraram os esquemas dos eventos da NT 2025.002 v1.40 (Reforma
Tributária, publicados em 27/07/2026), e o envelope de eventos passou a vir do
PL 010d_v1.03 (10/07/2026), na mesma condição. O pacote dos eventos publica
`e112120_v1.00 .xsd`, com um espaço antes da extensão; o arquivo é gravado como
`e112120_v1.00.xsd`, sem mudança no conteúdo, e o manifesto guarda o nome
publicado. A decisão sobre cada pacote do portal está em
`docs/plataforma/NFE-SCHEMAS.md`.

### XMLDSig

`xmldsig-core-schema_v1.01.xsd`, repetido em cada pacote de liberação, é uma
versão do "XML Schema for XML Signatures" do W3C
(http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd),
adaptada pelo Projeto NF-e para certificados X.509 ICP-Brasil e distribuída
pelo portal sem o aviso original. As alterações são do Projeto NF-e, em data
não informada; a Freecorps só converteu a codificação, em 12/09/2026.
Aplica-se o aviso:

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

Publicado no npm em 0.1.0, aceito pelo mantenedor em 01/11/2026 por versão e hash do tarball.
O aceite inclui o de fiscal-core, publicado na mesma versão. Corpus interno,
XMLs reais e certificados não fazem parte do tarball. A prova técnica não
certifica autorização fiscal, origem confiável ou consulta à SEFAZ.
