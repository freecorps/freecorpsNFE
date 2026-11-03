/**
 * Result codes of the import, in the person's words. The code stays as a detail for support;
 * a code missing here is shown as an unknown failure with the code, never as success.
 */
export const importCodeMessages: Record<string, string> = {
  IMPORTED: "Importado",
  NFSE_BATCH_IMPORTED: "Lote de NFS-e importado",
  DUPLICATE: "Nota já importada antes; nada foi duplicado",
  ARTIFACT_CONFLICT:
    "Outro XML da mesma nota já existe; este foi preservado para conferência e a versão publicada não mudou",
  COMPANY_MISMATCH: "O XML não identifica esta empresa como emitente ou destinatária",
  IDENTITY_INVALID: "A chave ou a identidade fiscal do XML não confere com o conteúdo",
  XML_MALFORMED: "O arquivo não é um XML bem formado (está truncado ou corrompido)",
  XML_UNSAFE: "O XML usa DTD ou entidades, recusados por segurança",
  XML_TOO_LARGE: "O XML passa do limite de 2 MiB",
  XML_LIMIT_EXCEEDED: "O XML passa dos limites de profundidade ou de quantidade de elementos",
  XML_ENCODING_INVALID: "A codificação de caracteres do XML é inválida",
  XML_ENCODING_UNSUPPORTED: "A codificação de caracteres do XML não é suportada; use UTF-8",
  XML_INPUT_INVALID: "O conteúdo enviado não é um XML",
  XML_SOURCE_INVALID: "A origem do XML não é aceita",
  XML_UNSUPPORTED: "Formato de XML não reconhecido",
  XML_NAMESPACE_UNSUPPORTED: "Formato de XML não reconhecido (namespace desconhecido)",
  XML_SCHEMA_UNSUPPORTED: "Versão do leiaute não suportada",
  XML_MODEL_UNSUPPORTED: "Modelo de documento não suportado (só NF-e modelo 55)",
  XML_EVENT_UNSUPPORTED: "Tipo de evento não suportado",
  XML_FIELD_INVALID: "Um campo obrigatório está ausente ou inválido",
  XML_DECIMAL_INVALID: "Um valor decimal do XML é inválido",
  XML_DUPLICATE_ID: "O XML repete um identificador",
  XML_DUPLICATE_ITEM: "O XML repete o número de um item",
  XML_PROCESSING_INSTRUCTION_UNSUPPORTED: "O XML tem instruções de processamento não aceitas",
  XML_PROCESSING_FAILED: "Não foi possível ler o XML",
  NFSE_LAYOUT_UNSUPPORTED: "Leiaute de NFS-e ainda não suportado",
  NFSE_BATCH_LIMIT: "O lote deve conter de 1 a 20 NFS-e",
  NFSE_DUPLICATE_IDENTITY: "O lote repete a identidade de uma NFS-e",
  NFSE_FIELD_INVALID: "NFS-e com campo obrigatório ausente ou inválido",
  RESULT_TOO_LARGE: "O resultado passa do limite de tamanho da importação",
  PROCESSOR_UNSUPPORTED: "Versão de processamento não suportada",
  ORIGINAL_UNAVAILABLE: "O original enviado não está mais disponível",
  ORIGINAL_HASH_MISMATCH: "O original armazenado não confere com o enviado",
  ACCESS_REVOKED: "O acesso à empresa mudou durante o processamento",
  PROCESSING_CHANGED: "O processamento mudou durante a retomada",
  NOTES_QUOTA_EXCEEDED:
    "As NFS-e novas do lote passam do limite de notas novas do mês em Produção; nenhuma foi gravada. Importe o lote de novo quando houver saldo.",
};
