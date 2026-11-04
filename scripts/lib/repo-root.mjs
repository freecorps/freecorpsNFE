import { fileURLToPath } from "node:url";

// Raiz do repositório, calculada a partir de scripts/lib/, que não muda de
// lugar. Os scripts em scripts/<domínio>/ usam isto em vez de subir pastas a
// partir da própria localização: um `..` a mais ou a menos não falha, só lê e
// grava no lugar errado.
export const repoUrl = new URL("../../", import.meta.url);
export const repoRoot = fileURLToPath(repoUrl);
