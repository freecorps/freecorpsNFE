import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../../platform/convex/_generated/api";
import { authClient } from "./auth";
import { checkFields, fieldProps, focusFirstError, type FieldErrors } from "./account-validation";
import { afterLoginHref, rememberEmail, rememberedEmail, safeRedirect } from "./session-handoff";
import { AuthLayout } from "./auth-layout";
import { local } from "./environment";
import { Button, buttonClass } from "./ui/button";
import { Callout, SkeletonBlock } from "./ui/layout";
import { FormField, Input } from "./ui/form";

type Mode = "signup" | "verify-email" | "forgot-password" | "reset-password";
const content: Record<Mode, { title: string; description: string; submit: string }> = {
  signup: {
    title: "Crie sua conta.",
    // Os perfis locais aceitam qualquer e-mail; os outros, só os autorizados no painel
    // (`ACCOUNT_EMAIL_RECIPIENTS`), e aceitam os demais sem criar conta.
    description: local
      ? "Use um e-mail que você possa verificar. A senha precisa ter entre 16 e 128 caracteres."
      : "Use um e-mail autorizado neste painel e que você possa verificar. A senha precisa ter entre 16 e 128 caracteres.",
    submit: "Criar conta",
  },
  "verify-email": {
    title: "Verifique seu e-mail.",
    description:
      "Informe o código de oito dígitos. Ele expira em dez minutos e só pode ser usado uma vez.",
    submit: "Verificar e-mail",
  },
  "forgot-password": {
    title: "Recupere seu acesso.",
    description: "Informe o e-mail da sua conta. Enviaremos um código para redefinir a senha.",
    submit: "Solicitar código",
  },
  "reset-password": {
    title: "Escolha uma nova senha.",
    description:
      "Use o código de recuperação. Ao trocar a senha, suas sessões anteriores serão encerradas.",
    submit: "Salvar nova senha",
  },
};
/**
 * The server answers signup, new code and recovery the same way whether or not an account
 * exists (no account oracle). The texts say what happens in each case without telling which.
 */
const SIGNUP_SENT = local
  ? "Se ainda não houver uma conta com este e-mail, enviamos um código de verificação para ele. Se você já tem conta, entre ou recupere a senha."
  : "Se ainda não houver uma conta com este e-mail e ele estiver autorizado neste painel, enviamos um código de verificação para ele. Se você já tem conta, entre ou recupere a senha.";
const CODE_RESENT =
  "Se este e-mail tiver um cadastro aguardando verificação, enviamos um novo código. Use sempre o código mais recente.";
const RECOVERY_SENT =
  "Se houver uma conta com este e-mail, enviamos um código de recuperação. Ele vale por dez minutos.";

/** Sem `registration`, o servidor recusa cadastro, verificação e recuperação por e-mail. */
const unavailable: Record<Mode, string> = {
  signup: "Cadastro indisponível.",
  "verify-email": "Verificação indisponível.",
  "forgot-password": "Recuperação indisponível.",
  "reset-password": "Recuperação indisponível.",
};

function failure(error: { code?: string; status?: number }, mode: Mode) {
  if (error.status === 503 || error.code === "ACCOUNT_EMAIL_UNAVAILABLE")
    return "O envio de e-mail está indisponível agora. Aguarde alguns minutos e solicite um novo código.";
  if (error.status === 429)
    return "Muitas tentativas. Aguarde um minuto antes de tentar novamente.";
  if (mode === "verify-email" || mode === "reset-password")
    return "Código inválido, expirado ou já utilizado. Confira os dados ou solicite outro código.";
  return "Não foi possível concluir. Confira os dados; se já tiver uma conta, use a recuperação de senha.";
}
function initialEmail(search: { email?: unknown }) {
  const fromUrl = typeof search.email === "string" ? search.email.trim() : "";
  return rememberedEmail() || (fromUrl.length <= 254 ? fromUrl : "");
}

