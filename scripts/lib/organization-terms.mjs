/**
 * O aceite que `organizations:create` exige quando há termos de uso vigentes
 * (sem ele, TERMS_OF_USE_OUTDATED): a versão de `termsOfUse:current`, como o
 * formulário do console envia. `query(path, args)` consulta como a conta que
 * cria a organização. Sem termos vigentes, nada é enviado.
 * @param {(path: string, args: Record<string, never>) => Promise<{ version: string } | null>} query
 */
export async function termsAcceptance(query) {
  const terms = await query("termsOfUse:current", {});
  return terms ? { termsOfUse: terms.version } : {};
}
