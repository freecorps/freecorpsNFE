# Design do freecorpsNFE

Este arquivo descreve a estética do freecorpsNFE: o clima, as cores, o tipo, a
luz e o movimento. Ele vale para a landing, os guias, o console e qualquer peça
nova. A referência viva é a home (`apps/console/src/site/landing/`). Quando este
texto e a home divergirem, a home ganha e este arquivo é corrigido.

## A ideia

Nota fiscal no Brasil é ruído: 5.570 prefeituras, layouts que mudam, SEFAZ que
cai. O produto transforma esse ruído em uma linha reta. A estética conta a
mesma história: **uma sala escura de máquinas precisas, onde só o que está
funcionando acende.**

Três palavras guiam as escolhas:

- **Noturno.** Fundo escuro, profundo e levemente esverdeado, nunca preto puro.
- **Preciso.** Linhas finas, grade isométrica, números alinhados, mono onde há
  dado. Parece desenho técnico, não ilustração.
- **Aceso.** Um único acento, o fósforo, usado como luz. Ele marca o que está
  vivo: o botão principal, a nota autorizada, o passo ativo.

O que evitamos: gradiente roxo de SaaS genérico, glassmorphism, emoji,
ilustração fofa, sombras pesadas, muitas cores competindo, "IA" como estética.

## Cor

O verde da marca tinge todos os neutros. Mesmo o cinza do texto tem um pouco de
verde, e isso dá unidade sem que ninguém perceba.

| Papel            | Token         | Valor                       | Uso                                     |
| ---------------- | ------------- | --------------------------- | --------------------------------------- |
| Noite            | `--night`     | `#09100d`                   | Fundo da página                         |
| Noite 2          | `--night-2`   | `#0c1511`                   | Faixas alternadas, fundos de seção      |
| Superfície       | `--surface`   | `#0f1915`                   | Painéis e cards                         |
| Superfície 2     | `--surface-2` | `#14211b`                   | Hover, painel dentro de painel          |
| Linha            | `--line`      | `#22322a`                   | Bordas e divisórias                     |
| Linha forte      | `--line-2`    | `#3a4f44`                   | Bordas de controle, traço das figuras   |
| Texto            | `--text`      | `#e6eee8`                   | Títulos e texto principal               |
| Texto de apoio   | `--muted`     | `#98aa9f`                   | Parágrafos secundários sobre fundo liso |
| Apoio realçado   | `--muted-hi`  | `#c3d1c8`                   | Texto de apoio sobre textura ou shader  |
| Texto fraco      | `--faint`     | `#6e8277`                   | Legendas, rodapé, metadados             |
| Fósforo          | `--glow`      | `#d4f36e`                   | O acento. Só no que está vivo           |
| Fósforo alto     | `--glow-hi`   | `#efffbe`                   | O núcleo da luz, bordas de objeto aceso |
| Tinta no fósforo | `--glow-ink`  | `#0b130f`                   | Texto sobre fundo fósforo               |
| Fósforo diluído  | `--glow-dim`  | `rgba(212, 243, 110, 0.12)` | Halos, seleção, fundo de destaque       |

Regras:

- **Um acento só.** Não existe segunda cor de marca. Estados de erro e alerta
  usam o próprio texto e a forma (ícone, borda) antes de usar cor; quando a cor
  for indispensável, ela é discreta e nunca disputa com o fósforo.
- **Fósforo é luz, não decoração.** Se tudo acende, nada acende. Em cada tela,
  poucos elementos usam `--glow`.
- **Contraste vem primeiro.** Sobre textura, figura ou shader, o texto de apoio
  sobe para `--muted-hi` e ganha uma poça de noite atrás (veja o hero). Botão
  fantasma sobre fundo animado tem fundo próprio.