export function AccountForm({ mode }: { mode: Mode }) {
  const capabilities = useQuery(api.account.capabilities);
  const { isAuthenticated, isLoading } = useConvexAuth();
  const search = useSearch({ strict: false }) as { email?: unknown; redirect?: unknown };
  const redirect = safeRedirect(search.redirect);
  const navigate = useNavigate();
  const [email, setEmail] = useState(() => initialEmail(search));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  /**
   * Signup continues on the same card: the verification code, then the login with the password
   * just typed. The password stays in this component's memory only until that login.
   */
  const [signupPassword, setSignupPassword] = useState("");
  const [verified, setVerified] = useState(false);
  const text = content[mode];
  const step: Mode = mode === "signup" && done ? "verify-email" : mode;
  // Already signed in (the landing's "Criar conta" or a task entry, `taskEntryHref`): straight to
  // the work, like the login. Only before the form is sent: the signup's own login navigates.
  const beforeSignup = mode === "signup" && !done;
  const signedIn = beforeSignup && isAuthenticated;
  useEffect(() => {
    // safeRedirect only lets through internal addresses of the console, built by it.
    if (signedIn) void navigate({ href: afterLoginHref(redirect), replace: true });
  }, [signedIn, navigate, redirect]);

  async function enterAfterVerification(password: string) {
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password });
      setSignupPassword("");
      if (!result.error) {
        // safeRedirect only lets through internal addresses of the console, built by it.
        await navigate({ href: afterLoginHref(redirect), replace: true });
        return;
      }
    } catch {
      setSignupPassword("");
    }
    // The account is verified; the login screen finishes, with the e-mail already filled.
    rememberEmail(email);
    setVerified(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const password = field("password");
    const otp = field("otp").trim();
    const found = checkFields(
      {
        email,
        ...(step === "signup" ? { name: field("name") } : {}),
        ...(step === "verify-email" || step === "reset-password" ? { otp } : {}),
        ...(step === "signup" || step === "reset-password" ? { password } : {}),
      },
      { newPassword: true },
    );
    setErrors(found);
    setError("");
    setMessage("");
    if (Object.keys(found).length) {
      focusFirstError(element, found);
      return;
    }
    setBusy(true);
    try {
      const result =
        step === "signup"
          ? await authClient.signUp.email({
              email: email.trim(),
              password,
              name: field("name").trim(),
            })
          : step === "verify-email"
            ? await authClient.emailOtp.verifyEmail({ email: email.trim(), otp })
            : step === "forgot-password"
              ? await authClient.emailOtp.requestPasswordReset({ email: email.trim() })
              : await authClient.emailOtp.resetPassword({ email: email.trim(), otp, password });
      if (result.error) {
        setError(failure(result.error, step));
        return;
      }
      rememberEmail(email);
      if (step === "signup") {
        setSignupPassword(password);
        setDone(true);
      } else if (mode === "signup") await enterAfterVerification(signupPassword);
      else setDone(true);
    } catch {
      setError("Não foi possível conectar. Verifique sua conexão e tente novamente.");
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    const found = checkFields({ email });
    setErrors(found);
    setError("");
    setMessage("");
    if (found.email) return;
    setBusy(true);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: "email-verification",
      });
      if (result.error) setError(failure(result.error, "verify-email"));
      else setMessage(CODE_RESENT);
    } catch {
      setError("Não foi possível solicitar outro código. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }
  if (capabilities === undefined || signedIn || (beforeSignup && isLoading))
    return (
      <AuthLayout>
        <section className="auth-card" aria-label="Opções de acesso">
          <SkeletonBlock label="Carregando opções de acesso…" lines={4} />
        </section>
      </AuthLayout>
    );
  if (!capabilities.registration)
    return (
      <AuthLayout>
        <section className="auth-card" aria-labelledby="account-title">
          <h1 id="account-title" className="auth-card__title">
            {unavailable[mode]}
          </h1>
          <p className="auth-card__description">
            Este painel não aceita novas contas nem recupera a senha por e-mail. Entre com uma conta
            existente.
          </p>
          <Link to="/login" className={buttonClass({ variant: "secondary", block: true })}>
            Voltar ao login
          </Link>
        </section>
      </AuthLayout>
    );
  const loginLink = (
    <Link
      className={buttonClass({ variant: "primary", block: true })}
      to="/login"
      search={redirect ? { redirect } : {}}
      onClick={() => rememberEmail(email)}
    >
      Entrar
    </Link>
  );
  const finished = (mode !== "signup" && done) || verified;
  return (
    <AuthLayout>
      <section className="auth-card" aria-labelledby="account-title">
        <p className="auth-card__eyebrow">
          Sua conta · {mode === "signup" ? "Primeiro acesso" : "Segurança"}
        </p>
        <h1 id="account-title" className="auth-card__title">
          {mode === "signup" && done ? "Confirme seu e-mail." : text.title}
        </h1>
        {finished ? (
          <div className="auth-status" role="status">
            <p className="auth-card__description">
              {verified || mode === "verify-email"
                ? "E-mail verificado. Entre com sua senha para continuar."
                : mode === "forgot-password"
                  ? RECOVERY_SENT
                  : "Senha atualizada. Entre novamente com a nova senha."}
            </p>
            {mode === "forgot-password" ? (
              <Link
                className={buttonClass({ variant: "primary", block: true })}
                to="/reset-password"
                search={redirect ? { redirect } : {}}
                onClick={() => rememberEmail(email)}
              >
                Informar código de recuperação
              </Link>
            ) : (
              loginLink
            )}
          </div>
        ) : (
          <>
            {mode === "signup" && done ? (
              <div className="auth-card__description" role="status">
                <Callout tone="info">
                  <p>{SIGNUP_SENT}</p>
                </Callout>
                <p className="auth-note">
                  Código enviado para <strong>{email.trim()}</strong>. Ele vale por dez minutos.
                </p>
              </div>
            ) : (
              <p className="auth-card__description">{text.description}</p>
            )}
            <form className="ui-form" onSubmit={submit} aria-busy={busy} noValidate>
              {step === "signup" && (
                <FormField id="name" label="Seu nome" error={errors.name}>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    maxLength={100}
                    disabled={busy}
                    {...fieldProps("name", errors, "name")}
                  />
                </FormField>
              )}
              {!(mode === "signup" && done) && (
                <FormField id="email" label="E-mail" error={errors.email}>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={254}
                    disabled={busy}
                    {...fieldProps("email", errors, "email")}
                  />
                </FormField>
              )}
              {(step === "verify-email" || step === "reset-password") && (
                <FormField id="otp" label="Código de oito dígitos" error={errors.otp}>
                  <Input
                    id="otp"
                    name="otp"
                    inputMode="numeric"
                    maxLength={8}
                    autoComplete="one-time-code"
                    className="ui-mono"
                    disabled={busy}
                    {...fieldProps("otp", errors, "otp", error ? "account-error" : undefined)}
                  />
                </FormField>
              )}
              {(step === "signup" || step === "reset-password") && (
                <FormField
                  id="password"
                  label={mode === "reset-password" ? "Nova senha" : "Senha"}
                  error={errors.password}
                  help="De 16 a 128 caracteres. Uma frase longa é uma boa opção."
                >
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    maxLength={128}
                    disabled={busy}
                    {...fieldProps("password", errors, "password", "password-help")}
                  />
                </FormField>
              )}
              {error && (
                <div id="account-error">
                  <Callout tone="danger" role="alert">
                    <p>{error}</p>
                  </Callout>
                </div>
              )}
              {message && (
                <Callout tone="success" role="status">
                  <p>{message}</p>
                </Callout>
              )}
              <Button type="submit" variant="primary" block loading={busy} loadingLabel="Aguarde…">
                {step === "verify-email" ? "Verificar e-mail" : text.submit}
              </Button>
              {step === "verify-email" && (
                <Button variant="ghost" block disabled={busy} onClick={resend}>
                  Solicitar outro código
                </Button>
              )}
            </form>
          </>
        )}
        {import.meta.env.VITE_APP_ENV === "selfhost-local" ? (
          <p className="auth-note">
            Consulte o código no coletor local da instalação, conforme o guia do operador. Nenhum
            e-mail é enviado à internet.
          </p>
        ) : import.meta.env.VITE_APP_ENV === "development" ? (
          <p className="auth-note">
            Neste ambiente local, consulte a mensagem com{" "}
            <code>bun run worktree:mail seu@email</code> no terminal desta worktree. Nenhum e-mail é
            enviado à internet.
          </p>
        ) : !finished ? (
          <p className="auth-note">Confira sua caixa de entrada e a pasta de spam.</p>
        ) : null}
        <nav className="auth-links" aria-label="Conta">
          <Link to="/login" search={redirect ? { redirect } : {}}>
            Voltar ao login
          </Link>
          {mode === "reset-password" && <Link to="/forgot-password">Solicitar novo código</Link>}
        </nav>
      </section>
    </AuthLayout>
  );
}
