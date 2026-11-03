import {
  routes,
  transferPaths,
  uploadResponse,
  apiVersion,
  errorResponse,
  toJsonSchema,
} from "../../packages/contracts/src/external.ts";

export function openApi() {
  /** @type {Record<string, object>} */
  const schemas = {};
  /** @type {Record<string, Record<string, object>>} */
  const paths = {};
  const json = (schema) => {
    const { $schema: _dialect, ...value } = toJsonSchema(schema, { target: "draft-2020-12" });
    return value;
  };
  const content = (name) => ({
    "application/json": { schema: { $ref: `#/components/schemas/${name}` } },
  });
  schemas.Error = json(errorResponse);
  schemas.UploadResponse = json(uploadResponse);
  Object.assign(paths, transferPaths);
  for (const [name, route] of Object.entries(routes)) {
    const input = json(route.input);
    schemas[`${name}Request`] = input;
    schemas[`${name}Response`] = json(route.output);
    const parameters = [
      {
        name: "X-Environment",
        in: "header",
        required: true,
        schema: { type: "string", enum: ["sandbox", "production"] },
      },
    ];
    for (const location of ["path", "query"]) {
      const group = input.properties[location];
      for (const [key, schema] of Object.entries(group.properties))
        parameters.push({
          name: key,
          in: location,
          required: group.required?.includes(key) ?? false,
          schema,
        });
    }
    if (route.retry === "idempotent")
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", pattern: route.idempotencyPattern },
      });
    const headers = {
      "X-Request-Id": {
        schema: { type: "string" },
        description: "Referência de suporte, igual ao requestId do corpo.",
      },
      "Cache-Control": { schema: { type: "string", const: "no-store" } },
    };
    const success =
      "location" in route
        ? {
            ...headers,
            Location: {
              schema: { type: "string" },
              description: `Recurso aceito, no formato ${route.location}.`,
            },
          }
        : headers;
    (paths[route.path] ??= {})[route.method.toLowerCase()] = {
      operationId: name,
      parameters,
      "x-scope": route.scope,
      "x-retry-policy": route.retry,
      ...(route.method === "GET"
        ? {}
        : {
            requestBody: {
              required: true,
              content: { "application/json": { schema: input.properties.body } },
            },
          }),
      responses: {
        [route.status]: {
          description: "Sucesso",
          headers: success,
          content: content(`${name}Response`),
        },
        default: {
          description:
            "Erro com requestId. 401 credencial; 403 escopo/ambiente; 404 recurso fora do acesso; 409 conflito; 429 limite; 503 indisponibilidade.",
          headers,
          content: content("Error"),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Freecorps API de documentos",
      version: apiVersion,
      description:
        "IDs públicos são strings opacas. Capabilities não concedem acesso nem seguem os escopos da chave: devolvem o ambiente da chave e os modelos e capacidades que ele atende para ao menos uma das suas empresas; na Produção do site, só as da captura fiscal liberada. Sandbox: importação de NF-e modelo 55 e emissão NFS-e com transporte simulado, sem validade fiscal. Produção no site: só para empresa com a captura fiscal liberada, com a NF-e modelo 55 capturada da distribuição DF-e, a consulta e a exportação desses documentos, webhooks e a conexão de captura; importação, emissão, referências e CNPJ ficam no sandbox. A emissão NFS-e existe só no sandbox: o gate de produção está desligado e nenhuma nota com validade fiscal foi emitida pela plataforma.",
    },
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", bearerFormat: "API key" },
        uploadTicket: { type: "apiKey", in: "header", name: "X-Upload-Token" },
      },
      schemas,
    },
  };
}

/** Conservative compatibility gate: every changed existing operation requires an explicit major version.
 * It may reject an additive change inside an existing operation; this is deliberate and documented.
 * New operations are allowed. This never silently approves an unknown schema keyword. */
export function compatibilityFailures(previous, next) {
  const previousMajor = Number(previous.info.version.split(".")[0]);
  const nextMajor = Number(next.info.version.split(".")[0]);
  if (nextMajor < previousMajor) return ["root info.version: major downgrade"];
  if (nextMajor > previousMajor) return [];
  const failures = [];
  for (const field of ["openapi", "security", "servers"])
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field]))
      failures.push(`root ${field}`);
  for (const [name, scheme] of Object.entries(previous.components.securitySchemes ?? {}))
    if (JSON.stringify(scheme) !== JSON.stringify(next.components.securitySchemes?.[name]))
      failures.push(`securityScheme ${name}`);
  for (const [path, methods] of Object.entries(previous.paths))
    for (const [method, operation] of Object.entries(methods)) {
      const current = next.paths[path]?.[method];
      if (JSON.stringify(operation) !== JSON.stringify(current))
        failures.push(`${method.toUpperCase()} ${path}`);
    }
  for (const [name, schema] of Object.entries(previous.components.schemas))
    if (JSON.stringify(schema) !== JSON.stringify(next.components.schemas[name]))
      failures.push(`schema ${name}`);
  return failures;
}

const major = (document) => Number(document.info.version.split(".")[0]);

/**
 * Contract gate since the maintainer decision of 26/10/2026: a major that was never published
 * accepts changes. `published` is the last published OpenAPI (null while nothing was published);
 * `base` is the contract the change starts from (the PR base). Lowering the major is refused
 * against both. Inside the published major, every change to an existing operation or schema is
 * refused by `compatibilityFailures`, with or without a minor bump.
 */
export function contractGateFailures({ base, published, next }) {
  const failures = [];
  if (base && major(next) < major(base)) failures.push("root info.version: major downgrade");
  if (published) {
    if (major(next) < major(published))
      failures.push(`root info.version: major downgrade from published ${published.info.version}`);
    else if (major(next) === major(published))
      failures.push(...compatibilityFailures(published, next));
  }
  return failures;
}

/**
 * The last published contract, from the versioned record in packages/contracts/published.json.
 * `readAtCommit(commit)` returns the text of docs/v1.0/openapi.json at that commit; its SHA-256
 * and version must match the record, so the baseline cannot drift from what was published.
 */
export function publishedBaseline(record, readAtCommit, sha256) {
  if (record.published === null) return null;
  const { version, commit, openapiSha256 } = record.published;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Contrato publicado: commit inválido");
  const text = readAtCommit(commit);
  if (sha256(text) !== openapiSha256)
    throw new Error(`Contrato publicado: SHA-256 de ${commit} difere do registro`);
  const document = JSON.parse(text);
  if (document.info.version !== version)
    throw new Error(`Contrato publicado: versão ${document.info.version} difere de ${version}`);
  return document;
}
