import { useState } from "react";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  CursorPager,
  DataTable,
  DescriptionList,
  DisabledReason,
  Disclosure,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Menu,
  MenuGroup,
  MenuItem,
  MenuRadioItem,
  MenuSeparator,
  Page,
  PageHeader,
  Progress,
  RadioCard,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  controlProps,
  firstPage,
  type PageCursor,
} from "./ui";
import { EnvironmentStamp } from "./environment-stamp";
import { ProductionNote } from "./issuance-production";

/**
 * Referência interna dos componentes (só no desenvolvimento, `/console/componentes`): todos os
 * componentes nos dois temas, com dados de exemplo ou o pior caso realista (nomes no limite do
 * servidor, e-mail sem quebra, contagens 1 e grandes, lista vazia). Dados sintéticos.
 */
type Dataset = "exemplo" | "pior";
type Row = { id: string; company: string; document: string; total: string; status: string };
const data: Record<
  Dataset,
  {
    organization: string;
    person: string;
    email: string;
    company: string;
    cnpj: string;
    rows: Row[];
    members: number;
    reason: string;
  }
> = {
  exemplo: {
    organization: "Equipe Ipê",
    person: "Ana Sintética",
    email: "ana@development.invalid",
    company: "Ipê Serviços Ltda",
    cnpj: "12.345.678/0001-90",
    rows: [
      {
        id: "1",
        company: "Ipê Serviços Ltda",
        document: "NFS-e 101",
        total: "R$ 1.250,00",
        status: "Autorizada",
      },
      {
        id: "2",
        company: "Ipê Serviços Ltda",
        document: "NFS-e 102",
        total: "R$ 980,40",
        status: "Em processamento",
      },
      {
        id: "3",
        company: "Jatobá Consultoria",
        document: "NFS-e 7",
        total: "R$ 12.000,00",
        status: "Rejeitada",
      },
    ],
    members: 3,
    reason: "Envie o certificado A1 da empresa para emitir.",
  },
  pior: {
    // 80 caracteres: o limite do nome da organização no servidor.
    organization: "Cooperativa Agroindustrial dos Produtores Rurais do Vale do Jequitinhonha Ltda",
    person: "Aleksandra Wiśniewska-Kowalczyk de Albuquerque Cavalcanti",
    email: "bartholomew.fitzgerald@northwind-industries-holdings.development.invalid",
    company: "Sociedade Brasileira de Engenharia, Arquitetura e Planejamento Urbano Ltda",
    cnpj: "12.ABC.345/01DE-35",
    rows: [
      {
        id: "1",
        company: "Sociedade Brasileira de Engenharia, Arquitetura e Planejamento Urbano Ltda",
        document: "NFS-e 000000123456789",
        total: "R$ 1.234.567.890,12",
        status: "Em reconciliação com o fisco",
      },
      { id: "2", company: "Jo", document: "NFS-e 1", total: "R$ 0,01", status: "Autorizada" },
      {
        id: "3",
        company: "Ação & Cia — Serviços Técnicos",
        document: "NFS-e 99",
        total: "R$ 0,00",
        status: "Cancelada",
      },
    ],
    members: 1,
    reason:
      "Indisponível enquanto a consulta anterior não termina. A próxima consulta permitida é às 14:00 (horário de Brasília); o botão se libera sozinho nesse horário.",
  },
};
const tone = (status: string) =>
  status.startsWith("Autoriz")
    ? "success"
    : status.startsWith("Rejeit")
      ? "danger"
      : status.startsWith("Cancel")
        ? "neutral"
        : "warning";

const swatches = [
  "--color-bg",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-selected",
  "--color-text",
  "--color-text-muted",
  "--color-border",
  "--color-border-strong",
  "--color-primary",
  "--color-focus",
  "--color-success",
  "--color-warning",
  "--color-danger",
  "--color-info",
] as const;

