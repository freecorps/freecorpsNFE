import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { hash } from "./lib/hosted-fixtures.mjs";
const dir = ".ci-results/hosted-79-80",
  path = "platform/convex/lib/operationalMetrics.ts";
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${dir}/metrics.ts`,
  `import {query} from "convex:/_system/repl/wrappers.js";
import {operationalMetrics} from "../../platform/convex/lib/operationalMetrics";
export default query({handler: async(ctx,args)=>operationalMetrics(ctx,args.monitor,args.now)});`,
);
const versions = {
    before: execFileSync("git", ["show", `358cee25e75d2b41a43f2c4a084c039361fbf8ae:${path}`], {
      encoding: "utf8",
    }),
    after: readFileSync(path, "utf8"),
  },
  receipt = {};
for (const [label, contents] of Object.entries(versions)) {
  const result = await Bun.build({
    entrypoints: [`${dir}/metrics.ts`],
    target: "browser",
    format: "esm",
    minify: true,
    external: ["convex:/_system/repl/wrappers.js"],
    plugins: [
      {
        name: "measured-source",
        setup(build) {
          build.onLoad({ filter: /operationalMetrics\.ts$/ }, (args) => ({
            contents,
            loader: "ts",
            resolveDir: dirname(args.path),
          }));
        },
      },
    ],
  });
  if (!result.success) throw new Error("Monitor probe bundle failed");
  const bundle = await result.outputs[0].text();
  writeFileSync(`${dir}/metrics-${label}.js`, bundle);
  receipt[label] = { sourceSha256: hash(contents), bundleSha256: hash(bundle) };
}
writeFileSync(`${dir}/metrics-build.json`, JSON.stringify(receipt, null, 2) + "\n");
console.log("Readonly monitor probes bundled");
