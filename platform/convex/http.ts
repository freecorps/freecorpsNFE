import { httpRouter } from "convex/server";
import { receive as receivePrivacyMail, file as privacyMailFile } from "./privacyMailHttp";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requirePlatformEnvironment } from "./environment";
import { authComponent, createAuth } from "./auth";
import { buildSha } from "./buildInfo";
import { companyRoute } from "./rest";
import { route as operationRoute } from "./operationRest";
import { route as importRoute } from "./importRest";
import { route as issuanceRoute } from "./issuanceRest";
import { route as uploadRoute } from "./importUpload";
import { route as documentRoute } from "./documentRest";
import { route as documentDownloadRoute } from "./documentDownloads";
import { route as exportDownloadRoute } from "./exportDownloads";
import { route as exportRoute } from "./exportRest";
import { route as webhookRoute } from "./webhookRest";

import { route as capabilityRoute } from "./capabilityRest";
import { route as referenceRoute } from "./referenceRest";
import { route as registryRoute } from "./registryRest";
import { route as captureRoute } from "./captureRest";
import { route as stripeRoute } from "./stripeRest";
import { route as billingRoute } from "./billingRest";

const http = httpRouter();
http.route({ path: "/privacy-mail", method: "POST", handler: receivePrivacyMail });
http.route({ path: "/privacy-mail/maintenance", method: "POST", handler: receivePrivacyMail });
http.route({ pathPrefix: "/privacy-mail/file/", method: "GET", handler: privacyMailFile });
http.route({ path: "/v1/exports", method: "POST", handler: exportRoute });
http.route({ pathPrefix: "/v1/exports/", method: "GET", handler: exportRoute });
http.route({ pathPrefix: "/v1/exports/", method: "POST", handler: exportRoute });
http.route({ pathPrefix: "/v1/export-parts/", method: "POST", handler: exportRoute });
http.route({ path: "/v1/export-download", method: "GET", handler: exportDownloadRoute });
http.route({ path: "/v1/export-download", method: "OPTIONS", handler: exportDownloadRoute });
http.route({ path: "/v1/connections/nfe", method: "GET", handler: captureRoute });
http.route({ path: "/v1/connections/nfe", method: "POST", handler: captureRoute });
http.route({ pathPrefix: "/v1/registry/cnpj/", method: "GET", handler: registryRoute });
http.route({ pathPrefix: "/v1/registry/cnpj/", method: "POST", handler: registryRoute });
http.route({ pathPrefix: "/v1/references/", method: "GET", handler: referenceRoute });
http.route({ path: "/v1/capabilities", method: "GET", handler: capabilityRoute });
http.route({ path: "/v1/webhook-endpoints", method: "GET", handler: webhookRoute });
http.route({ path: "/v1/webhook-endpoints", method: "POST", handler: webhookRoute });
http.route({ pathPrefix: "/v1/webhook-endpoints/", method: "GET", handler: webhookRoute });
http.route({ pathPrefix: "/v1/webhook-endpoints/", method: "PATCH", handler: webhookRoute });
http.route({ pathPrefix: "/v1/webhook-endpoints/", method: "POST", handler: webhookRoute });
http.route({ path: "/v1/webhook-deliveries", method: "GET", handler: webhookRoute });
http.route({ pathPrefix: "/v1/webhook-deliveries/", method: "POST", handler: webhookRoute });
http.route({ path: "/v1/documents", method: "GET", handler: documentRoute });
http.route({ pathPrefix: "/v1/documents/", method: "GET", handler: documentRoute });
http.route({ pathPrefix: "/v1/documents/", method: "POST", handler: documentRoute });
http.route({ pathPrefix: "/v1/document-artifacts/", method: "GET", handler: documentRoute });
http.route({ path: "/v1/document-artifacts", method: "GET", handler: documentRoute });
http.route({ path: "/v1/document-download", method: "GET", handler: documentDownloadRoute });
http.route({ path: "/v1/document-download", method: "OPTIONS", handler: documentDownloadRoute });
http.route({ path: "/v1/issuances", method: "POST", handler: issuanceRoute });
http.route({ path: "/v1/issuances", method: "GET", handler: issuanceRoute });
http.route({ pathPrefix: "/v1/issuances/", method: "GET", handler: issuanceRoute });
http.route({ pathPrefix: "/v1/issuances/", method: "POST", handler: issuanceRoute });
http.route({ path: "/v1/imports", method: "POST", handler: importRoute });
http.route({ pathPrefix: "/v1/imports/", method: "POST", handler: importRoute });
http.route({ pathPrefix: "/v1/imports/", method: "GET", handler: importRoute });
http.route({ path: "/v1/import-upload", method: "POST", handler: uploadRoute });
http.route({ path: "/v1/import-upload", method: "OPTIONS", handler: uploadRoute });
http.route({ pathPrefix: "/v1/operations/", method: "GET", handler: operationRoute });
http.route({ pathPrefix: "/v1/operations/", method: "POST", handler: operationRoute });
http.route({ pathPrefix: "/v1/stripe/connections/", method: "POST", handler: stripeRoute });
http.route({ path: "/v1/billing/stripe/events", method: "POST", handler: billingRoute });
http.route({ path: "/v1/companies", method: "GET", handler: companyRoute });
http.route({ pathPrefix: "/v1/companies/", method: "GET", handler: companyRoute });
authComponent.registerRoutesLazy(http, createAuth, {
  // Resolve the single allowed origin at request time, including in local worktrees.
  trustedOrigins: () => [requirePlatformEnvironment().siteUrl],
  cors: { allowedOrigins: [] },
});
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async (ctx) => {
    try {
      const { appEnv, productEnv, fiscalEnv, issuanceEnv, captureFiscal } =
        requirePlatformEnvironment();
      // `halted`: both variables open the capture, but the persisted general stop closes it (#424).
      const halted =
        captureFiscal === "enabled" &&
        (await ctx.runQuery(internal.captureRelease.haltState, {})).halted;
      return Response.json(
        {
          status: "ok",
          appEnv,
          productEnv,
          fiscalEnv,
          issuanceEnv,
          captureFiscal: halted ? "halted" : captureFiscal,
          sha: buildSha,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      return Response.json({ status: "misconfigured" }, { status: 503 });
    }
  }),
});
export default http;
