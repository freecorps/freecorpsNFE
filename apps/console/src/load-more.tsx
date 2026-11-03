import { Button } from "./ui/button";

/**
 * "Carregar mais" de uma assinatura paginada (`usePaginatedQuery`). É um botão comum, então não
 * envia o formulário em que estiver; some quando não há mais páginas.
 */
export function More({ status, loadMore }: { status: string; loadMore: (n: number) => void }) {
  return status === "CanLoadMore" || status === "LoadingMore" ? (
    <Button
      size="sm"
      loading={status === "LoadingMore"}
      loadingLabel="Carregando…"
      onClick={() => loadMore(20)}
    >
      Carregar mais
    </Button>
  ) : null;
}
