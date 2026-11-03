import { readLocalConfig, localUrls } from "./deployment.mjs";
import { assertLinkedWorktree } from "./state.mjs";
import { assertPrivateDirectories } from "./operation.mjs";
import { currentLocalSiteUrl } from "./env-file.mjs";

/** Operator-only local collector. Never accepts a URL or credential from the caller. */
export async function readMailbox(paths, email) {
  assertLinkedWorktree(paths);
  assertPrivateDirectories(paths);
  if (paths.app !== "platform")
    throw new Error("O coletor pertence a uma worktree --app platform.");
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Uso: bun run worktree:mail <email>");
  const config = readLocalConfig(paths);
  if (!config) throw new Error("Rode worktree:setup --app platform e worktree:dev primeiro.");
  const response = await fetch(`${localUrls(config).cloud}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${config.adminKey}` },
    body: JSON.stringify({
      path: "mail:inbox",
      args: { email: email.toLowerCase() },
      format: "json",
    }),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok || result.status !== "success")
    throw new Error("Não foi possível ler o coletor local. Verifique worktree:dev.");
  // Invitations also print the link the e-mail carries, with the code in the fragment.
  const site = currentLocalSiteUrl(paths);
  const messages = result.value.map((message) =>
    message.type === "organization-invitation" &&
    site &&
    typeof message.otp === "string" &&
    /^[a-f0-9]{64}$/.test(message.otp)
      ? {
          ...message,
          link: `${new URL(site).origin}/accept-invitation#code=${encodeURIComponent(message.otp)}`,
        }
      : message,
  );
  console.log(JSON.stringify(messages, null, 2));
}