- A noite faz parte da identidade: a landing é só escura. O console deixa
  cada pessoa escolher Claro, Escuro ou Sistema (padrão), conforme o
  [sistema visual do console](docs/desenvolvimento/frontend.md#sistema-visual).

## Ícone de aba

O favicon usa o símbolo angular da Freecorps em verde-fósforo sobre fundo
noite, com cantos arredondados. A landing, o console e a documentação usam
os mesmos arquivos em `apps/console/public/`: `favicon.png` de 48 × 48 e
`favicon.ico` com versões de 16, 32 e 48 pixels. Preserve as três peças do
símbolo e os espaços entre elas ao preparar outros tamanhos.

## Tipo

- **Geist** para texto e títulos, **Geist Mono** para dados, código, chaves de
  acesso, rótulos técnicos e o "eyebrow" das seções. As duas fontes são servidas
  do próprio domínio (`apps/console/public/fonts/`, OFL), sem requisição externa.
- Títulos em peso 600, apertados: `letter-spacing` entre `-0.04em` e `-0.05em`,
  `line-height` perto de 1, `text-wrap: balance`. O h1 da home vai até 82px e o
  h2 até 56px, ambos com `clamp()`.
- Texto corrido em 16 a 20px, `line-height` 1.5 a 1.6, largura de 32 a 58
  caracteres.
- O eyebrow é mono, 13px, em fósforo: diz em poucas palavras de que trata a
  seção.
- Números falam alto. "5.570 prefeituras" é título, não nota de rodapé.

## Forma

| Elemento           | Forma                           |
| ------------------ | ------------------------------- |
| Botões e controles | Pílula (`border-radius: 999px`) |
| Painéis e cards    | 16px                            |
| Blocos de código   | 12px                            |
| Bordas             | 1px, `--line` ou `--line-2`     |

- Há um botão principal por tela: pílula fósforo com tinta escura. O resto é
  fantasma, com borda fina.
- Profundidade vem de bordas e camadas de noite, não de sombra. Sombra só como
  halo de luz em algo aceso.
- Grade de 44px ao fundo, quase invisível, onde a página quer parecer
  instrumento.

## Luz e textura

- **Brilho.** O que está aceso ganha um halo suave (`text-shadow` ou
  `box-shadow` com o fósforo a 35 a 55% de opacidade, raio largo). Nas figuras,
  filtros SVG `iso-glow`, `iso-soft` e `iso-bloom`, aplicados só em poucos
  elementos, nunca em itens repetidos.
- **Grão.** Uma película de grão fixa cobre a página a 6% de opacidade. Ela tira
  o ar digital liso sem custar repintura.
- **Campos.** Os fundos de seção são campos de pontos: caos à esquerda, ordem à
  direita, a mesma metáfora do produto. Com WebGPU eles são shaders vivos; sem
  ela, um quadro estático igual ao primeiro quadro do shader.

## Figuras

As ilustrações são objetos isométricos em traço fino, no vocabulário do
iso-glow (MIT, `LICENSES/iso-glow-MIT.txt`): caixas, esteiras, torres, prédios,
papéis. Cada figura é uma máquina que representa uma etapa real do produto.

- Faces em tons de noite (topo mais claro que frente e lateral), traço
  `--line-2` de 1px que não escala, detalhes em `#24342b`.
- A cor vem só de classes CSS, nunca de atributos no SVG.
- Apenas a parte que trabalha acende em fósforo: a nota autorizada, a luz da
  torre, o papel validado.
- Rótulos em Geist Mono minúsculo, com marcadores numerados em pílula fósforo.
- Cada figura precisa ser entendida sem legenda. Se não for, não está pronta.

## Movimento

- O movimento explica o produto: o papel entra, é validado, sai aceso. Nada se
  mexe só para chamar atenção.
- Anime apenas `transform`, `opacity` e cor. Curva padrão
  `cubic-bezier(0.23, 1, 0.32, 1)`; botões respondem em 160 a 200ms e se
  comprimem para `scale(0.97)` no clique.
- Animação de figura pausa fora da tela. Poucos grupos animam, não centenas de
  nós.
- Sem JavaScript ou com `prefers-reduced-motion`, tudo aparece no estado final,
  aceso.

## Voz

Português direto, frases curtas e concretas. Nomeie a coisa real (SEFAZ, XSD,
chave de acesso, webhook) em vez de adjetivos. Nada de travessão, de "solução
robusta" ou de entusiasmo vazio. Na landing e nos guias, só o que foi
demonstrado, com cobertura e limites (item 4 da seção 7 do plano da 1.0); o
que vem depois aparece marcado como "em construção" ou "previsto", sem números
nem prazos (decisão de 18/10/2026 em
[PUBLIC.md](docs/plataforma/PUBLIC.md)).

## Limites técnicos que moldam o design

- A CSP não permite estilo nem script inline: o visual vem de classes e folhas
  estáticas.
- Desempenho faz parte da estética. A página precisa rodar a 60 quadros por
  segundo em notebook comum e celular: sem `backdrop-filter` em elementos
  grandes, sem filtro em elementos repetidos, shaders só em desktop com WebGPU.
- Foco visível sempre: contorno fósforo de 2px com afastamento de 3px.
