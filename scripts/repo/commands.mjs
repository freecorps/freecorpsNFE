/** `bun run help`; catálogo em lib/commands.mjs. */
import { helpText } from "../lib/commands.mjs";

if (process.argv[2] === "help") console.log(helpText());
else {
  console.error("Uso: commands.mjs help");
  process.exitCode = 1;
}