function Gallery({ theme, dataset }: { theme: "light" | "dark"; dataset: Dataset }) {
  const sample = data[dataset];
  const [tab, setTab] = useState("resumo");
  const [cursor, setCursor] = useState<PageCursor>(firstPage);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState(dataset === "pior");
  const prefix = `${theme}-${dataset}`;
  return (
    <section className="reference-theme" data-theme={theme} aria-labelledby={`${prefix}-title`}>
      <h2 id={`${prefix}-title`} className="reference-theme__title">
        Tema {theme === "light" ? "claro" : "escuro"}
      </h2>

      <Card title="Tokens" description="Cores semânticas, tipografia, raios e elevação.">
        <div className="ui-stack">
          <div className="reference-swatches">
            {swatches.map((token) => (
              <figure key={token} className="reference-swatch">
                <span style={{ background: `var(${token})` }} />
                <figcaption className="ui-mono">{token.replace("--color-", "")}</figcaption>
              </figure>
            ))}
          </div>
          <div className="reference-type">
            <p style={{ fontSize: "var(--text-2xl)", fontWeight: 600 }}>Título da página 28</p>
            <p style={{ fontSize: "var(--text-xl)", fontWeight: 600 }}>Seção ou número 20</p>
            <p style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}>Título de cartão 16</p>
            <p style={{ fontSize: "var(--text-md)" }}>Corpo e controles 14</p>
            <p style={{ fontSize: "var(--text-sm)" }}>Navegação, tabelas e ajuda 13</p>
            <p style={{ fontSize: "var(--text-xs)" }}>Rótulos e selos 12</p>
            <p className="ui-mono">35260912345678000190550010000001231234567890</p>
          </div>
          <div className="reference-row">
            <Card flat>Plano (anel)</Card>
            <Card>Cartão</Card>
            <div className="reference-float">Flutuante</div>
          </div>
        </div>
      </Card>

      <div className="reference-grid">
        <Card title="Botões">
          <div className="ui-stack">
            <div className="reference-row">
              <Button variant="primary" icon="plus">
                Nova emissão
              </Button>
              <Button>Secundário</Button>
              <Button variant="ghost">Discreto</Button>
              <Button variant="danger">Revogar</Button>
              <Button variant="link">Abrir documento</Button>
            </div>
            <div className="reference-row">
              <Button variant="primary" size="sm">
                Pequeno
              </Button>
              <Button size="lg">Grande</Button>
              <Button variant="primary" loading loadingLabel="Salvando…">
                Salvar
              </Button>
              <IconButton icon="settings" label="Configurações" variant="secondary" />
            </div>
            <div className="ui-stack">
              <Button variant="primary" disabled aria-describedby={`${prefix}-reason`}>
                Sincronizar
              </Button>
              <DisabledReason id={`${prefix}-reason`}>{sample.reason}</DisabledReason>
            </div>
          </div>
        </Card>

        <Card title="Situação e avisos">
          <div className="ui-stack">
            <div className="reference-row">
              <StatusBadge>Neutro</StatusBadge>
              <StatusBadge tone="success">Autorizada</StatusBadge>
              <StatusBadge tone="warning">
                {dataset === "pior" ? "Em reconciliação com o fisco" : "Pendente"}
              </StatusBadge>
              <StatusBadge tone="danger">Rejeitada</StatusBadge>
              <StatusBadge tone="info">Sandbox</StatusBadge>
            </div>
            <Callout tone="info" title="Sandbox, sem validade fiscal">
              <p>As emissões usam transporte simulado.</p>
            </Callout>
            <Callout tone="success">
              <p>Certificado ativo e dentro da validade.</p>
            </Callout>
            <Callout
              tone="warning"
              title="Certificado vencendo"
              actions={<Button size="sm">Enviar novo certificado</Button>}
            >
              <p>{sample.company} · vence em 20/10/2026.</p>
            </Callout>
            <Callout tone="danger" title="Emissão rejeitada">
              <p>Código E0042: a alíquota informada não corresponde ao município.</p>
            </Callout>
          </div>
        </Card>
      </div>

      <Card
        title={sample.company}
        description="Rótulo e valor, em tabela leve."
        actions={<CopyButton value={sample.cnpj} label="Copiar CNPJ" />}
      >
        <DescriptionList
          items={[
            { term: "CNPJ", value: <span className="ui-mono">{sample.cnpj}</span> },
            { term: "Organização", value: sample.organization },
            { term: "Responsável", value: `${sample.person} · ${sample.email}` },
            { term: "Situação", value: <StatusBadge tone="success">Conectada</StatusBadge> },
            {
              term: "Membros",
              value: sample.members === 1 ? "1 membro" : `${sample.members} membros`,
            },
          ]}
        />
      </Card>

      <section className="ui-section" aria-labelledby={`${prefix}-table`}>
        <div className="ui-section__header">
          <h3 id={`${prefix}-table`} className="ui-section__title">
            Tabela (vira cartões no telefone)
          </h3>
        </div>
        <DataTable
          label="Emissões de exemplo"
          rows={sample.rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "document", header: "Documento", primary: true, cell: (row) => row.document },
            { key: "company", header: "Empresa", cell: (row) => row.company },
            {
              key: "status",
              header: "Situação",
              cell: (row) => <StatusBadge tone={tone(row.status)}>{row.status}</StatusBadge>,
            },
            { key: "total", header: "Total", align: "end", cell: (row) => row.total },
          ]}
        />
        <CursorPager
          label="Páginas de emissões"
          cursor={cursor}
          nextCursor={cursor.previous.length < 2 ? `p${cursor.previous.length + 1}` : null}
          onChange={setCursor}
        />
      </section>

      <div className="reference-grid">
        <Card title="Formulário">
          <form className="ui-form" noValidate onSubmit={(event) => event.preventDefault()}>
            <FormField
              id={`${prefix}-name`}
              label="Razão social"
              help="Como está no cadastro da Receita."
            >
              <Input
                {...controlProps(`${prefix}-name`, undefined, true)}
                defaultValue={sample.company}
              />
            </FormField>
            <FormField
              id={`${prefix}-cnpj`}
              label="CNPJ"
              error={error ? "Confira o CNPJ: 14 posições, letras ou números." : undefined}
            >
              <Input
                {...controlProps(`${prefix}-cnpj`, error ? "erro" : undefined)}
                className="ui-mono"
                defaultValue={sample.cnpj}
              />
            </FormField>
            <FormField id={`${prefix}-regime`} label="Regime tributário">
              <Select id={`${prefix}-regime`} defaultValue="simples">
                <option value="simples">Simples Nacional</option>
                <option value="presumido">Lucro presumido</option>
                <option value="real">Lucro real</option>
              </Select>
            </FormField>
            <FormField id={`${prefix}-note`} label="Observação" optional>
              <Textarea id={`${prefix}-note`} placeholder="Aparece no detalhe da emissão." />
            </FormField>
            <Checkbox
              checked={error}
              onChange={(event) => setError(event.target.checked)}
              label="Mostrar o erro do campo"
              help="Liga aria-invalid e a mensagem do CNPJ."
            />
            <div role="radiogroup" aria-label="Mercado" className="ui-choice-group">
              <RadioCard
                name={`${prefix}-market`}
                value="domestic"
                defaultChecked
                label="Mercado interno"
                help="Tomador no Brasil, valor em reais."
              />
              <RadioCard
                name={`${prefix}-market`}
                value="export"
                label="Exportação de serviço"
                help="Tomador no exterior, moeda estrangeira, sem ISS."
              />
            </div>
            <div className="ui-actions">
              <Button type="submit" variant="primary">
                Salvar cadastro
              </Button>
              <Button variant="ghost">Cancelar</Button>
            </div>
          </form>
        </Card>

        <div className="ui-stack">
          <Card title="Abas, menu e confirmação">
            <div className="ui-stack">
              <Tabs
                label="Seções da empresa"
                value={tab}
                onValueChange={setTab}
                tabs={[
                  {
                    id: "resumo",
                    label: "Resumo",
                    content: <p className="ui-help">Situação e cadastro.</p>,
                  },
                  {
                    id: "fiscal",
                    label: "Fiscal",
                    content: <p className="ui-help">Perfil NFS-e.</p>,
                  },
                  {
                    id: "certificado",
                    label: "Certificado",
                    content: <p className="ui-help">A1 da empresa.</p>,
                  },
                ]}
              />
              <div className="reference-row">
                <Menu triggerClassName="ui-button ui-button--secondary" trigger={<>Ações</>}>
                  <MenuGroup label="Empresa">
                    <MenuItem icon="copy" onSelect={() => undefined}>
                      Copiar CNPJ
                    </MenuItem>
                    <MenuRadioItem checked onSelect={() => undefined}>
                      {sample.company}
                    </MenuRadioItem>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuItem icon="logout" onSelect={() => undefined}>
                    Desativar certificado
                  </MenuItem>
                </Menu>
                <Button variant="danger" onClick={() => setDialog(true)}>
                  Revogar acesso
                </Button>
              </div>
              <ConfirmDialog
                open={dialog}
                onOpenChange={setDialog}
                title="Revogar o acesso de Ana?"
                description={`${sample.person} deixa de ver os documentos de ${sample.company}.`}
                confirmLabel="Revogar acesso"
                busyLabel="Revogando…"
                onConfirm={() => new Promise((resolve) => setTimeout(() => resolve(""), 600))}
              />
            </div>
          </Card>
          <Card
            title="Produção fiscal"
            description="Selos do ambiente (sandbox, produção fiscal, produção sem emissão e produção ainda não confirmada) e a nota da tela de emissão com o gate liberado e desligado. As telas usam estes mesmos componentes."
          >
            <div className="ui-stack">
              <p className="app-env">
                <EnvironmentStamp label="Local" />
              </p>
              <p className="app-env">
                <EnvironmentStamp
                  label="Instalação"
                  deployment={{
                    environment: "production",
                    fiscalProduction: true,
                    confirmed: true,
                  }}
                />
              </p>
              <p className="app-env">
                <EnvironmentStamp
                  label="Validação"
                  deployment={{
                    environment: "production",
                    fiscalProduction: false,
                    confirmed: true,
                  }}
                />
              </p>
              <p className="app-env">
                <EnvironmentStamp
                  label="Instalação"
                  deployment={{
                    environment: "production",
                    fiscalProduction: false,
                    confirmed: false,
                  }}
                />
              </p>
              <ProductionNote gate={{ open: true, since: Date.UTC(2026, 9, 8, 15) }} />
              <ProductionNote gate={{ open: false, since: null }} />
            </div>
          </Card>
          <Card title="Carregando">
            <div className="ui-stack" aria-hidden="true">
              <Skeleton width="40%" height={16} />
              <Skeleton />
              <Skeleton width="80%" />
            </div>
          </Card>
          <Card title="Detalhes técnicos">
            <div className="ui-stack">
              <Progress value={60} label={`Envio de ${sample.company}.xml`} />
              <Disclosure summary="Evidências da situação fiscal">
                <CodeBlock label="JSON de exemplo">
                  {JSON.stringify({ reportedStatus: "authorized", key: sample.cnpj }, null, 2)}
                </CodeBlock>
              </Disclosure>
            </div>
          </Card>
        </div>
      </div>

      <EmptyState
        headingLevel={3}
        title="Nenhuma importação ainda"
        description="Envie XML de NF-e modelo 55 para ver itens, totais e o JSON de cada nota."
        actions={
          <>
            <Button variant="primary" icon="upload">
              Importar XML
            </Button>
            <Button>Ver exemplo</Button>
          </>
        }
      />
    </section>
  );
}

