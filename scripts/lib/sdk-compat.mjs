// Gate de compatibilidade do SDK (#135): compara a API TypeScript do SDK atual
// com as declarações da última versão publicada, rota a rota e símbolo a
// símbolo, e exige um incremento de versão coerente com o que mudou. A política
// está em docs/v1.0/SDK.md#versão-do-sdk.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { readTarball } from "./distribution.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sdkPackageName = "@freecorps/freecorpsnfe-sdk";

/**
 * Digest of a declarations copy: SHA-256 of one `<sha256>  <path>\n` line per file, sorted by
 * path, the same lines `sha256sum` prints. A file added, removed, renamed or edited changes it.
 * @param {{ path: string, bytes: Uint8Array }[]} files
 */
export function declarationsDigest(files) {
  const lines = files
    .map(({ path, bytes }) => `${sha256(bytes)}  ${path}\n`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  return sha256(lines.join(""));
}

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function parseVersion(text) {
  const match = semver.exec(text);
  if (!match) throw new Error(`Versão inválida: ${text}`);
  return match.slice(1, 4).map(Number);
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The version the SDK must carry for what changed since the published one. Below 1.0, a break or
 * a new contract major asks for a minor above the published (0.1.x → 0.2.0); from 1.0 on, a major.
 * An additive change asks for any version above the published; an equal API asks for nothing.
 * A version that was never published accepts further changes of the same class.
 */
export function versionFailures({ published, version, contractVersion, classification }) {
  const previous = parseVersion(published.version);
  const next = parseVersion(version);
  const contractPrevious = parseVersion(published.contractVersion)[0];
  const contractNext = parseVersion(contractVersion)[0];
  const failures = [];
  if (compare(next, previous) < 0)
    failures.push(`versão ${version} abaixo da publicada ${published.version}`);
  if (contractNext < contractPrevious)
    failures.push(`contrato ${contractVersion} abaixo do publicado ${published.contractVersion}`);
  if (failures.length) return failures;
  const incompatible = classification === "breaking" || contractNext > contractPrevious;
  const reason =
    classification === "breaking"
      ? "a API TypeScript tem quebra"
      : `o contrato passou de ${published.contractVersion} para ${contractVersion}`;
  if (incompatible) {
    const required = previous[0] === 0 ? `0.${previous[1] + 1}.0` : `${previous[0] + 1}.0.0`;
    if (compare(next, parseVersion(required)) < 0)
      failures.push(
        `${reason}: o SDK precisa de ${required} ou acima (está em ${version}, publicado ${published.version})`,
      );
  } else if (classification === "additive" && compare(next, previous) === 0)
    failures.push(
      `a API TypeScript mudou de forma compatível: o SDK precisa de versão acima da publicada ${published.version}`,
    );
  return failures;
}

/**
 * How a published exported type is used by the integrator. An input type (options the integrator
 * builds) keeps compatible when every old value is still accepted; an output type (what the SDK
 * returns) when every new value still fits the old one. A type missing here must not change at all.
 */
export const typeDirections = {
  ClientOptions: "input",
  CallOptions: "input",
  WebhookSecret: "input",
  WebhookHeaders: "input",
  WebhookEnvelope: "output",
  WebhookVerification: "output",
  HistoryLimitedData: "output",
};
// The route types are compared route by route: inputs with RequestOf, outputs with ResponseOf.
const routeTypes = new Set(["RouteName", "RequestOf", "ResponseOf"]);

const specifier = (from, to) => {
  const path = relative(dirname(from), to)
    .replaceAll("\\", "/")
    .replace(/(\.d)?\.ts$/, ".js");
  return path.startsWith(".") ? path : `./${path}`;
};

const errorsOf = (diagnostics) =>
  diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
const message = (diagnostic) =>
  `${diagnostic.file ? relative(process.cwd(), diagnostic.file.fileName) + ": " : ""}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;

/**
 * Compares the exported API of two SDK builds. `previous` and `next` map each package entry
 * (".", "./webhooks") to its declaration or source file. `overlay` maps absolute paths to text
 * that replaces (or adds) a file, for fixtures. The generated `compat.ts` lives at `compatPath`,
 * inside the SDK package so that "zod" resolves from its node_modules; it is never written.
 * Returns the classification and every difference, each naming the entry, symbol, member, route
 * or field.
 * @param {{ previous: Record<string, string>, next: Record<string, string>, compatPath: string,
 *   overlay?: Map<string, string> }} options
 */
export function compareSdk({ previous, next, compatPath, overlay = new Map() }) {
  // skipLibCheck stays off: the published copy is made of .d.ts files, and an error in one of them
  // (an unresolved import, an unknown name) would otherwise turn its types into `any` silently.
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
  };
  const files = new Map([...overlay].map(([path, text]) => [resolve(path), text]));
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const key = (path) => resolve(path);
  host.readFile = (path) => files.get(key(path)) ?? readFile(path);
  host.fileExists = (path) => files.has(key(path)) || fileExists(path);
  host.directoryExists = (path) =>
    [...files.keys()].some((file) => file.startsWith(key(path))) ||
    (directoryExists ? directoryExists(path) : existsSync(path));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, language, onError, create) => {
    const text = files.get(key(path));
    return text === undefined
      ? getSourceFile(path, language, onError, create)
      : ts.createSourceFile(path, text, language);
  };

  /** @type {{ subject: string, change: "removed" | "added" | "breaking" | "additive", detail: string }[]} */
  const changes = [];
  for (const entry of Object.keys(next))
    if (!(entry in previous))
      changes.push({ subject: `entrada ${entry}`, change: "added", detail: "entrada nova" });
  for (const entry of Object.keys(previous))
    if (!(entry in next))
      changes.push({ subject: `entrada ${entry}`, change: "removed", detail: "entrada removida" });
  const entries = Object.keys(previous).filter((entry) => entry in next);
  const roots = [...entries.map((e) => previous[e]), ...entries.map((e) => next[e])].map((r) =>
    resolve(r),
  );
  const first = ts.createProgram({ rootNames: roots, options, host });
  // Every file of both sides outside node_modules must compile: the roots, what they import from
  // packages/contracts and the whole published copy.
  for (const file of first.getSourceFiles()) {
    if (first.isSourceFileDefaultLibrary(file) || /[\\/]node_modules[\\/]/.test(file.fileName))
      continue;
    const errors = errorsOf([
      ...first.getSyntacticDiagnostics(file),
      ...first.getSemanticDiagnostics(file),
    ]);
    if (errors.length) throw new Error(`Declaração com erro: ${message(errors[0])}`);
  }
  const checker = first.getTypeChecker();
  const exportsOf = (path) => {
    const file = first.getSourceFile(resolve(path));
    if (!file) throw new Error(`Declaração ausente: ${path}`);
    const module = checker.getSymbolAtLocation(file);
    return new Map(checker.getExportsOfModule(module).map((s) => [s.name, s]));
  };
  const resolved = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const routeNames = (exports) => {
    const symbol = exports.get("RouteName");
    if (!symbol) return new Set();
    const type = checker.getDeclaredTypeOfSymbol(resolved(symbol));
    return new Set((type.isUnion() ? type.types : [type]).map((t) => t.value));
  };
  const isPrivate = (member) =>
    (ts.getDeclarationModifierFlagsFromSymbol(member) &
      (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
    0;
  const signatures = (symbol) => checker.getTypeOfSymbol(symbol).getCallSignatures();
  // A generic or overloaded signature has no single Parameters/ReturnType: it must stay identical.
  const plainSignature = (before, after) => {
    const a = signatures(before);
    const b = signatures(after);
    return (
      a.length === 1 &&
      b.length === 1 &&
      !a[0].typeParameters?.length &&
      !b[0].typeParameters?.length
    );
  };
  const publicMembers = (type) =>
    new Map(
      checker
        .getPropertiesOfType(type)
        .filter((member) => !isPrivate(member) && member.name !== "prototype")
        .map((member) => [member.name, member]),
    );
  const instanceMembers = (symbol) =>
    publicMembers(checker.getDeclaredTypeOfSymbol(resolved(symbol)));
  const staticMembers = (symbol) => publicMembers(checker.getTypeOfSymbol(resolved(symbol)));

  /** @type {{ subject: string, previous: string, next: string, rule: "input" | "output" | "same", labels?: string[] }[]} */
  const checks = [];
  const lines = [];
  const callable = (rule, subject, o, n, before, after) => {
    if (!plainSignature(before, after)) {
      checks.push({ subject, previous: o, next: n, rule: "same" });
      return;
    }
    checks.push({
      subject: `${subject} (parâmetros)`,
      previous: `Parameters<${o}>`,
      next: `Parameters<${n}>`,
      rule: "input",
    });
    checks.push({
      subject: `${subject} (retorno)`,
      previous: `ReturnType<${o}>`,
      next: `ReturnType<${n}>`,
      rule: "output",
    });
  };
  // Public members of a class: each one removed is a break, each one new is additive. Methods
  // compare parameters as input and return as output; properties, as output.
  // `FreecorpsClient.call<K>` is compared route by route, instantiated with each route name.
  const compareMembers = (subject, oldType, newType, before, after, className) => {
    for (const member of after.keys())
      if (!before.has(member))
        changes.push({ subject: `${subject}.${member}`, change: "added", detail: "membro novo" });
    for (const [member, value] of before) {
      if (!after.has(member)) {
        changes.push({
          subject: `${subject}.${member}`,
          change: "removed",
          detail: "membro removido",
        });
        continue;
      }
      if (className === "FreecorpsClient" && member === "call") continue;
      const o = `${oldType}[${JSON.stringify(member)}]`;
      const n = `${newType}[${JSON.stringify(member)}]`;
      if (value.flags & ts.SymbolFlags.Method)
        callable("method", `${subject}.${member}`, o, n, value, after.get(member));
      else checks.push({ subject: `${subject}.${member}`, previous: o, next: n, rule: "output" });
    }
  };
  for (const [index, entry] of entries.entries()) {
    lines.push(`import type * as O${index} from "${specifier(compatPath, previous[entry])}";`);
    lines.push(`import type * as N${index} from "${specifier(compatPath, next[entry])}";`);
  }
  let routesCompared = false;
  for (const [index, entry] of entries.entries()) {
    const old = exportsOf(previous[entry]);
    const current = exportsOf(next[entry]);
    const O = `O${index}`;
    const N = `N${index}`;
    for (const name of current.keys())
      if (!old.has(name))
        changes.push({ subject: `${entry} ${name}`, change: "added", detail: "símbolo novo" });
    for (const [name, symbol] of old) {
      const subject = `${entry} ${name}`;
      if (!current.has(name)) {
        changes.push({ subject, change: "removed", detail: "símbolo removido" });
        continue;
      }
      if (routeTypes.has(name)) {
        if (name !== "RouteName" || routesCompared) continue;
        routesCompared = true;
        const before = routeNames(old);
        const after = routeNames(current);
        // What the integrator uses for a route: the exported RequestOf/ResponseOf and what
        // `client.call<route>` takes and returns, instantiated with that route.
        const client =
          old.has("FreecorpsClient") &&
          current.has("FreecorpsClient") &&
          instanceMembers(old.get("FreecorpsClient")).has("call") &&
          instanceMembers(current.get("FreecorpsClient")).has("call");
        if (client)
          lines.push(
            `declare const oc${index}: ${O}.FreecorpsClient;`,
            `declare const nc${index}: ${N}.FreecorpsClient;`,
          );
        for (const route of after)
          if (!before.has(route))
            changes.push({ subject: `rota ${route}`, change: "added", detail: "rota nova" });
        for (const route of before) {
          if (!after.has(route)) {
            changes.push({ subject: `rota ${route}`, change: "removed", detail: "rota removida" });
            continue;
          }
          const literal = JSON.stringify(route);
          // The input of call<route> is its second parameter; its options are compared once,
          // below, so that a change in CallOptions is not reported on every route.
          const call = (side, kind) =>
            client ? `, ${kind}<typeof ${side}c${index}.call<${literal}>>` : "";
          checks.push({
            subject: `rota ${route} (entrada)`,
            previous: `[${O}.RequestOf<${literal}>${call("o", "Parameters")}[1]]`,
            next: `[${N}.RequestOf<${literal}>${call("n", "Parameters")}[1]]`,
            rule: "input",
            labels: ["RequestOf", "call"],
          });
          checks.push({
            subject: `rota ${route} (resposta)`,
            previous: `[${O}.ResponseOf<${literal}>${call("o", "ReturnType")}]`,
            next: `[${N}.ResponseOf<${literal}>${call("n", "ReturnType")}]`,
            rule: "output",
            labels: ["ResponseOf", "call"],
          });
        }
        const common = [...before].find((route) => after.has(route));
        if (client && common !== undefined)
          checks.push({
            subject: `. FreecorpsClient.call (parâmetros)`,
            previous: `Parameters<typeof oc${index}.call<${JSON.stringify(common)}>>`,
            next: `Parameters<typeof nc${index}.call<${JSON.stringify(common)}>>`,
            rule: "input",
            labels: ["name", "input", "options"],
          });
        continue;
      }
      const target = resolved(symbol);
      const declaration = target.declarations?.[0];
      if (
        declaration &&
        (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) &&
        declaration.typeParameters?.length
      ) {
        changes.push({
          subject,
          change: "breaking",
          detail: "tipo genérico sem comparação automática; registre a regra em sdk-compat.mjs",
        });
        continue;
      }
      if (target.flags & ts.SymbolFlags.Class) {
        checks.push({
          subject: `${subject} (construtor)`,
          previous: `ConstructorParameters<typeof ${O}.${name}>`,
          next: `ConstructorParameters<typeof ${N}.${name}>`,
          rule: "input",
        });
        compareMembers(
          subject,
          `${O}.${name}`,
          `${N}.${name}`,
          instanceMembers(symbol),
          instanceMembers(current.get(name)),
          name,
        );
        compareMembers(
          `${subject} (estático)`,
          `(typeof ${O}.${name})`,
          `(typeof ${N}.${name})`,
          staticMembers(symbol),
          staticMembers(current.get(name)),
          null,
        );
        continue;
      }
      if (target.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) {
        const after = resolved(current.get(name));
        if (signatures(target).length || signatures(after).length)
          callable(
            "function",
            subject,
            `typeof ${O}.${name}`,
            `typeof ${N}.${name}`,
            target,
            after,
          );
        else
          checks.push({
            subject,
            previous: `typeof ${O}.${name}`,
            next: `typeof ${N}.${name}`,
            rule: "output",
          });
        continue;
      }
      checks.push({
        subject,
        previous: `${O}.${name}`,
        next: `${N}.${name}`,
        rule: typeDirections[name] ?? "same",
      });
    }
  }

  // Identical is the compiler's own identity relation: an optional field added or removed, a
  // nested `any` or a changed modifier all make two types different even when each is
  // assignable to the other.
  lines.push(
    "type Assignable<A, B> = [A] extends [B] ? true : false;",
    "type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
    "type IsAny<T> = 0 extends 1 & T ? true : false;",
    "type Check<A, B> = [Assignable<A, B>, Assignable<B, A>, Identical<A, B>, IsAny<A> | IsAny<B>];",
    ...checks.flatMap((c, i) => [
      `export type P${i} = ${c.previous};`,
      `export type Q${i} = ${c.next};`,
      `export type C${i} = Check<P${i}, Q${i}>;`,
    ]),
  );
  const compat = lines.join("\n") + "\n";
  files.set(resolve(compatPath), compat);
  const program = ts.createProgram({
    rootNames: [...roots, resolve(compatPath)],
    options,
    host,
    oldProgram: first,
  });
  const file = program.getSourceFile(resolve(compatPath));
  const errors = errorsOf(ts.getPreEmitDiagnostics(program, file));
  if (errors.length) throw new Error(`compat.ts não compila: ${message(errors[0])}`);
  const types = program.getTypeChecker();
  const aliases = new Map(
    file.statements
      .filter((s) => ts.isTypeAliasDeclaration(s))
      .map((s) => [s.name.text, types.getTypeAtLocation(s.name)]),
  );

  // Fields the published side has and the current one lost, and fields that became `any`, at any
  // depth. Both break code written against the published version even when assignability holds
  // (an optional field removed, a field widened to `any`).
  const isAny = (type) => (type.flags & ts.TypeFlags.Any) !== 0;
  const parts = (type) => {
    const awaited = types.getAwaitedType(type) ?? type;
    const nonNull = types.getNonNullableType(awaited);
    return nonNull.isUnion() ? nonNull.types : [nonNull];
  };
  const shapeOf = (type) => {
    const elements = [];
    const fields = new Map();
    const add = (name, type) => (fields.get(name) ?? fields.set(name, []).get(name)).push(type);
    let objects = 0;
    for (const part of parts(type)) {
      if (isAny(part)) continue;
      if (types.isArrayType(part) || types.isTupleType(part)) {
        const args = types.getTypeArguments(part);
        objects++;
        if (types.isTupleType(part)) args.forEach((arg, i) => add(`[${i}]`, arg));
        else elements.push(...args);
        continue;
      }
      if (!(part.flags & ts.TypeFlags.Object) && !part.isIntersection()) continue;
      if (part.getCallSignatures().length || part.getConstructSignatures().length) continue;
      objects++;
      for (const property of types.getPropertiesOfType(part))
        if (!isPrivate(property)) add(property.name, types.getTypeOfSymbol(property));
      // Record<string, T> and other index signatures: their values are compared as `[*]`.
      for (const info of types.getIndexInfosOfType(part)) add("[*]", info.type);
    }
    return { elements, fields, objects };
  };
  const union = (list) => (list.length === 1 ? list[0] : types.getUnionType(list));
  // Past this depth the walk gives up and fails closed; the contract today nests about 8 levels.
  const maxDepth = 32;
  const lost = (before, after, path, depth, seen, found, labels, input) => {
    if (depth > maxDepth) {
      found.push(`campo ${path} passa de ${maxDepth} níveis, sem comparação`);
      return;
    }
    if (isAny(after) && !isAny(before)) {
      found.push(`campo ${path || "(raiz)"} virou any`);
      return;
    }
    const pair = `${before.id}:${after.id}`;
    if (seen.has(pair)) return;
    seen.add(pair);
    const a = shapeOf(before);
    const b = shapeOf(after);
    if (a.elements.length && b.elements.length)
      lost(union(a.elements), union(b.elements), `${path}[]`, depth + 1, seen, found, null, input);
    for (const [name, list] of a.fields) {
      // The slots of a route check's own tuple are named after what they hold.
      const slot =
        !path && labels && /^\[\d+\]$/.test(name) ? labels[Number(name.slice(1, -1))] : null;
      const field =
        slot ?? (path ? (name.startsWith("[") ? `${path}${name}` : `${path}.${name}`) : name);
      const counterpart = b.fields.get(name);
      if (!counterpart) {
        // Any object left on the new side means the field was dropped from it, even when that
        // object has no field at all now ({ cursor?, limit? } → {}). On the input side an object
        // that became `unknown` or a primitive also counts, by the conservative rule; on the
        // output side, `{ a } | null` → `null` only narrows what the integrator receives.
        if (b.objects || (input && a.objects)) found.push(`campo ${field} removido`);
        continue;
      }
      lost(union(list), union(counterpart), field, depth + 1, seen, found, null, input);
    }
  };

  for (const [i, check] of checks.entries()) {
    const tuple = aliases.get(`C${i}`);
    const [forward, backward, identical, any] = types
      .getTypeArguments(tuple)
      .map((t) => types.typeToString(t) === "true");
    if (any) {
      changes.push({
        subject: check.subject,
        change: "breaking",
        detail: "tipo resolvido como any",
      });
      continue;
    }
    if (identical) continue;
    const found = [];
    lost(
      aliases.get(`P${i}`),
      aliases.get(`Q${i}`),
      "",
      0,
      new Set(),
      found,
      check.labels,
      check.rule === "input",
    );
    if (found.length) {
      for (const detail of found)
        changes.push({ subject: check.subject, change: "breaking", detail });
      continue;
    }
    // forward: old assignable to new; backward: new assignable to old.
    const kept = check.rule === "input" ? forward : check.rule === "output" ? backward : false;
    changes.push({
      subject: check.subject,
      change: kept ? "additive" : "breaking",
      detail:
        check.rule === "input"
          ? kept
            ? "aceita o que a versão publicada aceitava, e mais"
            : "recusa valores que a versão publicada aceitava"
          : check.rule === "output"
            ? kept
              ? "devolve valores que cabem no tipo publicado"
              : "devolve valores que a versão publicada não previa"
            : "tipo mudou (deve ficar idêntico: sem direção em typeDirections, genérico ou sobrecarregado)",
    });
  }
  const breaking = changes.some((c) => c.change === "breaking" || c.change === "removed");
  const additive = changes.length > 0;
  return {
    classification: breaking ? "breaking" : additive ? "additive" : "equal",
    checks: checks.length,
    changes,
    compat,
  };
}

/** Reads and validates packages/sdk/published.json against its copy and its acceptance record. */
export function readPublished(root) {
  const record = JSON.parse(readFileSync(resolve(root, "packages/sdk/published.json"), "utf8"));
  const published = record.published;
  for (const field of ["version", "contractVersion"]) parseVersion(published[field]);
  if (!/^[0-9a-f]{64}$/.test(published.tarballSha256))
    throw new Error("SDK publicado: tarballSha256 inválido");
  if (!/^packages\/sdk\/published\/\d+\.\d+\.\d+$/.test(published.declarations))
    throw new Error("SDK publicado: diretório de declarações inválido");
  if (!/^docs\/v1\.0\/evidence\/\d+\/\d{4}-\d{2}-\d{2}\/accepted\.json$/.test(published.accepted))
    throw new Error("SDK publicado: aceite inválido");
  const accepted = JSON.parse(readFileSync(resolve(root, published.accepted), "utf8"));
  const line = accepted.packages.find((p) => p.name === sdkPackageName);
  if (line?.version !== published.version || line?.sha256 !== published.tarballSha256)
    throw new Error("SDK publicado: versão ou SHA-256 difere do aceite");
  if (
    declarationsDigest(declarationFiles(resolve(root, published.declarations))) !==
    published.declarationsSha256
  )
    throw new Error("SDK publicado: a cópia das declarações difere do registro");
  for (const path of Object.values(published.entries))
    if (!/^types\/[A-Za-z0-9_/.-]+\.d\.ts$/.test(path) || path.includes(".."))
      throw new Error("SDK publicado: entrada inválida");
  return record;
}

/** Every file under a declarations copy, with its path relative to the copy and `/` separators. */
export function declarationFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = resolve(entry.parentPath, entry.name);
      return {
        path: relative(directory, path).replaceAll("\\", "/"),
        bytes: readFileSync(path),
      };
    });
}

/**
 * The record of a new publication, from the accepted tarball bytes. Refuses bytes that are not
 * the accepted ones, a manifest that disagrees with the acceptance, unsafe paths and a version
 * below the one already recorded. Returns the record and the declaration files to copy, with
 * paths relative to `record.published.declarations`.
 * @param {{ tarball: Uint8Array, accepted: any, acceptedPath: string, publishedAt: string,
 *   current?: any }} input
 */
export function publicationRecord({ tarball, accepted, acceptedPath, publishedAt, current }) {
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error("Data de publicação inválida");
  if (!/^docs\/v1\.0\/evidence\/\d+\/\d{4}-\d{2}-\d{2}\/accepted\.json$/.test(acceptedPath))
    throw new Error("O aceite deve ficar em docs/v1.0/evidence/<n>/<data>/accepted.json");
  const line = accepted.packages.find((p) => p.name === sdkPackageName);
  if (!line || line.sha256 !== sha256(tarball))
    throw new Error(`O tarball não é o aceito para ${sdkPackageName}`);
  parseVersion(line.version);
  if (current && compare(parseVersion(line.version), parseVersion(current.published.version)) < 0)
    throw new Error(
      `A versão ${line.version} está abaixo da registrada ${current.published.version}`,
    );
  const entries = readTarball(tarball);
  for (const { name } of entries)
    if (!/^package\/[A-Za-z0-9._/-]+$/.test(name) || name.split("/").includes(".."))
      throw new Error(`Caminho de tarball inválido: ${name}`);
  const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));
  const manifest = JSON.parse(byName.get("package/package.json")?.toString("utf8") ?? "{}");
  if (manifest.name !== sdkPackageName || manifest.version !== line.version)
    throw new Error("package.json do tarball difere do aceite");
  const contract = /export declare const apiVersion = "(\d+\.\d+\.\d+)";/.exec(
    byName.get("package/types/contracts/src/external.d.ts")?.toString("utf8") ?? "",
  );
  if (!contract) throw new Error("O tarball não declara a versão do contrato");
  const declarations = entries
    .filter(({ name }) => name.startsWith("package/types/"))
    .map(({ name, bytes }) => ({ path: name.slice("package/".length), bytes }));
  const entryPoints = Object.fromEntries(
    Object.entries(manifest.exports ?? {}).map(([entry, target]) => [
      entry,
      String(target?.types ?? "").replace(/^\.\//, ""),
    ]),
  );
  const paths = new Set(declarations.map((d) => d.path));
  for (const path of Object.values(entryPoints))
    if (!paths.has(path)) throw new Error(`Entrada sem declaração no tarball: ${path}`);
  return {
    files: declarations,
    record: {
      decision:
        "Gate de compatibilidade do SDK (#135): a API TypeScript de packages/sdk é comparada com estas declarações publicadas. Política em docs/v1.0/SDK.md, seção Versão do SDK.",
      published: {
        version: line.version,
        contractVersion: contract[1],
        publishedAt: new Date(publishedAt).toISOString(),
        tarballSha256: line.sha256,
        accepted: acceptedPath,
        declarations: `packages/sdk/published/${line.version}`,
        declarationsSha256: declarationsDigest(declarations),
        entries: entryPoints,
      },
    },
  };
}
