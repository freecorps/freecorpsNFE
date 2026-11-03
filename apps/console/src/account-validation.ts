/**
 * Field checks of the account screens, in Portuguese, instead of the browser's validation
 * bubble (which follows the browser language). They only guide: Better Auth checks again.
 */
export type AccountField = "name" | "email" | "password" | "otp";
export type FieldErrors = Partial<Record<AccountField, string>>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkFields(
  values: Partial<Record<AccountField, string>>,
  options: { newPassword?: boolean } = {},
): FieldErrors {
  const errors: FieldErrors = {};
  if (values.name !== undefined) {
    const name = values.name.trim();
    if (!name) errors.name = "Informe seu nome.";
    else if (name.length < 2 || name.length > 100)
      errors.name = "O nome precisa ter de 2 a 100 caracteres.";
  }
  if (values.email !== undefined) {
    const email = values.email.trim();
    if (!email) errors.email = "Informe seu e-mail.";
    else if (email.length > 254 || !emailPattern.test(email))
      errors.email = "Confira o e-mail. Use o formato nome@empresa.com.br.";
  }
  if (values.otp !== undefined) {
    const otp = values.otp.trim();
    if (!otp) errors.otp = "Informe o código recebido por e-mail.";
    else if (!/^\d{8}$/.test(otp)) errors.otp = "O código tem oito dígitos, só números.";
  }
  if (values.password !== undefined) {
    if (!values.password) errors.password = "Informe sua senha.";
    else if (options.newPassword && (values.password.length < 16 || values.password.length > 128))
      errors.password = "A senha precisa ter de 16 a 128 caracteres.";
  }
  return errors;
}

/** Focuses the first field with an error, in the order of the form. */
export function focusFirstError(form: HTMLFormElement, errors: FieldErrors) {
  for (const element of Array.from(form.elements))
    if (element instanceof HTMLInputElement && element.name in errors) {
      element.focus();
      return;
    }
}

/** Props that tie a field to its message for screen readers. */
export function fieldProps(id: string, errors: FieldErrors, field: AccountField, help?: string) {
  const error = errors[field];
  const describedBy = [error ? `${id}-error` : null, help ?? null].filter(Boolean).join(" ");
  return {
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": describedBy || undefined,
  };
}
