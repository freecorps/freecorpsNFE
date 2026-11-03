import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateBackupDirectory } from "./lib/validation-backup.mjs";
import {
  backendRequest,
  requireIntegrationWriter,
  validateTarget,
  verifyRemoteEnvironment,
} from "./lib/validation.mjs";

try {
  if (process.argv.slice(2).join(" ") !== "--bootstrap")
    throw new Error("Usage: validation-accounts.mjs --bootstrap");
  requireIntegrationWriter(process.env, true);
  const context = validateTarget(process.env);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const directory = validateBackupDirectory(
    process.env.VALIDATION_ACCESS_DIR ?? join(homedir(), ".freecorpsnfe", "validation-access"),
    root,
  );
  await verifyRemoteEnvironment(context);
  const suffix = randomBytes(6).toString("hex");
  const accounts = [
    { role: "operator", name: "Operador de teste" },
    { role: "viewer", name: "Leitor de teste" },
    { role: "none", name: "Conta sem acesso" },
  ].map((account) => ({
    ...account,
    email: `${account.role}-${suffix}@validation.invalid`,
    password: randomBytes(24).toString("base64url"),
    created: false,
  }));
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `accounts-${suffix}.json`);
  const save = (flag) =>
    writeFileSync(
      output,
      `${JSON.stringify({ url: context.target.consoleUrl, accounts }, null, 2)}\n`,
      { mode: 0o600, flag },
    );
  save("wx");
  console.log(`target: dev (${context.target.deploymentName}, validation test accounts)`);
  console.log(`Private access file: ${output}`);
  for (const account of accounts) {
    const { created: _created, ...args } = account;
    await backendRequest(context, "/api/action", {
      path: "provision:createTestAccount",
      args,
      format: "json",
    });
    account.created = true;
    save("w");
    console.log(`Created validation role: ${account.role}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Account provisioning failed");
  process.exitCode = 1;
}
