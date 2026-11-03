/**
 * Política comum aos relatórios de domínio. Registre a falha da jornada antes
 * do diagnóstico e tente cada fechamento/gravação separadamente. Uma falha
 * secundária reprova o relatório, mas nunca substitui o primeiro erro, mesmo
 * quando JavaScript lança undefined. Não gerencia recursos nem repete etapas.
 */
export function createBrowserFinalization(report) {
  let failed = false;
  let primaryError;
  function fail(error) {
    if (!failed) primaryError = error;
    failed = true;
    report.result = "failed";
  }
  return {
    fail,
    async attempt(step) {
      try {
        return await step();
      } catch (error) {
        fail(error);
      }
    },
    throwIfFailed() {
      if (failed) throw primaryError;
    },
  };
}
