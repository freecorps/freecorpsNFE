import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { createAuth } from "./auth";
import { roleValidator } from "./access";

export const createTestAccount = internalAction({
  args: {
    email: v.string(),
    name: v.string(),
    password: v.string(),
    role: v.union(roleValidator, v.literal("none")),
  },
  returns: v.object({ created: v.literal(true) }),
  handler: async (ctx, args) => {
    if (!/^[a-z0-9.-]+@validation\.invalid$/.test(args.email))
      throw new Error("Synthetic validation email required");
    if (args.name.length > 80) throw new Error("Name is too long");
    const auth = createAuth(ctx, true);
    const result = await auth.api.signUpEmail({
      body: { email: args.email, name: args.name, password: args.password },
    });
    await ctx.runAction(internal.provision.verifySyntheticAccount, { email: args.email });
    if (args.role !== "none")
      await ctx.runMutation(internal.access.grant, { authUserId: result.user.id, role: args.role });
    return { created: true as const };
  },
});

/** Only reserved, operator-created fixtures; never verifies a real mailbox. */
export const verifySyntheticAccount = internalAction({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, { email }) => {
    createAuth(ctx, true); // Fixed environment and auth configuration guards.
    if (!/^[a-z0-9.-]+@validation\.invalid$/.test(email))
      throw new Error("Synthetic validation email required");
    const result = await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "email", value: email }],
        update: { emailVerified: true },
      },
    });
    if (!result) throw new Error("Synthetic account not found");
    return null;
  },
});
