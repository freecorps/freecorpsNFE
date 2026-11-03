import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { Organization } from "./organizations";
import { Page, PageHeader } from "./ui/layout";

/** Pages of an organization, as the shell's menu marks them. */
export type OrganizationView =
  | "overview"
  | "settings"
  | "companies"
  | "onboarding"
  | "developer"
  | "imports"
  | "danfe"
  | "documents"
  | "issuances"
  | "references"
  | "usage"
  | "exports"
  | "operations";
/**
 * The route marks its page in `staticData` (`view()` in `routes.tsx`), read by `OrganizationLayout`.
 * Declared here, next to the type and imported by that reader, so every program that checks the
 * reader sees the field, even without the route tree (the landing and the public-site tests reach
 * `organizations.tsx` through `console-task.ts`).
 */
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    organizationView?: OrganizationView;
  }
}

/**
 * The organization the server authorized for the open address, handed by the organization layout
 * (`OrganizationContext`) to the page below it. `contextKey` is the query key of this entry plus
 * the membership version: it changes when the context is entered again, never because the page
 * or its parameters changed.
 */
export type OrganizationScope = { org: Organization; contextKey: string };
const ScopeContext = createContext<OrganizationScope | null>(null);
export const OrganizationScopeProvider = ScopeContext.Provider;
export function useOrganizationScope() {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error("Página de organização fora do contexto da organização");
  return scope;
}

/**
 * The scope the organization layout is showing right now, for the route loaders that ask for a
 * page's first queries ahead (`convex.prewarmQuery`) while its code arrives. Only memory, only
 * while the layout shows that entry: leaving, switching organization, a changed membership or a
 * disconnect clears it, and a loader of another address finds nothing. It is a selector for
 * query arguments, not proof of access: every query checks the member again on the server.
 */
let shownScope: OrganizationScope | null = null;
export function useShownOrganizationScope(scope: OrganizationScope | null) {
  useEffect(() => {
    if (!scope) return;
    shownScope = scope;
    return () => {
      if (shownScope === scope) shownScope = null;
    };
  }, [scope]);
}
/** The shown scope when it belongs to the address `slug`; `null` otherwise. */
export function shownOrganizationScope(slug: string | undefined) {
  return shownScope && shownScope.org.slug === slug ? shownScope : null;
}

/** A page that cannot open here: why, and where to go. */
export function Unavailable({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Page>
      <div role="alert">
        <PageHeader title={title} description={description} actions={action} />
      </div>
    </Page>
  );
}
