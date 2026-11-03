import { afterAll, beforeAll, vi } from "vite-plus/test";

/**
 * Nos projetos sem isolamento por arquivo (`shared` em
 * scripts/lib/test-projects.mjs), um worker roda vários arquivos em sequência
 * e mantém os módulos carregados. Este setup devolve ao arquivo seguinte o
 * worker como um worker novo o receberia: timers reais, sem timers pendentes
 * do arquivo anterior, `process.env` original, globais de `vi.stubGlobal`
 * desfeitos e spies restaurados. Uma atribuição direta em `globalThis` fica:
 * apagar globais novos quebraria módulos já carregados que definem um global
 * uma vez, ao serem importados. Os hooks de setup rodam por arquivo, e o
 * `afterAll` daqui roda depois dos do próprio arquivo.
 */
type Timer = ReturnType<typeof setTimeout>;
const state = globalThis as typeof globalThis & { __fileTimers?: Set<Timer> };

// Uma vez por worker: registra os timers reais que cada arquivo cria. Um timer
// pendente (uma função agendada do convex-test, por exemplo) dispararia no
// arquivo seguinte, que nem conhece o banco que ele usa.
if (!state.__fileTimers) {
  const timers = new Set<Timer>();
  state.__fileTimers = timers;
  const { setTimeout: timeout, setInterval: interval } = globalThis;
  globalThis.setTimeout = ((
    handler: (...values: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer: Timer = timeout(
      (...values: unknown[]) => {
        timers.delete(timer);
        handler(...values);
      },
      delay,
      ...args,
    );
    timers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = interval(...args);
    timers.add(timer);
    return timer;
  }) as typeof setInterval;
}

let env: NodeJS.ProcessEnv = {};
beforeAll(() => {
  env = { ...process.env };
});

afterAll(() => {
  vi.useRealTimers();
  for (const timer of state.__fileTimers!) clearTimeout(timer);
  state.__fileTimers!.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // No lugar, sem trocar o objeto que módulos já carregados podem guardar.
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});
