/**
 * Rótulos em pt-BR para a trilha de `operationalAudit`. O servidor grava códigos estáveis
 * (`operation.TRANSPORT_UNCERTAIN`, `export.requested`); a tela mostra o rótulo e mantém o
 * código bruto em detalhe técnico. Um código desconhecido aparece como está, nunca some.
 */
const actions: Record<string, string> = {
  "organization.created": "Organização criada",
  "organization.updated": "Organização atualizada",
  "organization.closure-requested": "Encerramento da organização solicitado",
  "organization.terms-accepted": "Termos de uso aceitos",
  "organization.kept-active": "Organização mantida ativa",
  "member.role-changed": "Papel de membro alterado",
  "member.removed": "Membro removido",
  "member.joined": "Membro entrou na organização",
  "invitation.created": "Convite criado",
  "invitation.revoked": "Convite revogado",
  "invitation.sent": "Convite enviado",
  "invitation.delivery-failed": "Falha no envio do convite",
  "company.created": "Empresa cadastrada",
  "company.updated": "Empresa atualizada",
  "company.deleted": "Empresa excluída",
  "company.registry_applied": "Sugestão cadastral confirmada",
  "company.granted": "Acesso à empresa concedido",
  "company.revoked": "Acesso à empresa revogado",
  "company.nfse_profile_created": "Perfil NFS-e criado",
  "company.nfse_profile_updated": "Perfil NFS-e atualizado",
  "company.nfse_dps_start_set": "Numeração inicial da DPS definida",
  "project.created": "Projeto criado",
  "project.updated": "Projeto atualizado",
  "project.company.granted": "Empresa concedida ao projeto",
  "project.company.revoked": "Empresa retirada do projeto",
  "key.created": "Chave de API criada",
  "key.revoked": "Chave de API revogada",
  "key.rotated": "Chave de API rotacionada",
  "webhook.created": "Webhook criado",
  "webhook.updated": "Webhook atualizado",
  "webhook.rotated": "Segredo do webhook rotacionado",
  "webhook.test": "Teste de webhook enviado",
  "webhook.retried": "Entrega de webhook reenviada",
  "webhook.attempt": "Tentativa de entrega de webhook",
  "monitor.configured": "Monitor configurado",
  "monitor.removed": "Monitor removido",
  "monitor.access_revoked": "Monitor pausado por perda de acesso",
  "alert.open": "Alerta aberto",
  "alert.recovered": "Alerta recuperado",
  "export.requested": "Exportação solicitada",
  "export.succeeded": "Exportação pronta",
  "export.failed": "Exportação falhou",
  "export.revoked": "Exportação revogada",
  "export.downloaded": "Parte da exportação baixada",
  "issuance.accepted": "Emissão NFS-e aceita",
  "issuance.authorized": "NFS-e autorizada",
  "issuance.rejected": "NFS-e rejeitada",
  "issuance.cancel_requested": "Cancelamento de NFS-e solicitado",
  "issuance.cancelled": "NFS-e cancelada",
  "issuance.cancel_rejected": "Cancelamento de NFS-e recusado",
  "issuance.production_enabled": "Emissão em produção liberada",
  "issuance.production_disabled": "Emissão em produção bloqueada",
  "proof.sealed": "Prova operacional registrada",
  "http.rateLimited": "Chamada à API recusada pelo limite de requisições",
  "http.importUpload": "Envio de arquivo para importação",
  "http.documentDownload": "Download de documento",
  "http.danfeDownload": "Download de DANFE",
  "certificate.validation": "Validação do certificado",
  "certificate.rotation": "Certificado substituído",
  "certificate.expiration": "Certificado expirado",
  "certificate.revocation": "Certificado revogado",
  "capture.activated": "Captura ativada",
  "capture.sync": "Consulta de captura solicitada",
  "capture.pause": "Captura pausada",
  "capture.resume": "Captura retomada",
  "capture.checkpoint_committed": "Captura avançou o ponto de leitura",
  "capture.transfer_authorized": "Transferência da captura autorizada",
  "capture.transfer_received": "Transferência da captura recebida",
  "capture.transfer_released": "Transferência da captura liberada",
  "capture.proof_step_complete": "Etapa da prova de captura concluída",
  "capture.fiscal_released": "Captura fiscal ativada",
  "capture.fiscal_withdrawn": "Captura fiscal desativada",
  "capture.fiscal_unblocked": "Captura fiscal desbloqueada pela Freecorps",
  "capture.fiscal_interval_changed": "Intervalo mínimo da captura fiscal alterado",
  "capture.fiscal_terms_accepted": "Novos termos da captura fiscal aceitos",
  "capture.terms_deferred": "Consulta adiada até o aceite dos novos termos",
  "capture.interval_postponed": "Próxima consulta adiada pelo novo intervalo",
};
/** Etapas e desfechos de uma operação; o mesmo código aparece em `row.code`. */
const operationSteps: Record<string, string> = {
  accepted: "Operação aceita",
  continued: "Operação continuada em nova etapa",
  succeeded: "Operação concluída",
  retry_requested: "Retomada solicitada",
};
const codes: Record<string, string> = {
  PAUSED_BY_USER: "Pausada por uma pessoa",
  MANUAL_RETRY: "Nova tentativa após retomada manual",
  MANUAL_RECONCILE: "Reconciliação após retomada manual",
  CAPTURE_DOCUMENT_RESUMED: "Processamento do documento recebido retomado",
  TRANSPORT_UNCERTAIN: "Resultado do envio incerto; será reconciliado",
  DELIVERY_UNCERTAIN: "Entrega incerta; será reconciliada",
  SOURCE_RESULT_UNCERTAIN: "Resultado da fonte incerto; será reconciliado",
  REGISTRY_RESULT_UNKNOWN: "Resultado da consulta cadastral incerto",
  RECONCILIATION_REQUIRED: "Pausada: precisa de reconciliação",
  RECONCILIATION_UNAVAILABLE: "Reconciliação indisponível no momento",
  RECONCILIATION_INCOMPLETE: "Reconciliação incompleta",
  ATTEMPTS_EXHAUSTED: "Pausada: tentativas esgotadas",
  RECOVERY_BUDGET_EXHAUSTED: "Pausada: recuperações esgotadas",
  EXECUTION_LOST: "Execução interrompida; será recuperada",
  ACCESS_REVOKED: "Interrompida por perda de acesso",
  FISCAL_TRANSPORT_DISABLED: "Transporte fiscal desligado neste ambiente",
  ISSUANCE_TRANSPORT_DISABLED: "Transporte de emissão desligado neste ambiente",
  CERTIFICATE_UNAVAILABLE: "Certificado indisponível",
  CERTIFICATE_CHANGED: "Certificado renovado; nova tentativa em instantes",
  CERTIFICATE_TIMEOUT: "Certificado sem resposta a tempo",
  SOURCE_HTTP_ERROR: "A fonte respondeu com erro",
  SOURCE_RESPONSE_INVALID: "A fonte respondeu em formato inválido",
  SOURCE_COOLDOWN: "Aguardando a janela da fonte",
  CAPTURE_FISCAL_HALTED: "Captura fiscal parada pela Freecorps",
  CAPTURE_TERMS_PENDING: "Captura fiscal aguardando o aceite dos novos termos",
  QUOTA_EXCEEDED: "Limite do plano atingido",
  PLAN_INACTIVE: "Plano fora da vigência",
  PLAN_REQUIRED: "Operação sem plano com cotas atribuídas",
  TERMS_OF_USE_REQUIRED: "Termos de uso em vigor ainda não aceitos",
  CAPACITY_INVENTORY_REQUIRED: "Inventário de capacidade pendente",
  ORGANIZATION_ARCHIVED: "Organização em arquivo econômico",
  TASK_FAILED: "Falha definitiva da tarefa",
  INVALID_FILE: "Arquivo inválido",
  DUPLICATE: "Documento já importado",
  NO_DOCUMENTS: "Nenhum documento no arquivo",
  CORRELATION_INCOMPLETE: "Evento sem operação vinculada",
  SWEEP_CONTINUES: "Aguardando o início dos reprocessamentos da página para ler a próxima",
};
const families: Record<string, string> = {
  operation: "Operação",
  capture: "Captura",
  certificate: "Certificado",
  http: "Chamada à API",
};
/** Rótulo de um código de erro/estado, ou o próprio código quando não há tradução. */
export function codeLabel(code: string) {
  return codes[code] ?? code;
}
export function actionLabel(action: string) {
  const known = actions[action];
  if (known) return known;
  const dot = action.indexOf(".");
  const family = dot < 0 ? "" : action.slice(0, dot),
    rest = dot < 0 ? action : action.slice(dot + 1);
  if (family === "operation") return operationSteps[rest] ?? codes[rest] ?? action;
  if (families[family] && codes[rest]) return `${families[family]}: ${codes[rest]}`;
  return action;
}
/** Rótulo genérico do ator quando o servidor não resolve o nome nesta organização. */
export function actorFallback(actor: string) {
  if (actor === "system") return "Sistema (automático)";
  if (actor === "redacted") return "Não registrado";
  if (actor === "upload-ticket") return "Envio autorizado por ticket";
  if (actor.startsWith("key:")) return "Chave de API";
  if (actor.startsWith("operator:")) return "Equipe Freecorps";
  // Membros aparecem como `membership:`, `member:`, `user:` ou o id puro do Convex/Better Auth.
  if (/^(membership|member|user):/.test(actor) || /^[a-z0-9]{31,37}$/.test(actor))
    return "Membro da organização";
  return actor;
}
export function actorLabel(actor: string, name: string | undefined) {
  if (!name) return actorFallback(actor);
  return actor.startsWith("key:") ? `Chave de API “${name}”` : name;
}
