// Sessão dos roteiros de gestão (empresas, chaves e organizações): chamadas Convex com o token
// da pessoa, códigos do e-mail local e as jornadas de criar organização e de convite pela UI.
// `visit` vem de cada roteiro: a navegação difere entre eles e não entra aqui.
import { localBrowserFetch as fetch } from "../../../scripts/lib/local-browser.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currentOrganization } from "./shell.mjs";

/** Hash deste módulo, para o recibo do roteiro mudar quando a sessão mudar. */
export const managementSessionHash = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");

export function managementSession({ urls, config, site, report, contextKey, visit }) {
  async function rpc(kind, path, args, authorization) {
    const response = await fetch(`${urls.cloud}/api/${kind}`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    return response.json();
  }
  async function localCode(email, type) {
    const result = await rpc("query", "mail:inbox", { email }, `Convex ${config.adminKey}`);
    assert.equal(result.status, "success");
    const mail = result.value.find((message) => message.type === type);
    assert.ok(mail, "Expected local mail");
    return mail.otp;
  }
  async function authorization(user) {
    const { exp } = JSON.parse(Buffer.from(user.jwt.split(".")[1], "base64url").toString("utf8"));
    if (exp * 1000 < Date.now() + 20_000) {
      user.jwt = await user.page.evaluate(async () => {
        const { authClient } = await import("/src/auth.ts");
        return (await authClient.convex.token()).data?.token;
      });
      assert.ok(user.jwt, "Expected a fresh authenticated token");
    }
    return `Bearer ${user.jwt}`;
  }
  async function success(user, kind, path, args) {
    const result = await rpc(kind, path, args, await authorization(user));
    assert.equal(result.status, "success", `Authorized ${path} failed`);
    return result.value;
  }
  async function denied(user, kind, path, args) {
    const result = await rpc(kind, path, args, await authorization(user));
    assert.equal(result.status, "error", `Expected ${path} to refuse unauthorized access`);
  }
  async function create(user, name) {
    report.step = `create organization: ${name}`;
    await visit(user, "/app");
    await user.page.getByLabel("Nome da organização", { exact: true }).fill(name);
    const slug = `equipe-${crypto.randomUUID()}`;
    await user.page.getByLabel("Endereço da organização").fill(slug);
    await user.page.getByRole("checkbox", { name: /Li e aceito os termos de uso/ }).check();
    await user.page.getByRole("button", { name: "Criar organização", exact: true }).click();
    await currentOrganization(user.page, name).waitFor();
    return success(user, "query", "organizations:context", { slug, contextKey });
  }
  async function send(owner, org, recipient, role) {
    report.step = `invite ${role} to ${org.name}`;
    await visit(owner, `/app/${org.slug}/settings/members`);
    await owner.page.getByLabel("E-mail da pessoa").fill(recipient.email);
    await owner.page.getByLabel("Papel no convite").selectOption(role);
    await owner.page.getByRole("button", { name: "Enviar convite", exact: true }).click();
    await owner.page.getByText("Convite enviado.", { exact: false }).waitFor();
    return localCode(recipient.email, "organization-invitation");
  }
  async function accept(user, token, org) {
    report.step = `accept invitation: ${org.name}`;
    let leaked = false;
    const inspectUrl = (request) => {
      if (request.url().includes(token)) leaked = true;
    };
    user.page.on("request", inspectUrl);
    await visit(user, "/accept-invitation");
    await user.page.getByLabel("Código do convite").fill(token);
    await user.page.getByRole("button", { name: "Conferir convite", exact: true }).click();
    await user.page.getByRole("heading", { name: org.name, exact: true }).waitFor();
    await user.page.getByRole("button", { name: "Confirmar participação", exact: true }).click();
    await user.page.waitForURL(`${site}/app/${org.slug}`);
    await currentOrganization(user.page, org.name).waitFor();
    assert.equal(leaked, false);
    assert.equal(
      await user.page.evaluate(
        (value) =>
          [localStorage, sessionStorage].some((storage) =>
            Object.keys(storage).some((key) => storage.getItem(key)?.includes(value)),
          ),
        token,
      ),
      false,
    );
    user.page.off("request", inspectUrl);
  }
  return { rpc, localCode, authorization, success, denied, create, send, accept };
}
