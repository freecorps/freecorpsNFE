/**
 * Quebra de linha do DANFSe, separada de `danfse.ts` para os testes contarem as medidas sem
 * passar pela entrada pública `@freecorps/fiscal-nfse/danfse`.
 */

/**
 * Quebra `text` em linhas de até `maxWidth`; palavra maior que a linha vira pedaços tão longos
 * quanto couberem, ao menos um caractere.
 *
 * `measure` dá a largura em unidades da fonte (corpo 1000), com o kerning entre pares, como o
 * `widthOfTextAtSize` do pdf-lib; `scale` leva ao corpo desenhado. As unidades são inteiras e
 * somam sem erro, então somar pedaços dá a mesma largura que medir o texto inteiro, e as linhas
 * são as mesmas de medir cada candidata. O custo é linear: cada palavra é medida uma vez; a
 * junção com a anterior mede "x y" e, sozinhas, as letras x e y; e a palavra cortada mede ainda
 * cada caractere sozinho e com o anterior. Os testes conferem que, na Helvetica do DANFSe, um
 * caractere sempre alarga o pedaço (o kerning nunca o encolhe): por isso o corte para na primeira
 * medida que passa.
 */
export function breakLines(
  text: string,
  maxWidth: number,
  scale: number,
  measure: (part: string) => number,
): string[] {
  const fits = (units: number) => units * scale <= maxWidth;
  const lines: string[] = [];
  let current = "";
  let currentUnits = 0;
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    let start = 0;
    let restUnits = measure(word);
    if (!fits(restUnits) && word.length > 1) {
      // alone[i]: o caractere i sozinho; step[i]: quanto ele acrescenta depois do i - 1 (largura
      // e kerning do par); sum[i]: soma de step[1..i]. Pedaço [s, e) = alone[s] + sum[e-1] - sum[s].
      const alone: number[] = [];
      const sum: number[] = [0];
      for (let i = 0; i < word.length; i++) {
        alone.push(measure(word[i]!));
        if (i > 0) sum.push(sum[i - 1]! + measure(word.slice(i - 1, i + 1)) - alone[i - 1]!);
      }
      const span = (s: number, e: number) => alone[s]! + sum[e - 1]! - sum[s]!;
      while (word.length - start > 1 && !fits(span(start, word.length))) {
        let cut = 1;
        while (cut < word.length - start - 1 && fits(span(start, start + cut + 1))) cut++;
        if (current) lines.push(current);
        lines.push(word.slice(start, start + cut));
        current = "";
        currentUnits = 0;
        start += cut;
      }
      restUnits = span(start, word.length);
    }
    const rest = start ? word.slice(start) : word;
    // Junção "a b": largura do espaço e kerning dele com a última letra e com a próxima.
    const joined = current
      ? currentUnits +
        measure(`${current.at(-1)} ${rest.at(0) ?? ""}`) -
        measure(current.at(-1)!) -
        measure(rest.at(0) ?? "") +
        restUnits
      : restUnits;
    if (fits(joined)) {
      current = current ? `${current} ${rest}` : rest;
      currentUnits = joined;
    } else {
      if (current) lines.push(current);
      current = rest;
      currentUnits = restUnits;
    }
  }
  if (current) lines.push(current);
  return lines;
}
