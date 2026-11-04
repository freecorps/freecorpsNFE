import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { hash } from "../lib/hosted-fixtures.mjs";
const dir = ".ci-results/hosted-79-80";
mkdirSync(dir, { recursive: true });
const source = `import {query} from "convex:/_system/repl/wrappers.js";
import {dispatch} from "../../platform/convex/documentRest";
export default query({handler: async(ctx,args)=>dispatch._handler(ctx,args)});`;
writeFileSync(`${dir}/candidate.ts`, source);
const result = await Bun.build({
  entrypoints: [`${dir}/candidate.ts`],
  target: "browser",
  format: "esm",
  minify: true,
  external: ["convex:/_system/repl/wrappers.js"],
});
if (!result.success) throw new Error("Could not bundle the readonly candidate");
const bundle = await result.outputs[0].text();
writeFileSync(`${dir}/candidate.js`, bundle);
writeFileSync(
  `${dir}/candidate-build.json`,
  JSON.stringify(
    {
      bundleSha256: hash(bundle),
      sources: [
        "platform/convex/documentRest.ts",
        "platform/convex/documents.ts",
        "platform/convex/lib/documentCore.ts",
      ].map((path) => ({ path, sha256: hash(readFileSync(path)) })),
    },
    null,
    2,
  ) + "\n",
);
console.log("Readonly candidate bundled");
