# Referência REST gerada

Gerada por `bun run contracts:generate`. Edite `packages/contracts/src/external.ts`.

| Operação SDK             | Método | Rota                                                | Escopo                               | Retry automático |
| ------------------------ | ------ | --------------------------------------------------- | ------------------------------------ | ---------------- |
| downloadExportPart       | GET    | `/v1/export-download`                               | ticket privado com acesso revalidado | never            |
| uploadImport             | POST   | `/v1/import-upload`                                 | ticket de upload                     | never            |
| downloadOriginal         | GET    | `/v1/document-artifacts/{artifactId}/original`      | documents:read                       | never            |
| downloadDanfe            | GET    | `/v1/documents/{documentId}/danfe`                  | documents:read                       | never            |
| downloadIssuanceArtifact | GET    | `/v1/issuances/{issuanceId}/artifacts/{artifactId}` | documents:issue ou documents:cancel  | never            |
| createExport             | POST   | `/v1/exports`                                       | documents:read                       | idempotent       |
| getExport                | GET    | `/v1/exports/{exportId}`                            | documents:read                       | read             |
| exportParts              | GET    | `/v1/exports/{exportId}/parts`                      | documents:read                       | read             |
| revokeExport             | POST   | `/v1/exports/{exportId}/revoke`                     | documents:read                       | never            |
| exportTicket             | POST   | `/v1/export-parts/{partId}/ticket`                  | documents:read                       | never            |
| controlCapture           | POST   | `/v1/connections/nfe`                               | connections:write                    | never            |
| getCapture               | GET    | `/v1/connections/nfe`                               | connections:read                     | read             |
| getRegistry              | GET    | `/v1/registry/cnpj/{cnpj}`                          | registry:read                        | read             |
| refreshRegistry          | POST   | `/v1/registry/cnpj/{cnpj}/refresh`                  | registry:read                        | idempotent       |
| listMunicipalities       | GET    | `/v1/references/municipalities`                     | references:read                      | read             |
| getMunicipality          | GET    | `/v1/references/municipalities/{code}`              | references:read                      | read             |
| listNcm                  | GET    | `/v1/references/ncm`                                | references:read                      | read             |
| getNcm                   | GET    | `/v1/references/ncm/{code}`                         | references:read                      | read             |
| listCompanies            | GET    | `/v1/companies`                                     | companies:read                       | read             |
| getCompany               | GET    | `/v1/companies/{companyId}`                         | companies:read                       | read             |
| reserveImport            | POST   | `/v1/imports`                                       | documents:import                     | idempotent       |
| getImport                | GET    | `/v1/imports/{importId}`                            | documents:import                     | read             |
| createUpload             | POST   | `/v1/imports/{importId}/files/{fileId}/upload`      | documents:import                     | never            |
| confirmImport            | POST   | `/v1/imports/{importId}/files/{fileId}/confirm`     | documents:import                     | never            |
| reprocessImport          | POST   | `/v1/imports/{importId}/files/{fileId}/reprocess`   | documents:import                     | idempotent       |
| importHistory            | GET    | `/v1/imports/{importId}/files/{fileId}/history`     | documents:import                     | read             |
| getOperation             | GET    | `/v1/operations/{operationId}`                      | escopo da operação                   | read             |
| pauseOperation           | POST   | `/v1/operations/{operationId}/pause`                | escopo da operação                   | never            |
| retryOperation           | POST   | `/v1/operations/{operationId}/retry`                | escopo da operação                   | never            |
| listDocuments            | GET    | `/v1/documents`                                     | documents:read                       | read             |
| getDocument              | GET    | `/v1/documents/{documentId}`                        | documents:read                       | read             |
| documentJson             | GET    | `/v1/documents/{documentId}/json`                   | documents:read                       | read             |
| documentItems            | GET    | `/v1/documents/{documentId}/items`                  | documents:read                       | read             |
| documentEvents           | GET    | `/v1/documents/{documentId}/events`                 | documents:read                       | read             |
| documentVersions         | GET    | `/v1/documents/{documentId}/versions`               | documents:read                       | read             |
| documentFiles            | GET    | `/v1/documents/{documentId}/files`                  | documents:read                       | read             |
| listArtifacts            | GET    | `/v1/document-artifacts`                            | documents:read                       | read             |
| reprocessDocument        | POST   | `/v1/documents/{documentId}/reprocess`              | documents:import                     | idempotent       |
| createIssuance           | POST   | `/v1/issuances`                                     | documents:issue                      | idempotent       |
| listIssuances            | GET    | `/v1/issuances`                                     | documents:issue ou documents:cancel  | read             |
| getIssuance              | GET    | `/v1/issuances/{issuanceId}`                        | documents:issue ou documents:cancel  | read             |
| cancelIssuance           | POST   | `/v1/issuances/{issuanceId}/cancellation`           | documents:cancel                     | idempotent       |
| listWebhookEndpoints     | GET    | `/v1/webhook-endpoints`                             | webhooks:manage                      | read             |
| createWebhookEndpoint    | POST   | `/v1/webhook-endpoints`                             | webhooks:manage                      | never            |
| getWebhookEndpoint       | GET    | `/v1/webhook-endpoints/{endpointId}`                | webhooks:manage                      | read             |
| editWebhookEndpoint      | PATCH  | `/v1/webhook-endpoints/{endpointId}`                | webhooks:manage                      | never            |
| rotateWebhookSecret      | POST   | `/v1/webhook-endpoints/{endpointId}/rotate-secret`  | webhooks:manage                      | never            |
| testWebhookEndpoint      | POST   | `/v1/webhook-endpoints/{endpointId}/test`           | webhooks:manage                      | idempotent       |
| listWebhookDeliveries    | GET    | `/v1/webhook-deliveries`                            | webhooks:manage                      | read             |
| retryWebhookDelivery     | POST   | `/v1/webhook-deliveries/{deliveryId}/retry`         | webhooks:manage                      | idempotent       |
| getCapabilities          | GET    | `/v1/capabilities`                                  | chave válida                         | read             |

Schemas completos, opcionais, limites e respostas estão em [openapi.json](openapi.json).
