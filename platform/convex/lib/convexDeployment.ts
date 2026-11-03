/**
 * URL of a Convex Cloud deployment (`https://<adjective>-<animal>-<number>.convex.cloud`), the
 * form of `CONVEX_CLOUD_URL` that the fiscal policies pin. A self-hosted backend chooses its own
 * origin, so the pin binds a deployment only on Convex Cloud.
 */
export const CONVEX_CLOUD_DEPLOYMENT_URL = /^https:\/\/[a-z]+-[a-z]+-\d+\.convex\.cloud$/;
