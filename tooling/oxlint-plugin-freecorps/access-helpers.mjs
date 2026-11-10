// Classificação dos helpers de acesso de platform/convex/lib/, lida pela regra
// require-access-helper-in-convex-functions. Cada função exportada de um
// `lib/*Access.ts` está em `checks` (confere quem chama sobre o tenant) ou em
// `utilities` (auditoria, resumo, leitura sem checagem, gate de ambiente);
// `access-helpers.test.ts` reprova um export novo sem classificação.
//
// `wrappers` são funções fora dos `*Access.ts` que conferem o acesso antes de
// ler: contam como checagem para quem as chama, e a própria regra confere, ao
// lintar o módulo delas, que cada uma chama uma checagem antes do banco.

/** Módulo (relativo a platform/convex, sem extensão) → funções que conferem acesso. */
export const checks = {
  "lib/companyAccess": ["requireCompany"],
  "lib/exportAccess": ["exportAllowed", "exportActor"],
  "lib/operationAccess": [
    "projectAccess",
    "authenticateKey",
    "keyAccess",
    "memberAccess",
    "humanAccess",
  ],
  "lib/organizationAccess": ["requireUser", "requireMembership"],
  "lib/privacyAccess": ["requireMailboxOperator", "mailboxActorAllowed"],
  "lib/projectAccess": ["integrationActor", "requireProject"],
  "lib/stripeAccess": ["connectionAccess"],
  "lib/webhookAccess": [
    "webhookAccess",
    "endpointAccess",
    "keptWebhookAccess",
    "keptEndpointAccess",
    "subscribedAccess",
    "endpointAllowed",
  ],
};

/** Exports dos `*Access.ts` que não conferem quem chama. */
export const utilities = {
  "lib/certificateAccess": [
    "certificateHead",
    "certificateUsable",
    "certificateAudit",
    "certificateSummary",
  ],
  "lib/companyAccess": [
    "cleanText",
    "declaredFields",
    "companyCnpj",
    "summary",
    "findCompany",
    "companyAudit",
    "onboardingState",
    "companyByCnpj",
    "companyHistory",
  ],
  "lib/environmentAccess": [
    "baseEnvironment",
    "environmentServed",
    "environmentOffered",
    "organizationEnvironmentServed",
    "keyEnvironmentServed",
  ],
  "lib/exportAccess": ["assertAssistedDestination", "summarizeExport", "summarizePart"],
  "lib/operationAccess": [
    "requiredScope",
    "environmentPurpose",
    "requireConsoleRecord",
    "originOf",
  ],
  "lib/organizationAccess": [
    "sessionUser",
    "deny",
    "denialCode",
    "findMembership",
    "requireManager",
    "requireOwner",
    "requireRoleGrant",
    "normalizeEmail",
    "organizationName",
    "audit",
    "withdrawMembership",
    "limitOrganizationAction",
    "boundedPagination",
  ],
  "lib/privacyAccess": ["mailboxEmailAllowed"],
  "lib/projectAccess": [
    "consoleProject",
    "ensureConsoleProject",
    "canManageProject",
    "validateScopes",
    "requireGrantableCompany",
    "projectGrant",
    "integrationAudit",
    "summarizeProject",
    "summarizeKey",
    "isConsoleProject",
  ],
  "lib/stripeAccess": [],
  "lib/webhookAccess": ["validateEndpoint"],
};

/** Funções fora dos `*Access.ts` que conferem o acesso antes de ler. */
export const wrappers = {
  "lib/documentCore": ["documentAccess", "loadDocument", "resolveDocumentVersion"],
  "lib/captureCore": ["captureAccess"],
  "lib/issuanceCore": ["issuanceAccess"],
  "lib/importCore": ["importAccess", "getFile"],
  documents: ["getDocument", "documentItems", "documentVersions"],
  imports: ["importDetailPlan"],
  importHistory: ["historyPlan"],
};

/** Categorias aceitas no marcador `// freecorps-access: <categoria> — <motivo>`. */
export const exemptions = {
  "sem-tenant": "lê só a sessão ou a conta de quem chama, sem dado de organização",
  delegada: "repassa a uma função que confere o acesso; o motivo nomeia essa função",
  ticket: "rota HTTP autorizada por um ticket emitido depois da checagem",
  assinatura: "webhook recebido, autenticado pela assinatura do remetente antes de qualquer efeito",
};
