import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAction, useMutation, type UsePaginatedQueryReturnType } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { useAsyncAction } from "./async-action";
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DescriptionList,
  EmptyState,
  FormField,
  Icon,
  Input,
  SkeletonBlock,
  StatusBadge,
  buttonClass,
  type Tone,
} from "./ui";

type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;
type Certificate = FunctionReturnType<typeof api.certificates.list>["page"][number];
const states: Record<Certificate["state"], string> = {
  uploading: "Recebendo arquivo",
  validating: "Em validação",
  active: "Validado para uso no serviço",
  rejected: "Rejeitado",
  replaced: "Substituído",
  revoked: "Desativado",
  expired: "Expirado",
};
const messages: Record<string, string> = {
  CERTIFICATE_INVALID: "Não foi possível abrir o certificado. Confira o arquivo e a senha.",
  CERTIFICATE_IDENTITY:
    "O CNPJ do certificado precisa corresponder ao CNPJ completo desta empresa.",
  CERTIFICATE_PURPOSE:
    "O certificado precisa permitir autenticação de cliente e conter uma chave RSA de pelo menos 2048 bits.",
  CERTIFICATE_EXPIRED: "O certificado está expirado. Envie um certificado vigente.",
  CERTIFICATE_NOT_YET_VALID: "O prazo de validade deste certificado ainda não começou.",
  CERTIFICATE_SUPERSEDED: "Um envio mais recente substituiu esta solicitação.",
  CERTIFICATE_UPLOAD_TIMEOUT: "O envio não terminou. Selecione o arquivo novamente.",
  CERTIFICATE_KEY_UNAVAILABLE: "O cofre está indisponível. Avise a equipe responsável.",
  CERTIFICATE_UPLOAD_FAILED:
    "Não foi possível concluir o envio. Confira seu acesso e tente novamente.",
  CERTIFICATE_SIZE: "Use um arquivo PFX de até 256 KiB e uma senha de até 1024 bytes.",
  ACCESS_REVOKED:
    "O acesso de quem enviou o certificado foi alterado. Faça um novo envio autorizado.",
  RATE_LIMITED: "Muitos envios. Aguarde um minuto antes de tentar novamente.",
};
function errorMessage(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? String(data.code) : "";
  return (
    messages[code] ?? "Não foi possível concluir a ação. Confira seu acesso e tente novamente."
  );
}
const MAX_PFX = 262144;
/** Orientation only: the server checks size, password and content again. */
export function uploadErrors(file: File | null, password: string) {
  const errors: { pfx?: string; password?: string } = {};
  if (!file || !file.name)
    errors.pfx = "Selecione o arquivo A1 da empresa, com extensão .pfx ou .p12.";
  else if (!/\.(pfx|p12)$/i.test(file.name))
    errors.pfx = "Use o arquivo A1 com extensão .pfx ou .p12.";
  else if (!file.size) errors.pfx = "O arquivo está vazio. Selecione o arquivo A1 novamente.";
  else if (file.size > MAX_PFX)
    errors.pfx = `O arquivo tem ${Math.ceil(file.size / 1024)} KiB; o limite é 256 KiB.`;
  if (new TextEncoder().encode(password).length > 1024)
    errors.password = "A senha pode ter até 1024 bytes.";
  return errors;
}
function Upload({ org, company }: { org: Organization; company: Company }) {
  const upload = useAction(api.certificateWorker.upload);
  const formRef = useRef<HTMLFormElement>(null);
  const { busy, error, run, clearError } = useAsyncAction(errorMessage);
  const [fileName, setFileName] = useState(""),
    [errors, setErrors] = useState<{ pfx?: string; password?: string }>({});
  useEffect(() => {
    const form = formRef.current;
    return () => form?.reset();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    const file = values.get("pfx"),
      secret = values.get("password"),
      password = typeof secret === "string" ? secret : "";
    values.delete("pfx");
    values.delete("password");
    const found = uploadErrors(file instanceof File ? file : null, password);
    setErrors(found);
    clearError();
    if (found.pfx || found.password) {
      // A refused file leaves the form; the password stays only while nothing was sent.
      if (found.pfx) {
        const input = form.elements.namedItem("pfx");
        if (input instanceof HTMLInputElement) input.value = "";
        setFileName("");
      }
      document.getElementById(found.pfx ? "certificate-pfx" : "certificate-password")?.focus();
      return;
    }
    form.reset();
    setFileName("");
    await run(async (current) => {
      let bytes: ArrayBuffer | undefined;
      try {
        bytes = await (file as File).arrayBuffer();
        if (!current()) return;
        await upload({ organizationId: org.id, companyId: company.id, pfx: bytes, password });
      } finally {
        if (bytes) new Uint8Array(bytes).fill(0);
      }
    });
  }
  return (
    <Card
      title="Enviar certificado A1"
      description="O titular precisa ter o mesmo CNPJ desta empresa. Um novo envio validado substitui a versão ativa."
    >
      <form
        ref={formRef}
        onSubmit={submit}
        aria-busy={busy}
        className="ui-form"
        autoComplete="off"
        data-private="true"
        noValidate
      >
        <div className="company-form-grid">
          <div data-span={3}>
            <div className="ui-field">
              <label className="ui-label" htmlFor="certificate-pfx">
                Arquivo A1/PFX
              </label>
              <div className="company-file" data-invalid={errors.pfx ? "true" : undefined}>
                <input
                  id="certificate-pfx"
                  name="pfx"
                  type="file"
                  accept=".pfx,.p12"
                  disabled={busy}
                  aria-invalid={errors.pfx ? true : undefined}
                  aria-describedby={[
                    "certificate-pfx-name",
                    "certificate-pfx-help",
                    errors.pfx ? "certificate-pfx-error" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onChange={(event) => {
                    setFileName(event.target.files?.[0]?.name ?? "");
                    setErrors((current) => ({ ...current, pfx: undefined }));
                  }}
                />
                <span className={buttonClass({ size: "sm" })} aria-hidden="true">
                  <Icon name="upload" />
                  Escolher arquivo
                </span>
                <span id="certificate-pfx-name" className="company-file__name">
                  {fileName || "Nenhum arquivo escolhido"}
                </span>
              </div>
              <p id="certificate-pfx-help" className="ui-help">
                Arquivo .pfx ou .p12 de até 256 KiB.
              </p>
              {errors.pfx && (
                <p id="certificate-pfx-error" className="ui-error-text">
                  <Icon name="danger" />
                  <span>{errors.pfx}</span>
                </p>
              )}
            </div>
          </div>
          <div data-span={3}>
            <FormField
              id="certificate-password"
              label="Senha do certificado"
              help="Arquivo e senha são removidos do formulário ao enviar. A senha não pode ser consultada depois."
              error={errors.password}
            >
              <Input
                id="certificate-password"
                name="password"
                type="password"
                autoComplete="new-password"
                disabled={busy}
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={
                  errors.password
                    ? "certificate-password-help certificate-password-error"
                    : "certificate-password-help"
                }
              />
            </FormField>
          </div>
        </div>
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
        <div className="company-form-footer">
          <p
            className="ui-help"
            id={busy ? "certificate-busy" : undefined}
            role={busy ? "status" : undefined}
          >
            {busy
              ? "Aguardando o cofre receber o arquivo. A validação continua na lista abaixo."
              : "A validação acontece no servidor e aparece na lista de versões."}
          </p>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            loadingLabel="Enviando certificado…"
            aria-describedby={busy ? "certificate-busy" : undefined}
          >
            Enviar para validação
          </Button>
        </div>
      </form>
    </Card>
  );
}
const stateTone: Record<Certificate["state"], Tone> = {
  uploading: "warning",
  validating: "warning",
  active: "success",
  rejected: "danger",
  replaced: "neutral",
  revoked: "neutral",
  expired: "danger",
};
function CertificateRow({
  cert,
  org,
  company,
}: {
  cert: Certificate;
  org: Organization;
  company: Company;
}) {
  const revoke = useMutation(api.certificates.revoke);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const [confirming, setConfirming] = useState(false);
  async function deactivate() {
    try {
      await revoke({ organizationId: org.id, companyId: company.id, id: cert.id });
      return "";
    } catch (error) {
      return errorMessage(error);
    }
  }
  const canDeactivate =
    company.capabilities.manage &&
    ["active", "validating", "uploading", "replaced", "expired"].includes(cert.state);
  return (
    <li>
      <div className="company-row__head">
        <p className="company-row__title" ref={titleRef} tabIndex={-1}>
          Versão {cert.version}
          <span role="status">
            <StatusBadge tone={stateTone[cert.state]}>{states[cert.state]}</StatusBadge>
          </span>
        </p>
        {canDeactivate && (
          <>
            <Button size="sm" onClick={() => setConfirming(true)}>
              Desativar versão {cert.version}
            </Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={`Desativar a versão ${cert.version} do certificado?`}
              description={
                cert.state === "active"
                  ? "A empresa fica sem certificado ativo até um novo envio ser validado. O material secreto sai do cofre atual e não pode ser recuperado."
                  : "O material secreto desta versão sai do cofre atual e não pode ser recuperado."
              }
              confirmLabel="Confirmar desativação"
              busyLabel="Desativando…"
              onConfirm={deactivate}
              returnFocusTo={() => titleRef.current}
            />
          </>
        )}
      </div>
      {cert.metadata && (
        <DescriptionList
          items={[
            { term: "Titular", value: <span className="ui-mono">{cert.metadata.cnpj}</span> },
            { term: "Validade", value: new Date(cert.metadata.notAfter).toLocaleString("pt-BR") },
            {
              term: "Fingerprint SHA-256",
              value: <code className="ui-mono">{cert.metadata.fingerprint}</code>,
            },
          ]}
        />
      )}
      {cert.code && (
        <Callout tone="danger">
          {messages[cert.code] ?? "A validação não foi concluída. Envie outro certificado."}
        </Callout>
      )}
    </li>
  );
}
/** The page owns the subscription, so its summary and this list show the same persisted state. */
export function Certificates({
  org,
  company,
  certificates,
}: {
  org: Organization;
  company: Company;
  certificates: UsePaginatedQueryReturnType<typeof api.certificates.list>;
}) {
  const { results, status, loadMore } = certificates;
  if (company.kind === "demonstration") return null;
  return (
    <>
      <Callout tone="info">
        Enviar um certificado não ativa a captura nem comprova autorização fiscal. A conexão será
        configurada separadamente.
      </Callout>
      {company.capabilities.manage ? (
        <Upload org={org} company={company} />
      ) : (
        <p className="ui-help">Somente proprietários e administradores enviam o certificado.</p>
      )}
      <Card
        title="Certificado digital"
        description="Versões enviadas, da mais recente para a mais antiga."
        flush
      >
        {status === "LoadingFirstPage" ? (
          <div className="company-card-pad">
            <SkeletonBlock label="Carregando certificados…" />
          </div>
        ) : results.length === 0 ? (
          <EmptyState
            icon="document"
            title="Nenhum certificado enviado para esta empresa."
            description="Envie o arquivo A1 acima. A versão aparece aqui enquanto o servidor valida."
          />
        ) : (
          <ul className="company-rows">
            {results.map((cert) => (
              <CertificateRow key={cert.id} cert={cert} org={org} company={company} />
            ))}
          </ul>
        )}
        {(status === "CanLoadMore" || status === "LoadingMore") && (
          <div className="company-card-pad">
            <Button
              size="sm"
              loading={status === "LoadingMore"}
              loadingLabel="Carregando mais certificados…"
              onClick={() => loadMore(10)}
            >
              Mais certificados
            </Button>
          </div>
        )}
        <p className="ui-help company-card-foot">
          Desativar impede novos usos e remove o material secreto do cofre atual. Não cancela
          efeitos externos já realizados nem remove cópias em backups retidos.
        </p>
      </Card>
    </>
  );
}
