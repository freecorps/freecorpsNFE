import { existsSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const forbidden =
  /^(convex|@convex-dev\/[^/]+|better-auth|@better-auth\/[^/]+|@clerk\/[^/]+|react|react-dom|react-native|@cloudflare\/[^/]+|cloudflare(:.*)?|wrangler|miniflare)$/;
const codeExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const excluded = ["**/node_modules/**", "**/dist/**", "**/.git/**"];
const normalize = (path) => path.replaceAll("\\", "/");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const inside = (parent, path) => {
  const rel = relative(parent, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      rel !== ".." &&
      !isAbsolute(rel))
  );
};
const runtimeDependencies = (manifest) => ({
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
});

function runtimeCandidates(path) {
  return [
    path,
    ...codeExtensions.flatMap((extension) => [
      `${path}${extension}`,
      join(path, `index${extension}`),
    ]),
  ].filter(
    (file) =>
      codeExtensions.some((extension) => file.endsWith(extension)) && ts.sys.fileExists(file),
  );
}

// Resolve manifests even when a package's exports hide package.json. Follow the
// installed tree, not a second dependency graph guessed from version ranges.
function installedPackage(name, from) {
  for (let folder = from; ; folder = dirname(folder)) {
    const file = join(folder, "node_modules", name, "package.json");
    if (existsSync(file)) return realpathSync(file);
    if (dirname(folder) === folder) return null;
  }
}

function moduleReferences(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const references = [];
  const add = (node) => {
    if (!node || !ts.isStringLiteralLike(node))
      throw new Error(`${normalize(file)}: import/require calculado não pode ser verificado`);
    references.push(node.text);
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) && ["process", "Bun", "Deno", "eval", "Function"].includes(node.text))
      throw new Error(`${normalize(file)}: ambient runtime/configuration is not allowed`);
    if (
      ts.isIdentifier(node) &&
      ["globalThis", "global", "module"].includes(node.text) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      )
    )
      throw new Error(`${normalize(file)}: alternate runtime object is not allowed`);
    if (
      ts.isElementAccessExpression(node) &&
      !ts.isStringLiteralLike(node.argumentExpression) &&
      ["globalThis", "global", "module", "import.meta"].includes(node.expression.getText(source))
    )
      throw new Error(`${normalize(file)}: ambient runtime/configuration is not allowed`);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      ["env", "process", "Bun", "Deno", "eval", "Function", "require"].includes(
        node.argumentExpression.text,
      )
    )
      throw new Error(`${normalize(file)}: ambient runtime/configuration is not allowed`);
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "env" &&
      node.expression.getText(source) === "import.meta"
    )
      throw new Error(`${normalize(file)}: ambient runtime/configuration is not allowed`);
    if (
      ts.isIdentifier(node) &&
      node.text === "require" &&
      !(
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        (ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          node.parent.name.text === "resolve" &&
          ts.isCallExpression(node.parent.parent) &&
          node.parent.parent.expression === node.parent)
      )
    )
      throw new Error(`${normalize(file)}: alternate runtime loader is not allowed`);

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ((ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "require" &&
            node.expression.name.text === "resolve") ||
            (ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === "module" &&
              node.expression.name.text === "require"))))
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  references.push(...source.referencedFiles.map((ref) => `./${ref.fileName}`));
  references.push(
    ...source.typeReferenceDirectives.map((ref) =>
      ref.fileName === "node" ? "node:fs" : `@types/${ref.fileName}`,
    ),
  );
  return references;
}

