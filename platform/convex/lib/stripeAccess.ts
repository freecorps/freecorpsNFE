import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { deny } from "./organizationAccess";
import { projectAccess } from "./operationAccess";

type Scope = Pick<
  Doc<"operations">,
  "organizationId" | "projectId" | "companyId" | "environment"
> & {
  task: Pick<Doc<"operations">["task"], "scope"> &
    Partial<Pick<Doc<"operations">["task"], "name" | "workload">>;
};

/**
 * A Stripe connection acting as the source of an operation (ADR 0006). Like an API key, it acts
 * only for its own project, company and environment, under the project's active grant with the
 * task's scope, and only with the epochs it was saved under: a revoked grant or project stops
 * it, and a new grant does not resurrect it. Anything else is NOT_FOUND.
 */
export async function connectionAccess(
  ctx: QueryCtx,
  connectionId: Id<"stripeConnections">,
  op: Scope,
) {
  const connection = await ctx.db.get("stripeConnections", connectionId);
  if (
    !connection ||
    !connection.active ||
    connection.organizationId !== op.organizationId ||
    connection.projectId !== op.projectId ||
    connection.companyId !== op.companyId ||
    connection.environment !== op.environment
  )
    return deny("NOT_FOUND");
  const { project, grant } = await projectAccess(ctx, op);
  if (
    project.accessEpoch !== connection.projectEpoch ||
    grant.accessEpoch !== connection.grantEpoch
  )
    return deny("NOT_FOUND");
  return connection;
}
