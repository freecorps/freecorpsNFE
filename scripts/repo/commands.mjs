/** `bun run help` e os nomes antigos dos scripts; catálogo em lib/commands.mjs. */
import { helpText, renamedMessage } from "../lib/commands.mjs";

const [command, name] = process.argv.slice(2);
if (command === "help") console.log(helpText());
else if (command === "renamed") {
  console.error(renamedMessage(name));
  process.exitCode = 1;
} else {
  console.error("Uso: commands.mjs help | renamed <nome>");
  process.exitCode = 1;
}
