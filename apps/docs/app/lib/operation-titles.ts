import type * as External from "@freecorps/contracts/external";

// Portuguese titles of the API reference pages and sidebar, keyed by the
// operationId of the contract. The mapped type fails type checking when the
// contract gains an operation without a title; openapi.server.ts also refuses
// at build time a contract operation missing here or a title for one that left.
type Transfers = typeof External.transferPaths;
type TransferId = {
  [P in keyof Transfers]: {
    [M in keyof Transfers[P]]: Transfers[P][M] extends { operationId: infer I } ? I : never;
  }[keyof Transfers[P]];
}[keyof Transfers];
export type OperationId = External.RouteName | TransferId;

export const operationTitles: { [K in OperationId]: string } = {
  listDocuments: "Listar documentos",
  getDocument: "Consultar documento",
  documentJson: "Documento em JSON",
  documentItems: "Itens do documento",
  documentEvents: "Eventos do documento",
  documentVersions: "Versões do documento",
  documentFiles: "Arquivos do documento",
  downloadOriginal: "Baixar XML original",
  downloadDanfe: "Baixar DANFE",
  listArtifacts: "Listar artefatos",
  reprocessDocument: "Reprocessar documento",
  reserveImport: "Reservar importação",
  getImport: "Consultar importação",
  createUpload: "Criar ticket de envio",
  uploadImport: "Enviar arquivo",
  confirmImport: "Confirmar arquivo",
  reprocessImport: "Reprocessar arquivo",
  importHistory: "Histórico do arquivo",
  getOperation: "Consultar operação",
  pauseOperation: "Pausar operação",
  retryOperation: "Repetir operação",
  createIssuance: "Emitir NFS-e",
  listIssuances: "Listar emissões",
  getIssuance: "Consultar emissão",
  cancelIssuance: "Cancelar NFS-e",
  downloadIssuanceArtifact: "Baixar arquivo da emissão",
  listWebhookEndpoints: "Listar destinos",
  createWebhookEndpoint: "Criar destino",
  getWebhookEndpoint: "Consultar destino",
  editWebhookEndpoint: "Editar destino",
  rotateWebhookSecret: "Rotacionar segredo",
  testWebhookEndpoint: "Testar destino",
  listWebhookDeliveries: "Listar entregas",
  retryWebhookDelivery: "Reenviar entrega",
  createExport: "Criar exportação",
  getExport: "Consultar exportação",
  exportParts: "Listar partes da exportação",
  revokeExport: "Revogar exportação",
  exportTicket: "Gerar ticket de download",
  downloadExportPart: "Baixar parte da exportação",
  controlCapture: "Controlar captura de NF-e",
  getCapture: "Consultar captura de NF-e",
  listCompanies: "Listar empresas",
  getCompany: "Consultar empresa",
  getRegistry: "Consultar cadastro de CNPJ",
  refreshRegistry: "Atualizar cadastro de CNPJ",
  listMunicipalities: "Listar municípios",
  getMunicipality: "Consultar município",
  listNcm: "Listar NCM",
  getNcm: "Consultar NCM",
  getCapabilities: "Consultar capacidades",
};