export function checkPackageBoundaries(directory) {
  const root = realpathSync(directory);
  const label = (file) => normalize(relative(root, file));
  const fail = (chain, reason) => {
    throw new Error(`${chain.join(" -> ")}: ${reason}`);
  };
  const manifest = json(join(root, "package.json"));
  const policy = json(join(root, "scripts/build/package-boundaries.json"));
  if (policy.schemaVersion !== 1 || !policy.workspaces || !Array.isArray(manifest.workspaces))
    throw new Error("Configuração de workspaces/grafo inválida");
  // Unsupported glob forms must not silently omit a new workspace.
  for (const pattern of manifest.workspaces)
    if (
      typeof pattern !== "string" ||
      !/^[a-zA-Z0-9_/*-]+$/.test(pattern) ||
      pattern.startsWith("/")
    )
      throw new Error(`Padrão de workspace não suportado: ${pattern}`);
  const files = ts.sys.readDirectory(
    root,
    [".json"],
    excluded,
    manifest.workspaces.map((pattern) => `${pattern}/package.json`),
  );
  const workspaces = files.sort().map((file) => {
    const folder = realpathSync(dirname(file));
    const path = label(folder);
    const rules = policy.workspaces[path];
    if (!inside(root, folder) || !rules || !["pure", "node", "platform"].includes(rules.kind))
      fail([path], "workspace sem classificação explícita válida");
    if (
      rules.kind !== "platform" &&
      (!Array.isArray(rules.workspaces) || !Array.isArray(rules.external))
    )
      fail([path], "declare workspaces e external permitidos");
    // An export subpath may narrow its workspace's rules, never widen them.
    const entryPoints = rules.entryPoints ?? {};
    if (typeof entryPoints !== "object" || Array.isArray(entryPoints))
      fail([path], "entryPoints inválido");
    for (const [subpath, entry] of Object.entries(entryPoints))
      if (
        rules.kind === "platform" ||
        !["pure", "node"].includes(entry?.kind) ||
        (rules.kind === "pure" && entry.kind !== "pure") ||
        !Array.isArray(entry.workspaces) ||
        !Array.isArray(entry.external) ||
        !entry.workspaces.every((name) => rules.workspaces.includes(name)) ||
        !entry.external.every((name) => rules.external.includes(name))
      )
        fail([path, subpath], "ponto de entrada sem classificação explícita válida");
    return { folder, path, rules, manifest: json(file) };
  });
  for (const path of Object.keys(policy.workspaces))
    if (!workspaces.some((workspace) => workspace.path === path))
      fail([path], "classificação sem workspace descoberto");
  const byName = new Map();
  for (const workspace of workspaces) {
    const name = workspace.manifest.name;
    if (typeof name !== "string" || byName.has(name))
      fail([workspace.path], "nome ausente ou duplicado");
    byName.set(name, workspace);
  }
  const deepestFirst = [...workspaces].sort(
    (left, right) => right.folder.length - left.folder.length,
  );
  const owner = (file) => deepestFirst.find((workspace) => inside(workspace.folder, file));
  const optionsCache = new Map();
  function optionsFor(file) {
    const config = ts.findConfigFile(dirname(file), (path) => ts.sys.fileExists(path));
    if (!config || !inside(root, config))
      return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
    if (!optionsCache.has(config)) {
      const loaded = ts.readConfigFile(config, (path) => ts.sys.readFile(path));
      if (loaded.error) fail([label(config)], "tsconfig ilegível");
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(config));
      optionsCache.set(config, parsed.options);
    }
    return optionsCache.get(config);
  }
  const independent = workspaces.filter((workspace) => workspace.rules.kind !== "platform");
  // Each classified export subpath is a separate origin, walked with its own
  // rules from the compiled file (when built) and from the source that the
  // package's outDir/rootDir map it to, so the check does not need a build.
  const entryPoints = independent.flatMap((workspace) =>
    Object.entries(workspace.rules.entryPoints ?? {}).map(([subpath, rules]) => {
      const chain = [workspace.path, `${workspace.path}/package.json [exports ${subpath}]`];
      const exported = workspace.manifest.exports;
      if (!exported || typeof exported !== "object" || !Object.hasOwn(exported, subpath))
        fail(chain, "ponto de entrada classificado ausente dos exports");
      const targets = [];
      const collect = (value) => {
        if (typeof value === "string") targets.push(resolve(workspace.folder, value));
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(exported[subpath]);
      const options = optionsFor(join(workspace.folder, "package.json"));
      const files = new Set();
      for (const target of targets) {
        if (target.includes("*")) fail(chain, "ponto de entrada com curinga não suportado");
        const stem = target.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, "");
        const candidates = [...runtimeCandidates(stem), ...(existsSync(target) ? [target] : [])];
        if (options.outDir && options.rootDir && inside(options.outDir, stem))
          candidates.push(
            ...runtimeCandidates(join(options.rootDir, relative(options.outDir, stem))),
          );
        for (const file of candidates) files.add(realpathSync(file));
      }
      if (![...files].some((file) => !/\.d\.[cm]?ts$/.test(file)))
        fail(chain, "ponto de entrada sem implementação verificável");
      return { workspace: { ...workspace, rules }, files: [...files], chain };
    }),
  );
  for (const origin of [...independent, ...entryPoints]) {
    const seenWorkspaces = new Set();
    const seenFiles = new Set();
    const seenExternal = new Set();
    function inspectExternal(name, from, chain) {
      if (forbidden.test(name)) fail(chain, `dependência de plataforma proibida: ${name}`);
      const file = installedPackage(name, from);
      if (!file) fail(chain, `dependência não instalada: ${name}`);
      if (seenExternal.has(file)) return;
      seenExternal.add(file);
      const dependency = json(file);
      if (forbidden.test(dependency.name))
        fail(chain, `dependência de plataforma proibida: ${dependency.name}`);
      if (byName.has(dependency.name)) {
        inspectWorkspace(byName.get(dependency.name), chain);
        return;
      }
      for (const [child, version] of Object.entries(runtimeDependencies(dependency))) {
        // Optional dependencies absent on this OS are still checked by name.
        const actual =
          typeof version === "string" && version.startsWith("npm:")
            ? version.slice(4).replace(/@[^@/]*$/, "")
            : child;
        if (forbidden.test(child) || forbidden.test(actual))
          fail([...chain, child], `dependência de plataforma proibida: ${actual}`);
        if (
          !installedPackage(child, dirname(file)) &&
          (dependency.optionalDependencies?.[child] ||
            dependency.peerDependenciesMeta?.[child]?.optional)
        )
          continue;
        inspectExternal(child, dirname(file), [...chain, child]);
      }
    }
    function dependency(workspace, specifier, from, chain) {
      // Custom CommonJS factories introduce call targets this static graph
      // cannot follow. Ordinary literal import/require remain supported.
      if (["node:module", "module", "node:process", "process", "node:vm", "vm"].includes(specifier))
        fail(
          chain,
          "API de carregadores module/node:module não suportada; use imports ou require literais",
        );
      if (specifier.startsWith("node:") || builtins.has(specifier)) {
        if (workspace.rules.kind !== "node")
          fail(chain, `runtime Node proibido em pacote puro: ${specifier}`);
        return;
      }
      const name = packageName(specifier);
      if (forbidden.test(name)) fail(chain, `dependência de plataforma proibida: ${name}`);
      const target = byName.get(name);
      if (target) {
        if (target.path === workspace.path) return;
        if (!workspace.rules.workspaces.includes(name))
          fail(chain, `workspace não permitido: ${name}`);
        if (
          target.rules.kind === "platform" ||
          (workspace.rules.kind === "pure" && target.rules.kind === "node")
        )
          fail(chain, `fronteira ${workspace.rules.kind} -> ${target.rules.kind} proibida`);
        inspectWorkspace(target, chain);
      } else {
        if (!workspace.rules.external.includes(name))
          fail(chain, `dependência externa não permitida: ${name}`);
        inspectExternal(name, from, chain);
      }
    }
    function inspectFile(workspace, file, chain) {
      file = realpathSync(file);
      const target = owner(file);
      if (!target) fail([...chain, label(file)], "código fora dos workspaces independentes");
      // By path: an entry point keeps its narrower rules inside its workspace.
      if (target.path !== workspace.path) {
        dependency(workspace, target.manifest.name, dirname(file), [...chain, target.path]);
        workspace = target;
      }
      if (seenFiles.has(file)) return;
      seenFiles.add(file);
      for (const specifier of moduleReferences(file)) {
        const next = [...chain, `${label(file)} [${specifier}]`];
        const name = packageName(specifier);
        if (forbidden.test(name) || specifier.startsWith("node:") || builtins.has(specifier)) {
          dependency(workspace, specifier, dirname(file), next);
          continue;
        }
        const resolved = ts.resolveModuleName(
          specifier,
          file,
          optionsFor(file),
          ts.sys,
        ).resolvedModule;
        // TypeScript may resolve ./helper.js to helper.d.ts. The declaration
        // does not prove the runtime file has the same dependencies.
        if (specifier.startsWith(".")) {
          for (const runtimeFile of runtimeCandidates(resolve(dirname(file), specifier)))
            inspectFile(workspace, runtimeFile, next);
        }
        if (resolved && !normalize(resolved.resolvedFileName).includes("/node_modules/")) {
          if (/\.d\.[cm]?ts$/.test(resolved.resolvedFileName))
            for (const runtimeFile of runtimeCandidates(
              resolved.resolvedFileName.replace(/\.d\.[cm]?ts$/, ""),
            ))
              inspectFile(workspace, runtimeFile, next);
          inspectFile(workspace, resolved.resolvedFileName, next);
          continue;
        }
        if (resolved) {
          // A paths alias may retarget an otherwise allowed dependency into a
          // different installed package. Check the resolved owner as well.
          const actualFile = realpathSync(resolved.resolvedFileName);
          const localOwner = owner(actualFile);
          if (localOwner) {
            inspectFile(workspace, actualFile, next);
            continue;
          }
          for (let folder = dirname(actualFile); ; folder = dirname(folder)) {
            const manifestFile = join(folder, "package.json");
            if (existsSync(manifestFile)) {
              const actualName = json(manifestFile).name;
              if (forbidden.test(actualName))
                fail(next, `dependência resolvida de plataforma proibida: ${actualName}`);
              const declaredFile = installedPackage(name, dirname(file));
              // A runtime dependency without its own types resolves to DefinitelyTyped
              // (`qrcode` -> `@types/qrcode`). Declarations only: the runtime package itself is
              // still checked below as a declared dependency.
              const definitelyTyped =
                !!declaredFile &&
                /\.d\.[cm]?ts$/.test(actualFile) &&
                actualName ===
                  `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
              if (
                !definitelyTyped &&
                (!declaredFile || realpathSync(manifestFile) !== declaredFile)
              )
                fail(next, `alias aponta para outro pacote: ${actualName}`);
              break;
            }
            if (dirname(folder) === folder) fail(next, "pacote resolvido sem manifesto");
          }
        }
        if (
          !specifier.startsWith(".") &&
          !isAbsolute(specifier) &&
          Object.hasOwn(runtimeDependencies(workspace.manifest), name)
        ) {
          dependency(workspace, specifier, dirname(file), next);
        } else {
          fail(next, "import não resolvido ou ausente das dependências de runtime");
        }
      }
    }
    function inspectWorkspace(workspace, chain) {
      if (workspace.rules.kind === "platform") fail(chain, "código da plataforma proibido");
      if (seenWorkspaces.has(workspace.path)) return;
      seenWorkspaces.add(workspace.path);
      for (const name of Object.keys(runtimeDependencies(workspace.manifest)))
        dependency(workspace, name, workspace.folder, [
          ...chain,
          `${workspace.path}/package.json [${name}]`,
        ]);
      const sources = ts.sys
        .readDirectory(workspace.folder, codeExtensions, excluded, ["**/*"])
        .filter(
          (file) =>
            owner(realpathSync(file)) === workspace &&
            !/(^|\/)(tests?|fixtures|e2e)\/|\.(test|spec|config)\.[^/]+$/.test(
              normalize(relative(workspace.folder, file)),
            ),
        );
      // Public entrypoints remain runtime even if placed in a development folder.
      const entries = (value) => {
        if (typeof value === "string") {
          if (value.includes("*")) {
            sources.push(
              ...ts.sys.readDirectory(
                workspace.folder,
                codeExtensions,
                ["**/node_modules/**", "**/.git/**"],
                [value],
              ),
            );
          } else if (/\.[cm]?[jt]sx?$/.test(value)) {
            const file = resolve(workspace.folder, value);
            if (existsSync(file)) sources.push(file);
          }
        } else if (value && typeof value === "object") Object.values(value).forEach(entries);
      };
      for (const field of ["exports", "main", "module", "types", "bin"])
        entries(workspace.manifest[field]);
      for (const file of sources.sort()) inspectFile(workspace, file, chain);
    }
    if (origin.files)
      for (const file of origin.files) inspectFile(origin.workspace, file, origin.chain);
    else inspectWorkspace(origin, [origin.path]);
  }
  return {
    workspaces: workspaces.length,
    independent: independent.length,
    entryPoints: entryPoints.length,
  };
}
