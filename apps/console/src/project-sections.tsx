import { Link } from "@tanstack/react-router";
import type { Organization } from "./organizations";
import { Callout } from "./ui/layout";

/** Failure of an action, announced next to the form that caused it. */
export function Feedback({ error }: { error: string }) {
  return error ? (
    <Callout tone="danger" role="alert">
      {error}
    </Callout>
  ) : null;
}
export const projectSections = [
  ["projects", "Empresas e acesso"],
  ["keys", "Chaves de API"],
  ["webhooks", "Webhooks"],
  ["stripe", "Stripe"],
  ["quickstart", "Primeira chamada"],
] as const;
export type ProjectSection = (typeof projectSections)[number][0];
/** Link to another section of the same project, used by the in-page orientations. */
export function SectionLink({
  org,
  projectId,
  section,
  children,
}: {
  org: Organization;
  projectId: string;
  section: ProjectSection;
  children: string;
}) {
  return (
    <Link
      className="ui-link"
      to="/app/$organizationSlug/developer/$developerSection/$projectId"
      params={{ organizationSlug: org.slug, developerSection: section, projectId }}
    >
      {children}
    </Link>
  );
}
