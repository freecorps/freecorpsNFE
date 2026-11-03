import {
  init,
  start,
  load,
  configure,
  build,
  buildHosted,
  compose,
  call,
} from "./lib/selfhost.mjs";
import { startTermsOfUseNotice } from "./lib/terms-notice.mjs";

const [command, name, ...args] = process.argv.slice(2);
try {
  if (command === "init") {
    const target = init(
      name,
      args[0] === undefined ? undefined : Number(args[0]),
      args[1] === undefined ? undefined : Number(args[1]),
    );
    console.log(`Configuração criada em ${target.directory}. Segredos locais não foram impressos.`);
  } else if (command === "up") {
    console.log(`target: self-hosted local ${name}, servidor Docker exclusivo`);
    const target = start(name);
    console.log(JSON.stringify(await configure(target)));
    // The e-mail notice of a new version of the terms of use (#594), to the local collector
    // (`mail`). A failed call is logged, never a failed installation; `up` again starts it.
    await startTermsOfUseNotice((path) => call(target, "mutation", path));
    build(target);
    console.log(
      `Console pronto para servir em ${target.frontend}. Use: node --experimental-strip-types scripts/selfhost.mjs serve ${name}`,
    );
  } else if (command === "build-hosted") buildHosted(name);
  else if (command === "build-hosted-production") buildHosted(name, "production");
  else if (command === "build") build(load(name));
  else if (command === "stop") compose(load(name), ["stop"]);
  else if (command === "mail")
    console.log(
      JSON.stringify(await call(load(name), "query", "mail:inbox", { email: args[0] }), null, 2),
    );
  else if (command === "serve") {
    const { serve } = await import("./lib/selfhost-server.mjs");
    serve(load(name));
  } else
    throw new Error("Use init <nome> [porta-backend] [porta-console], up|build|serve|stop <nome>");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
