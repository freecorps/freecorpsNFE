import { Component, type ReactNode } from "react";
import { ConvexError } from "convex/values";
import { Button, buttonClass } from "./ui/button";
import { Page, PageHeader } from "./ui/layout";

/**
 * Codes with which the server says the session or the access is no longer valid
 * (`requireUser`/`requireMembership` in `platform/convex/lib/organizationAccess.ts` and
 * `access.ts`). Only these send the person to check the session again; any other failure of a
 * page (a record that is gone, a lost connection, a chunk that did not load) stays in the
 * console with a retry.
 */
const accessCodes = new Set(["UNAUTHENTICATED", "EMAIL_UNVERIFIED", "ACCESS_DENIED"]);
export function isAccessFailure(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  return (
    !!data &&
    typeof data === "object" &&
    "code" in data &&
    typeof data.code === "string" &&
    accessCodes.has(data.code)
  );
}

/** A screen that could not open, with what to do next. One heading, announced on arrival. */
export function Notice({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Page>
      <div role="alert">
        <PageHeader eyebrow={eyebrow} title={title} description={children} actions={action} />
      </div>
    </Page>
  );
}

/** What a failed page shows: the access check, or an in-place retry. */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  if (data && typeof data === "object" && "code" in data && data.code === "ORGANIZATION_ARCHIVED")
    return (
      <Notice
        title="Organização em arquivo econômico"
        action={<Button onClick={onRetry}>Verificar acesso</Button>}
      >
        Os dados fiscais e as novas operações desta organização ficam indisponíveis até a
        reativação, que não é imediata. O aviso no alto da página diz desde quando e o que fazer.
      </Notice>
    );
  if (isAccessFailure(error))
    return (
      <Notice
        title="Não foi possível confirmar o acesso"
        action={
          <a className={buttonClass()} href="/login">
            Verificar sessão novamente
          </a>
        }
      >
        A sessão pode ter expirado ou sua permissão foi alterada.
      </Notice>
    );
  return (
    <Notice
      title="Não foi possível carregar esta página."
      action={<Button onClick={onRetry}>Tentar de novo</Button>}
    >
      Confira sua conexão e tente de novo. Você continua no console e nada foi alterado.
    </Notice>
  );
}

/**
 * Error boundary of the console: a failed read shows `fallback` (by default, the page notice)
 * instead of taking down what is around it. It forgets the failure when `resetKey` changes
 * (another address, session, query or record) or when the fallback calls `reset`, without
 * remounting what it wraps while nothing failed.
 */
export class ErrorBoundary extends Component<
  {
    resetKey?: string;
    children: ReactNode;
    fallback?: ReactNode | ((error: unknown, reset: () => void) => ReactNode);
  },
  { failed: boolean; error: unknown; resetKey?: string }
> {
  override state = { failed: false, error: null as unknown, resetKey: this.props.resetKey };
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { failed: boolean; resetKey?: string },
  ) {
    if (props.resetKey === state.resetKey) return null;
    return { failed: false, error: null, resetKey: props.resetKey };
  }
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  reset = () => this.setState({ failed: false, error: null });
  override render() {
    if (!this.state.failed) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback(this.state.error, this.reset);
    return fallback === undefined ? (
      <ErrorNotice error={this.state.error} onRetry={this.reset} />
    ) : (
      fallback
    );
  }
}
