import { defineConfig } from "vite-plus";
import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

// Dois arquivos, um worker, sem isolamento, na ordem do nome: `b` roda no
// worker que `a` acabou de usar (tests/ci.fileIsolation.test.ts).
class ByName extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ["*.case.ts"],
    pool: "threads",
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { sequencer: ByName },
    setupFiles: process.env.FILE_ISOLATION_SETUP ? ["../../setup/file-isolation.ts"] : [],
  },
});
