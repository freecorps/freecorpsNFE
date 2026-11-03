import { useEffect, useState, type FormEvent } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../../../platform/convex/_generated/api";
import { authClient } from "./auth";
import { afterLoginHref, rememberEmail, rememberedEmail, safeRedirect } from "./session-handoff";
import { checkFields, fieldProps, focusFirstError, type FieldErrors } from "./account-validation";
import { AuthLayout } from "./auth-layout";
import { local } from "./environment";
import { Pending } from "./session-layout";
import { Button } from "./ui/button";
import { Callout } from "./ui/layout";
import { FormField, Input } from "./ui/form";

/** Replaces the address with an internal one already checked (`safeRedirect`, `homeHref`). */
function NavigateHref({ href }: { href: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ href, replace: true });
  }, [navigate, href]);
  return <Pending />;
}

export function Login() {
  const capabilities = useQuery(api.account.capabilities);
  const { isAuthenticated, isLoading } = useConvexAuth();
  const search = useSearch({ strict: false }) as { redirect?: unknown; email?: unknown };
  const redirect = safeRedirect(search.redirect);
  const [email, setEmail] = useState(() => {
    const fromUrl = typeof search.email === "string" ? search.email.trim() : "";
    return rememberedEmail() || (fromUrl.length <= 254 ? fromUrl : "");
  });
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  if (isLoading) return <Pending />;
  // Straight to the work: the page that sent the person here (with its query), the last
  // organization of this browser, or the console home, which finds the only one.
  if (isAuthenticated)
    // safeRedirect only lets through internal addresses of the console, built by it.
    return <NavigateHref href={afterLoginHref(redirect)} />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const password = new FormData(element).get("password");
    if (typeof password !== "string") return;
    const found = checkFields({ email, password });
    setErrors(found);
    setError("");
    if (Object.keys(found).length) {
      focusFirstError(element, found);
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        rememberEmail(email);
        setError(
          result.error.status === 429
            ? "Muitas tentativas. Aguarde um minuto e tente novamente."
            : result.error.code === "EMAIL_NOT_VERIFIED"
              ? "Verifique seu e-mail antes de entrar. Use o link de verificação abaixo."
              : "Não foi possível entrar. Confira seu e-mail e senha.",
        );
      }
    } catch {
      setError("Não foi possível conectar. Verifique sua conexão e tente novamente.");
    } finally {
      setBusy(false);
    }
  }
  const forward = redirect ? { redirect } : {};
  return (
    <AuthLayout>
      <section className="auth-card" aria-labelledby="login-title">
        <p className="auth-card__eyebrow">Sua conta</p>
        <h1 id="login-title" className="auth-card__title">
          Entre no painel.
        </h1>
        <p className="auth-card__description">
          {redirect?.startsWith("/accept-invitation")
            ? "Entre com o e-mail que recebeu o convite. Depois do login, você confere a organização e o papel antes de aceitar."
            : capabilities?.registration
              ? local
                ? "Use o e-mail e a senha da sua conta. Se ainda não tem uma, crie a sua abaixo."
                : "Use o e-mail e a senha da sua conta. Crie uma conta se o seu e-mail estiver autorizado neste painel."
              : "Use o e-mail e a senha da sua conta."}
        </p>
        <form className="ui-form" onSubmit={submit} aria-busy={busy} noValidate>
          <FormField id="email" label="E-mail" error={errors.email}>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              placeholder="voce@empresa.com.br"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              disabled={busy}
              {...fieldProps("email", errors, "email")}
            />
          </FormField>
          <FormField id="password" label="Senha" error={errors.password}>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              disabled={busy}
              {...fieldProps("password", errors, "password", error ? "login-error" : undefined)}
            />
          </FormField>
          {error && (
            <div id="login-error">
              <Callout tone="danger" role="alert">
                <p>{error}</p>
              </Callout>
            </div>
          )}
          <Button type="submit" variant="primary" block loading={busy} loadingLabel="Entrando…">
            Entrar no painel
          </Button>
        </form>
        {capabilities?.registration ? (
          <nav className="auth-links" aria-label="Conta">
            <Link to="/signup" search={forward} onClick={() => rememberEmail(email)}>
              Criar conta
            </Link>
            <Link to="/verify-email" search={forward} onClick={() => rememberEmail(email)}>
              Verificar e-mail
            </Link>
            <Link to="/forgot-password" search={forward} onClick={() => rememberEmail(email)}>
              Esqueci minha senha
            </Link>
          </nav>
        ) : capabilities ? (
          // Sem `registration`, o servidor não cria contas nem envia e-mails de conta (nem os
          // convites chegam por e-mail): só uma conta existente entra.
          <p className="auth-note">
            Este painel não aceita novas contas nem recupera a senha por e-mail. Entre com uma conta
            existente.
          </p>
        ) : null}
      </section>
    </AuthLayout>
  );
}
