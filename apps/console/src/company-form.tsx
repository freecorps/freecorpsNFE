import { useState } from "react";
import { normalizeCnpj, type CompanyAddress } from "@freecorps/contracts";
import { controlProps, type FieldErrors } from "./field";
import { FormField, Input } from "./ui";
import { companyMessages, errorCode, errorText } from "./company-feedback";

// Company fields shared by registration and editing: reading the form, the orientation with the
// server rules and the submit state. The mutations stay with each form.

const emptyAddress: CompanyAddress = {
  street: "",
  number: "",
  complement: "",
  district: "",
  city: "",
  state: "",
  postalCode: "",
};
export function formValue(form: FormData, name: string) {
  const result = form.get(name);
  return typeof result === "string" ? result : "";
}
export function fields(form: FormData) {
  const address = Object.fromEntries(
    Object.keys(emptyAddress).map((key) => [key, formValue(form, key)]),
  ) as unknown as CompanyAddress;
  return { name: formValue(form, "name"), address };
}
const addressLabels: Record<keyof CompanyAddress, string> = {
  street: "Logradouro",
  number: "Número",
  complement: "Complemento",
  district: "Bairro",
  city: "Município",
  state: "UF",
  postalCode: "CEP",
};
const addressMax: Record<keyof CompanyAddress, number> = {
  street: 120,
  number: 20,
  complement: 80,
  district: 80,
  city: 80,
  state: 2,
  postalCode: 9,
};
const addressKeys = Object.keys(addressLabels) as Array<keyof CompanyAddress>;
export const companyFieldOrder: Array<[string, string]> = [
  ["company-cnpj", "CNPJ"],
  ["company-name", "Nome da empresa"],
  ...addressKeys.map((key): [string, string] => [`company-${key}`, addressLabels[key]]),
];
const UF = /^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/;
const required: Record<keyof CompanyAddress, string> = {
  street: "Informe o logradouro.",
  number: "Informe o número. Use S/N quando não houver.",
  complement: "",
  district: "Informe o bairro.",
  city: "Informe o município.",
  state: "Informe a UF.",
  postalCode: "Informe o CEP.",
};
/**
 * Orientation with the server rules of `declaredFields` and `companyCnpj`, every field at once.
 * `cnpj` is checked only when the form has the field (registration, not editing).
 */
export function companyErrors(input: {
  cnpj?: string;
  name: string;
  address: CompanyAddress;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (input.cnpj !== undefined) {
    if (!input.cnpj.trim()) errors["company-cnpj"] = "Informe o CNPJ da empresa.";
    else if (!normalizeCnpj(input.cnpj)) errors["company-cnpj"] = companyMessages.INVALID_CNPJ!;
  }
  const name = input.name.trim();
  if (!name) errors["company-name"] = "Informe o nome da empresa.";
  else if (name.length > 160) errors["company-name"] = "O nome aceita até 160 caracteres.";
  for (const key of addressKeys) {
    const text = input.address[key].trim();
    if (!text && required[key]) errors[`company-${key}`] = required[key];
    else if (text.length > addressMax[key])
      errors[`company-${key}`] = `Use até ${addressMax[key]} caracteres.`;
  }
  const state = input.address.state.trim().toUpperCase();
  if (state && !UF.test(state))
    errors["company-state"] = "Informe a sigla de uma UF brasileira, como SP.";
  const cep = input.address.postalCode.trim();
  if (cep && !/^(\d{8}|\d{5}-\d{3})$/.test(cep))
    errors["company-postalCode"] = "O CEP tem oito dígitos, como 13010-000.";
  return errors;
}
/** Width of each address field in the six-column grid; one column on the phone. */
const addressSpan: Record<keyof CompanyAddress, number> = {
  street: 4,
  number: 2,
  complement: 3,
  district: 3,
  city: 3,
  state: 1,
  postalCode: 2,
};
export type CompanyValues = { name: string; address: CompanyAddress };
export const emptyCompany = (): CompanyValues => ({ name: "", address: { ...emptyAddress } });
export function CompanyFields({
  company,
  values,
  onEdit,
  disabled,
  errors,
  nameSpan = 6,
}: {
  company?: CompanyValues;
  /** Controlled form (registration with a consulted CNPJ); without it, the inputs keep their own value. */
  values?: CompanyValues;
  onEdit?: (key: "name" | keyof CompanyAddress, value: string) => void;
  disabled: boolean;
  errors: FieldErrors;
  nameSpan?: number;
}) {
  const bind = (key: "name" | keyof CompanyAddress) =>
    values
      ? {
          value: key === "name" ? values.name : values.address[key],
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            onEdit?.(key, event.target.value),
        }
      : { defaultValue: key === "name" ? company?.name : company?.address[key] };
  return (
    <>
      <div data-span={nameSpan}>
        <FormField id="company-name" label="Nome da empresa" error={errors["company-name"]}>
          <Input
            {...controlProps("company-name", errors["company-name"])}
            name="name"
            {...bind("name")}
            maxLength={160}
            disabled={disabled}
            autoComplete="organization"
          />
        </FormField>
      </div>
      {addressKeys.map((key) => {
        const id = `company-${key}`;
        return (
          <div
            key={key}
            data-span={addressSpan[key]}
            // Short fields pair up on the phone.
            data-compact={addressSpan[key] <= 2 || undefined}
          >
            <FormField
              id={id}
              label={addressLabels[key]}
              optional={key === "complement"}
              error={errors[id]}
            >
              <Input
                {...controlProps(id, errors[id])}
                name={key}
                {...bind(key)}
                disabled={disabled}
                maxLength={addressMax[key]}
                autoCapitalize={key === "state" ? "characters" : undefined}
                inputMode={key === "postalCode" ? "numeric" : "text"}
                className={key === "state" || key === "postalCode" ? "ui-mono" : undefined}
              />
            </FormField>
          </div>
        );
      })}
    </>
  );
}
/** Submit state shared by registration and editing: field errors, summary and focus. */
export function useCompanyForm() {
  const [busy, setBusy] = useState(false),
    [errors, setErrors] = useState<FieldErrors>({}),
    [general, setGeneral] = useState(""),
    [attempt, setAttempt] = useState(0);
  const refuse = (found: FieldErrors, message = "") => {
    setErrors(found);
    setGeneral(message);
    setAttempt((n) => n + 1);
  };
  return {
    busy,
    setBusy,
    errors,
    general,
    attempt,
    refuse,
    clear() {
      setErrors({});
      setGeneral("");
    },
    /** Server rejection: the CNPJ has its own field; the others name the request. */
    reject(error: unknown) {
      if (errorCode(error) === "INVALID_CNPJ")
        refuse({ "company-cnpj": companyMessages.INVALID_CNPJ! });
      else refuse({}, errorText(error));
    },
  };
}
export const CREATE_ANCHOR = "cadastrar-empresa";
/** Takes the focus to the registration form, scrolling only if its title is out of view. */
export function focusCreate(heading: HTMLHeadingElement | null) {
  heading?.focus({ preventScroll: true });
  heading?.scrollIntoView?.({ block: "nearest" });
}
