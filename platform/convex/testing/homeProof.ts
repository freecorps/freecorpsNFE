import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { requireLocalProof } from "./operationProof";

const DAY = 86_400_000;

/**
 * Local synthetic month for the Início captures (docs/v1.0/evidence/console-fluxo-shell): a
 * declared company with an A1 certificate close to expiring and no NFS-e profile, issuances
 * (authorized, rejected, one in reconciliation), received documents and a failed import, all
 * owned by the organization's console project. Never runs outside the local deployment.
 */
export const seed = internalMutation({
  args: { slug: v.string() },
  returns: v.object({ companyId: v.id("companies") }),
  handler: async (ctx, { slug }) => {
    requireLocalProof();
    const now = Date.now();
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!organization) throw new Error("Unknown organization");
    const organizationId = organization._id;
    const owner = await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", organizationId).eq("state", "active"),
      )
      .first();
    if (!owner) throw new Error("Organization without members");
    const companyId = await ctx.db.insert("companies", {
      organizationId,
      cnpj: "11222333000181",
      name: "Ipê Serviços Digitais",
      address: {
        street: "Rua Sintética",
        number: "100",
        complement: "",
        district: "Centro",
        city: "Campinas",
        state: "SP",
        postalCode: "13010000",
      },
      kind: "declared",
      declaredBy: "synthetic",
      declaredAt: now,
      fieldSources: { name: "declared", address: "declared" },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const consoleProject =
      (
        await ctx.db
          .query("projects")
          .withIndex("by_organizationId_and_kind", (q) =>
            q.eq("organizationId", organizationId).eq("kind", "console"),
          )
          .first()
      )?._id ??
      (await ctx.db.insert("projects", {
        organizationId,
        name: "Console",
        externalReference: "",
        kind: "console",
        state: "active",
        version: 1,
        accessEpoch: 0,
        creatorMembershipId: owner._id,
        creatorEpoch: 0,
        createdAt: now,
      }));
    const scope = {
      organizationId,
      projectId: consoleProject,
      companyId,
      environment: "sandbox" as const,
    };
    const operation = (
      state: "succeeded" | "reconciling" | "failed",
      workload: "issuance" | "import",
    ) =>
      ctx.db.insert("operations", {
        ...scope,
        task: {
          name: workload === "issuance" ? "proof.issue" : "proof.import",
          workload,
          scope: workload === "issuance" ? "documents:issue" : "documents:import",
          executor: "synthetic",
        },
        request: "{}",
        requestHash: "synthetic",
        projectEpoch: 0,
        grantEpoch: 0,
        state,
        stage: "ready",
        generation: 1,
        fence: 0,
        attempts: 1,
        maxAttempts: 3,
        leaseUntil: 0,
        nextAttemptAt: 0,
        backoffMs: 0,
        jitterMs: 0,
        uncertain: false,
        code: state === "failed" ? "PROOF_FAILED" : undefined,
        createdAt: now,
        updatedAt: now,
      });
    let number = 0;
    for (const [state, age, operationState] of [
      ["authorized", 1, "succeeded"],
      ["authorized", 2, "succeeded"],
      ["authorized", 3, "succeeded"],
      ["rejected", 1, "succeeded"],
      ["processing", 0, "reconciling"],
    ] as const)
      await ctx.db.insert("issuances", {
        ...scope,
        operationId: await operation(operationState, "issuance"),
        state,
        transport: "simulated",
        target: "sefin-nacional",
        series: "1",
        number: ++number,
        dpsId: `DPS${String(number).padStart(42, "0")}`,
        snapshot: "{}",
        snapshotSha256: "synthetic",
        submissions: 1,
        ...(state === "rejected"
          ? { code: "E0316", rejections: [{ code: "E0316", message: "Rejeição sintética" }] }
          : {}),
        version: 1,
        createdAt: now - age * 3_600_000,
        updatedAt: now - age * 3_600_000,
      });
    for (const [index, age] of [1, 2, 4, 6].entries())
      await ctx.db.insert("fiscalDocuments", {
        organizationId,
        companyId,
        environment: "sandbox",
        model: "55",
        fiscalKey: `3526${String(index).padStart(40, "0")}`,
        listedAt: now - age * 3_600_000,
        completeness: 1,
        createdAt: now - age * 3_600_000,
      });
    const importId = await ctx.db.insert("imports", {
      ...scope,
      key: "proof-home",
      requestHash: "synthetic",
      createdAt: now - 3_600_000,
    });
    await ctx.db.insert("importFiles", {
      importId,
      position: 0,
      name: "nota-sintetica.xml",
      size: 10,
      sha256: "synthetic",
      state: "accepted",
      expiresAt: now + DAY,
      operationId: await operation("failed", "import"),
    });
    const certificateId = await ctx.db.insert("certificates", {
      organizationId,
      companyId,
      version: 1,
      state: "active",
      uploaderId: "synthetic",
      membershipId: owner._id,
      membershipVersion: owner.version,
      metadata: {
        fingerprint: "synthetic",
        subject: "Ipê Serviços Digitais",
        cnpj: "11222333000181",
        notBefore: now - 340 * DAY,
        notAfter: now + 12 * DAY,
      },
      envelopeRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("certificateHeads", {
      organizationId,
      companyId,
      nextVersion: 2,
      latestId: certificateId,
      activeId: certificateId,
    });
    return { companyId };
  },
});
