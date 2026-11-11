import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  canPreview,
  isPrototypeScreen,
  sampleCapture,
  sampleCompany,
  sampleDocument,
  screenContracts,
  type DocumentSummary,
  type MembershipRole,
  type ProductEnvironment,
  type PrototypeScreen,
  type ScreenError,
} from "@freecorps/contracts";
import { Button, buttonClass } from "../ui/button";
import { DataTable } from "../ui/data-table";
import { FormField, Select } from "../ui/form";
import {
  Callout,
  Card,
  DescriptionList,
  Page,
  PageHeader,
  StatusBadge,
  type Tone,
} from "../ui/layout";
import { TabNav, tabLinkClass } from "../ui/tabs";

const errors: Partial<Record<PrototypeScreen, ScreenError>> = {
  onboarding: {
    code: "FIELD_INVALID",
    message: "Confira o nome da organização.",
    fields: { name: "Nome da organização: informe pelo menos dois caracteres." },
    requestId: "demo-onboarding-001",
  },
  importacao: {
    code: "XML_INVALID",
    message: "Não foi possível ler exemplo.xml.",
    fields: {
      file: "O XML contém uma estrutura inválida. Corrija o arquivo antes de enviar novamente.",
    },
    requestId: "demo-import-001",
  },
  documento: {
    code: "UNAVAILABLE",
    message: "Documento temporariamente indisponível.",
    requestId: "demo-document-001",
  },
  empresa: {
    code: "FIELD_INVALID",
    message: "Confira o cadastro da empresa.",
    fields: { cnpj: "CNPJ: informe um identificador válido de 14 posições." },
    requestId: "demo-company-001",
  },
  certificado: {
    code: "CERTIFICATE_EXPIRED",
    message: "Este certificado está expirado.",
    fields: { certificate: "Escolha um certificado vigente da empresa para continuar." },
    requestId: "demo-certificate-001",
  },
  captura: {
    code: "CAPTURE_COOLDOWN",
    message: "Aguarde o intervalo da próxima consulta.",
    retryAt: "10/09/2026, 14:00 · horário de Brasília",
    requestId: "demo-capture-001",
  },
};
const roles: Record<MembershipRole, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  developer: "Desenvolvedor",
  operator: "Operador",
  viewer: "Leitura",
};
function Status({ tone = "neutral", children }: { tone?: Tone; children: string }) {
  return <StatusBadge tone={tone}>{children}</StatusBadge>;
}
function DocumentOrigin({ document }: { document: DocumentSummary }) {
  return (
    <div className="ui-actions">
      <Status>{document.completeness === "full-xml" ? "XML completo" : "Apenas resumo"}</Status>
      <span>
        Fonte:{" "}
        {document.source === "synthetic"
          ? "exemplo sintético"
          : document.source === "import"
            ? "importação"
            : "distribuição SEFAZ"}
      </span>
      <span>
        Situação fiscal:{" "}
        {document.fiscalStatus === "unknown"
          ? "não verificada"
          : document.fiscalStatus === "authorized"
            ? "autorizada"
            : "cancelada"}
      </span>
    </div>
  );
}
function RequestError({ error, onRetry }: { error: ScreenError; onRetry: () => void }) {
  return (
    <Callout
      tone="danger"
      role="alert"
      title={error.message}
      headingLevel={2}
      actions={<Button onClick={onRetry}>Voltar ao exemplo sem erro</Button>}
    >
      {error.fields &&
        Object.entries(error.fields).map(([field, message]) => <p key={field}>{message}</p>)}
      {error.retryAt && <p>Nova tentativa a partir de {error.retryAt}.</p>}
      <p>
        Referência para suporte: <code className="ui-mono">{error.requestId}</code>
      </p>
    </Callout>
  );
}
export function Prototype({
  screen,
  role,
  onRole,
}: {
  screen: string;
  role: MembershipRole;
  onRole: (role: MembershipRole) => void;
}) {
  const [environment, setEnvironment] = useState<ProductEnvironment>("sandbox");
  const [error, setError] = useState(false);
  const [summary, setSummary] = useState(false);
  if (!isPrototypeScreen(screen))
    return (
      <Page>
        <PageHeader
          title="Exemplo não encontrado."
          actions={
            <Link className={buttonClass()} to="/console">
              Voltar ao painel
            </Link>
          }
        />
      </Page>
    );
  const contract = screenContracts[screen];
  const next = (destination: PrototypeScreen, label: string) =>
    canPreview(destination, role) && (
      <Link
        className={buttonClass({ variant: "primary" })}
        to="/console/prototipo/$screen"
        params={{ screen: destination }}
        search={{ role }}
      >
        {label}
      </Link>
    );
  // Cada etapa é um cartão: título, conteúdo e as ações que levam à próxima.
  const step = (title: string, children: ReactNode, actions: ReactNode) => (
    <Card title={title}>
      <div className="ui-form">
        {children}
        <div className="ui-actions">{actions}</div>
      </div>
    </Card>
  );
  return (
    <Page>
      <PageHeader eyebrow={`Exemplo / ${roles[role]}`} title={contract.title} />
      <Callout title="Protótipo navegável">
        <p>Dados sintéticos. Estas ações não criam organizações, documentos ou capturas.</p>
      </Callout>
      <Card>
        <div className="ui-form">
          <FormField id="product-environment" label="Ambiente do produto">
            <Select
              id="product-environment"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as ProductEnvironment)}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production" disabled>
                Produção · indisponível
              </option>
            </Select>
          </FormField>
          <FormField id="preview-role" label="Simular papel na organização">
            <Select
              id="preview-role"
              value={role}
              onChange={(e) => onRole(e.target.value as MembershipRole)}
            >
              {Object.entries(roles).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </Card>
      <TabNav label="Etapas do protótipo">
        {Object.entries(screenContracts)
          .filter(([key]) => canPreview(key as PrototypeScreen, role))
          .map(([key, value]) => (
            <li key={key}>
              <Link
                className={tabLinkClass}
                to="/console/prototipo/$screen"
                params={{ screen: key }}
                search={{ role }}
                aria-current={screen === key ? "page" : undefined}
              >
                {value.title}
              </Link>
            </li>
          ))}
      </TabNav>
      {!canPreview(screen, role) ? (
        <Callout
          tone="warning"
          role="alert"
          title="Esta ação exige outro papel."
          headingLevel={2}
          actions={next("documento", "Consultar documento de exemplo")}
        >
          <p>
            O perfil de leitura consulta documentos. Importação e administração exigem permissões
            específicas.
          </p>
        </Callout>
      ) : (
        <>
          {error && errors[screen] ? (
            <RequestError error={errors[screen]} onRetry={() => setError(false)} />
          ) : (
            <>
              {screen === "onboarding" &&
                step(
                  "Um espaço para sua equipe.",
                  <>
                    <Status tone="success">E-mail verificado</Status>
                    <p>
                      A organização reúne empresas, projetos e permissões. O próximo passo usa a
                      organização fictícia “Equipe Exemplo”.
                    </p>
                    <DescriptionList
                      items={[
                        { term: "Organização de exemplo", value: "Equipe Exemplo" },
                        { term: "Ambiente inicial", value: "Sandbox" },
                      ]}
                    />
                  </>,
                  <>
                    {next("importacao", "Continuar para importação")}
                    {role === "viewer" && next("documento", "Consultar documento de exemplo")}
                  </>,
                )}
              {screen === "importacao" &&
                step(
                  "Experimente com um XML de exemplo.",
                  <>
                    <p>
                      A importação está disponível dentro da sua organização. Aceita até 20 XMLs por
                      lote, com até 2 MiB por arquivo e resultado individual.
                    </p>
                    <DescriptionList
                      items={[
                        { term: "Arquivo", value: <span className="ui-mono">exemplo.xml</span> },
                        { term: "Tipo", value: "NF-e 55 · XML sintético" },
                        { term: "Situação", value: <Status>Exemplo pronto para consulta</Status> },
                      ]}
                    />
                  </>,
                  <>
                    {next("documento", "Abrir resultado de exemplo")}
                    <Link to="/app" className={buttonClass()}>
                      Importar na minha organização
                    </Link>
                  </>,
                )}
              {screen === "documento" &&
                step(
                  "Documento de exemplo",
                  <>
                    <DocumentOrigin
                      document={{
                        ...sampleDocument,
                        completeness: summary ? "summary" : "full-xml",
                      }}
                    />
                    <DescriptionList
                      items={[
                        { term: "Número", value: sampleDocument.number },
                        { term: "Emitente", value: sampleDocument.issuer },
                        {
                          term: "Total informado",
                          value: `R$ ${sampleDocument.total.replace(".", ",")}`,
                        },
                        {
                          term: "Chave de exemplo",
                          value: <span className="ui-mono">{sampleDocument.key}</span>,
                        },
                      ]}
                    />
                    {summary ? (
                      <Callout tone="warning">
                        <p>
                          O resumo não contém o XML completo. Download e itens ficam indisponíveis
                          até obter o documento pela fonte autorizada.
                        </p>
                      </Callout>
                    ) : (
                      <DataTable
                        caption="Itens de demonstração"
                        rows={sampleDocument.items}
                        rowKey={(item) => item.code}
                        columns={[
                          {
                            key: "product",
                            header: "Produto",
                            primary: true,
                            cell: (item) => item.description,
                          },
                          {
                            key: "quantity",
                            header: "Quantidade",
                            align: "end",
                            cell: (item) => item.quantity,
                          },
                          {
                            key: "price",
                            header: "Preço unitário informado",
                            align: "end",
                            cell: (item) => item.unitPrice,
                          },
                        ]}
                      />
                    )}
                  </>,
                  <>
                    <Button onClick={() => setSummary(!summary)}>
                      {summary
                        ? "Exibir exemplo com XML completo"
                        : "Simular documento apenas com resumo"}
                    </Button>
                    {next("empresa", "Explorar jornada de captura")}
                  </>,
                )}
              {screen === "empresa" &&
                step(
                  "Vincule a empresa à organização.",
                  <>
                    <p>
                      O cadastro precisará verificar o vínculo de quem solicita a captura. Neste
                      exemplo, a empresa é fictícia.
                    </p>
                    <DescriptionList
                      items={[
                        { term: "Nome", value: sampleCompany.name },
                        { term: "CNPJ sintético", value: sampleCompany.cnpj },
                        { term: "Certificado", value: "Não cadastrado" },
                      ]}
                    />
                  </>,
                  next("certificado", "Examinar etapa de certificado"),
                )}
              {screen === "certificado" &&
                step(
                  "Certificado A1 da empresa.",
                  <>
                    <p>
                      O fluxo futuro validará titularidade, validade e proteção do certificado antes
                      de permitir a captura. Não há campo de envio de PFX ou senha neste protótipo.
                    </p>
                    <DescriptionList
                      items={[
                        { term: "Empresa", value: sampleCompany.name },
                        {
                          term: "Estado do exemplo",
                          value: <Status tone="warning">Aguardando certificado</Status>,
                        },
                      ]}
                    />
                  </>,
                  next("captura", "Examinar controles de captura"),
                )}
              {screen === "captura" &&
                step(
                  "Controle a sincronização.",
                  <>
                    <Status>
                      {sampleCapture.status === "disabled" ? "Captura desativada" : "Aguardando"}
                    </Status>
                    <p>
                      A primeira captura dependerá de certificado válido, autorização da empresa e
                      limites da SEFAZ. Pausa, recuperação de tarefas e próxima tentativa serão
                      visíveis aqui.
                    </p>
                    <DescriptionList
                      items={[
                        {
                          term: "Última sincronização",
                          value: sampleCapture.lastSuccessAt ?? "Ainda não realizada",
                        },
                        {
                          term: "Próxima tentativa",
                          value: sampleCapture.retryAt ?? "Sem agendamento",
                        },
                        { term: "Integração fiscal", value: "Desativada" },
                      ]}
                    />
                  </>,
                  next("documento", "Ver exemplo de documento capturado"),
                )}
            </>
          )}
          <div className="ui-actions">
            <Button variant="ghost" onClick={() => setError(!error)}>
              {error ? "Ocultar erro de exemplo" : "Simular erro desta etapa"}
            </Button>
            <Link className="ui-link" to="/console">
              Voltar à visão geral
            </Link>
          </div>
        </>
      )}
    </Page>
  );
}
