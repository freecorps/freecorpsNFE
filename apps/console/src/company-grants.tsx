import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { usePaginatedQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { membershipRoleLabels } from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { Button, Card, ConfirmDialog, DataTable, EmptyState, StatusBadge } from "./ui";
import { Feedback, Loading, More, errorText } from "./company-feedback";

// Access of each member to a company: the list and the grant or revocation of a row.

type Company = NonNullable<FunctionReturnType<typeof api.companies.get>>;
type ScopeProps = { org: Organization; contextKey: string };
type CompanyMember = FunctionReturnType<typeof api.companies.members>["page"][number];
function GrantAction({
  org,
  company,
  member,
  nameRef,
}: {
  org: Organization;
  company: Company;
  member: CompanyMember;
  nameRef: React.RefObject<HTMLElement | null>;
}) {
  const setGrant = useMutation(api.companies.setGrant);
  const [busy, setBusy] = useState(false),
    [confirming, setConfirming] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function change(allowed: boolean) {
    setError("");
    setMessage("");
    try {
      await setGrant({
        organizationId: org.id,
        companyId: company.id,
        membershipId: member.membershipId,
        allowed,
        expectedMembershipVersion: member.membershipVersion,
        expectedGrantVersion: member.grantVersion,
      });
      setMessage(allowed ? "Acesso concedido." : "Acesso revogado.");
      return "";
    } catch (error) {
      return errorText(error);
    }
  }
  const busyId = `grant-${member.membershipId}-busy`;
  return (
    <div className="company-row-action">
      {member.inherited ? null : member.granted ? (
        <>
          <Button size="sm" onClick={() => setConfirming(true)}>
            Revogar acesso
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Revogar o acesso de ${member.name} a ${company.name}?`}
            description="A pessoa deixa de ver a empresa e seus documentos imediatamente. Um gestor pode conceder o acesso de novo."
            confirmLabel="Confirmar revogação"
            busyLabel="Revogando…"
            onConfirm={() => change(false)}
            returnFocusTo={() => nameRef.current}
          />
        </>
      ) : (
        <Button
          size="sm"
          loading={busy}
          loadingLabel="Concedendo…"
          aria-describedby={busy ? busyId : undefined}
          onClick={async () => {
            setBusy(true);
            const failure = await change(true);
            setBusy(false);
            setError(failure);
          }}
        >
          Conceder acesso
        </Button>
      )}
      {busy && (
        <p id={busyId} className="ui-visually-hidden" role="status">
          Aguardando a confirmação do servidor.
        </p>
      )}
      <Feedback error={error} message={message} />
    </div>
  );
}
function MemberName({
  member,
  nameRef,
}: {
  member: CompanyMember;
  nameRef: React.Ref<HTMLElement>;
}) {
  return (
    <span className="company-person">
      <strong ref={nameRef} tabIndex={-1}>
        {member.name}
      </strong>
      <span className="ui-mono">{member.email}</span>
    </span>
  );
}
/** One member: the name keeps the focus after a change, so the row owns its ref. */
function useMemberRefs() {
  const refs = useRef(new Map<string, React.RefObject<HTMLElement | null>>());
  return (id: string) => {
    let ref = refs.current.get(id);
    if (!ref) {
      ref = { current: null };
      refs.current.set(id, ref);
    }
    return ref;
  };
}
export function Grants({ org, company, contextKey }: ScopeProps & { company: Company }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.companies.members,
    { organizationId: org.id, companyId: company.id, contextKey },
    { initialNumItems: 20 },
  );
  const refFor = useMemberRefs();
  return (
    <section className="ui-section" aria-labelledby="empresa-acesso-titulo">
      <div className="ui-section__header">
        <h2 id="empresa-acesso-titulo" className="ui-section__title">
          Acesso à empresa
        </h2>
        <p className="ui-section__description">
          O acesso respeita o papel atual de cada pessoa. Proprietários e administradores gerenciam
          todas as empresas da organização.
        </p>
      </div>
      {status === "LoadingFirstPage" ? (
        <Card label="Pessoas">
          <Loading label="Carregando pessoas…" />
        </Card>
      ) : (
        <DataTable
          label="Pessoas com acesso à empresa"
          // Keyed by membership: the row survives a change and keeps the focus and the result.
          rowKey={(member) => member.membershipId}
          rows={results}
          empty={
            <EmptyState
              icon="users"
              title="Nenhuma pessoa na organização."
              description="Convide pessoas em Membros para dar acesso a esta empresa."
            />
          }
          columns={[
            {
              key: "person",
              header: "Pessoa",
              primary: true,
              cell: (member) => (
                <MemberName member={member} nameRef={refFor(member.membershipId)} />
              ),
            },
            {
              key: "role",
              header: "Papel",
              cell: (member) => membershipRoleLabels[member.role],
            },
            {
              key: "access",
              header: "Acesso",
              cell: (member) => (
                <span className="company-access">
                  <StatusBadge tone={member.inherited || member.granted ? "success" : "neutral"}>
                    {member.inherited
                      ? "Pela gestão da organização"
                      : member.granted
                        ? "Concedido"
                        : "Sem acesso"}
                  </StatusBadge>
                  {member.inherited ? (
                    <span className="ui-help">
                      Proprietários e administradores não precisam de concessão.
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              key: "action",
              header: "Ação",
              align: "end",
              cell: (member) =>
                member.inherited ? (
                  <span className="ui-help">Sem ação</span>
                ) : (
                  <GrantAction
                    org={org}
                    company={company}
                    member={member}
                    nameRef={refFor(member.membershipId)}
                  />
                ),
            },
          ]}
        />
      )}
      <More status={status} loadMore={loadMore} label="Mais pessoas" />
    </section>
  );
}
