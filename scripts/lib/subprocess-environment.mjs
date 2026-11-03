// A subprocess receives only the runtime paths and controls it needs.
// This is credential hygiene, not a sandbox for untrusted executable code.
const runtimeNames = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
]);

export function subprocessEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => value !== undefined && runtimeNames.has(name.toUpperCase()),
    ),
  );
}

// Writer guards need event metadata, never an inherited token or arbitrary GITHUB_*.
export function publicationEnvironment(env) {
  const result = subprocessEnvironment(env);
  for (const name of [
    "GITHUB_ACTIONS",
    "GITHUB_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_EVENT_NAME",
    "GITHUB_SHA",
  ])
    if (env[name] !== undefined) result[name] = env[name];
  return result;
}
