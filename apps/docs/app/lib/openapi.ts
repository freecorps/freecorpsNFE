// Shared by the prerender list (react-router.config.ts, plain Node) and the
// API reference pages (openapi.server.ts): one page per operation of the
// versioned contract, at /docs/api/<operationId in lower case>.
export type Spec = {
  paths: Record<string, Record<string, { operationId: string }>>;
};

export const apiSlug = (operationId: string) => operationId.toLowerCase();

export function apiOperations(spec: Spec) {
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method, operationId: op.operationId })),
  );
}

// Sidebar groups by the first path segment. A segment missing here still
// gets its pages, under its own name, so a new resource never disappears.
const groups: [string, string[]][] = [
  ["Documentos", ["documents", "document-artifacts"]],
  ["Importação", ["imports", "import-upload"]],
  ["Operações", ["operations"]],
  ["Emissão NFS-e (sandbox)", ["issuances"]],
  ["Webhooks", ["webhook-endpoints", "webhook-deliveries"]],
  ["Exportação", ["exports", "export-parts", "export-download"]],
  ["Captura", ["connections"]],
  ["Empresas", ["companies"]],
  ["Consultas", ["registry", "references"]],
  ["Capacidades", ["capabilities"]],
];

export function apiGroup(path: string) {
  const segment = path.split("/")[2] ?? path;
  return groups.find(([, segments]) => segments.includes(segment))?.[0] ?? segment;
}

export const apiGroupOrder = groups.map(([name]) => name);
