import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { requirePlatformEnvironment } from "./environment";
import { accountSenderName, createAccountMailProvider } from "./lib/accountMail";
import {
  accountInitiationRoutes,
  accountRequestAccepted,
  localSessionRoute,
  prepareAuthRequest,
} from "./lib/authRequest";
import { authProxyHeaders } from "../auth-transport";

export const authComponent = createClient<DataModel>(components.betterAuth);

// Successful authenticated reads through the signed proxy count as application access.
const accessRoutes = new Set(["/sign-in/email", "/get-session", "/convex/token"]);
async function accessUser(path: string, response: Response): Promise<unknown> {
  const body = await response.clone().json();
  if (path !== "/convex/token") return body?.user?.id;
  const payload = String(body?.token ?? "").split(".")[1] ?? "";
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))).sub;
}

export function createAuth(ctx: GenericCtx<DataModel>, provision = false) {
  const { local, accounts } = requirePlatformEnvironment();
  // registerRoutesLazy creates this instance for one HTTP request. Better Auth
  // awaits mail but swallows callback errors; retain a safe outcome for the wrapper.
  const delivery = { failure: false };
  const siteUrl = process.env.SITE_URL!;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Missing validation auth secret");
  const auth = betterAuth({
    appName: accountSenderName(),
    baseURL: process.env.CONVEX_SITE_URL,
    secret,
    trustedOrigins: [siteUrl],
    hooks: {
      before: createAuthMiddleware(async ({ request, body, query }) => {
        for (const values of [body, query]) {
          for (const field of [
            "callbackURL",
            "redirectTo",
            "errorCallbackURL",
            "newUserCallbackURL",
          ]) {
            const value = values?.[field];
            if (value === undefined) continue;
            let allowed = false;
            try {
              allowed = typeof value === "string" && new URL(value, siteUrl).origin === siteUrl;
            } catch {
              /* Refuse malformed redirects. */
            }
            if (!allowed)
              throw new APIError("FORBIDDEN", {
                code: "INVALID_REDIRECT",
                message: "Invalid redirect",
              });
          }
        }
        if (
          request &&
          !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
          request.headers.get("origin") !== siteUrl
        ) {
          throw new APIError("FORBIDDEN", { code: "INVALID_ORIGIN", message: "Invalid origin" });
        }
      }),
    },
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !accounts.enabled && !provision,
      requireEmailVerification: !provision,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      minPasswordLength: 16,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: local,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        // prepareAuthRequest already consumes the atomic fixed-window budget.
        // Keep Better Auth's rules for every other route and method.
        "/get-session": (request, rule) => (localSessionRoute(request) ? false : rule),
        "/convex/token": (request, rule) => (localSessionRoute(request) ? false : rule),
        "/convex/jwks": (request, rule) => (localSessionRoute(request) ? false : rule),
        "/sign-in/email": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
        "/change-email": { window: 60, max: 5 },
      },
    },
    disabledPaths: [
      "/sign-in/email-otp",
      "/email-otp/check-verification-otp",
      "/send-verification-email",
      "/request-password-reset",
      "/reset-password",
      "/verify-email",
      "/email-otp/request-email-change",
      "/email-otp/change-email",
      // Name and e-mail change through `account.ts`, which also rewrites the memberships.
      "/update-user",
    ],
    advanced: {
      useSecureCookies: !local,
      ipAddress: { ipAddressHeaders: local ? [] : [authProxyHeaders.ip] },
    },
    plugins: [
      ...(accounts.enabled && !provision
        ? [
            emailOTP({
              otpLength: 8,
              expiresIn: 600,
              allowedAttempts: 3,
              storeOTP: "hashed",
              disableSignUp: true,
              overrideDefaultEmailVerification: true,
              sendVerificationOnSignUp: true,
              async sendVerificationOTP({ email, otp, type }) {
                if (type !== "email-verification" && type !== "forget-password")
                  throw new Error("Unsupported account mail purpose");
                if (!("runMutation" in ctx))
                  throw new Error("Account mail requires a write context");
                try {
                  const provider = createAccountMailProvider(
                    local
                      ? {
                          provider: "local",
                          capture: (message) => ctx.runMutation(internal.mail.capture, message),
                        }
                      : {
                          provider: "mail",
                          apiUrl: accounts.apiUrl,
                          apiKey: accounts.apiKey,
                          from: accounts.from,
                          allowedRecipients: accounts.allowedRecipients,
                        },
                  );
                  await provider.send({ email, otp, type });
                } catch {
                  delivery.failure = true;
                }
              },
            }),
          ]
        : []),
      crossDomain({ siteUrl }),
      // Every console function rechecks the session in the database (`sessionUser`), so logout and
      // revocation deny at once. A query does not read the clock (#43): past `expiresAt` it
      // still answers until this token ends, since a new one is only issued for a live session.
      // Each renewal reruns every subscription of the tab under a new identity.
      convex({ authConfig, jwt: { expirationSeconds: 15 * 60 } }),
    ],
  });
  return {
    ...auth,
    handler: async (request: Request) => {
      const prepared = await prepareAuthRequest(ctx, request);
      if (prepared instanceof Response) return prepared;
      const response = await auth.handler(prepared);
      const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
      // The proxy header is only present after signature verification in prepareAuthRequest.
      const ip = local ? null : prepared.headers.get(authProxyHeaders.ip);
      if (ip && response.ok && accessRoutes.has(path) && "runMutation" in ctx) {
        try {
          const userId = await accessUser(path, response);
          if (typeof userId === "string")
            await ctx.runMutation(internal.accessRecords.record, { userId, ip });
        } catch {
          console.warn("ACCESS_RECORD_UNAVAILABLE");
        }
      }
      if (!local && request.method === "POST" && accountInitiationRoutes.has(path)) {
        // 202 acknowledges the request only, not account creation or email delivery.
        // Provider diagnostics stay server-side to avoid a known/unknown-account oracle.
        if (delivery.failure || response.status >= 500) console.warn("ACCOUNT_EMAIL_UNAVAILABLE");
        return accountRequestAccepted();
      }
      if (
        !local &&
        ["/email-otp/verify-email", "/email-otp/reset-password"].includes(path) &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      )
        return Response.json({ code: "INVALID_CODE" }, { status: 400 });
      if (delivery.failure)
        return Response.json(
          {
            code: "ACCOUNT_EMAIL_UNAVAILABLE",
            message: "Request a new code later",
          },
          {
            status: 503,
            headers: {
              "Cache-Control": "no-store",
            },
          },
        );
      return response;
    },
  };
}