export function ComponentReference() {
  const [dataset, setDataset] = useState<Dataset>(() =>
    new URLSearchParams(window.location.search).get("dados") === "pior" ? "pior" : "exemplo",
  );
  function choose(next: Dataset) {
    setDataset(next);
    const url = new URL(window.location.href);
    if (next === "pior") url.searchParams.set("dados", "pior");
    else url.searchParams.delete("dados");
    window.history.replaceState(window.history.state, "", url);
  }
  return (
    <Page>
      <PageHeader
        eyebrow="Desenvolvimento"
        title="Componentes"
        description="Referência interna do sistema visual: tokens e componentes base nos dois temas. Só existe no desenvolvimento; dados sintéticos."
        actions={
          <div className="reference-toggle" role="group" aria-label="Dados da referência">
            <Button
              size="sm"
              variant={dataset === "exemplo" ? "primary" : "secondary"}
              aria-pressed={dataset === "exemplo"}
              onClick={() => choose("exemplo")}
            >
              Dados de exemplo
            </Button>
            <Button
              size="sm"
              variant={dataset === "pior" ? "primary" : "secondary"}
              aria-pressed={dataset === "pior"}
              onClick={() => choose("pior")}
            >
              Pior caso
            </Button>
          </div>
        }
      />
      <Gallery key={`light-${dataset}`} theme="light" dataset={dataset} />
      <Gallery key={`dark-${dataset}`} theme="dark" dataset={dataset} />
    </Page>
  );
}
