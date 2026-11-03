import { relative } from "node:path";
import type { TestSequencer, TestSpecification, Vitest } from "vite-plus/test/node";

/**
 * O sequenciador padrão do Vitest ordena os arquivos por nome de projeto antes
 * da duração. Com seis projetos, o teste mais lento do último em ordem
 * alfabética (`tooling`) começava depois de quase todos e alongava a suíte.
 * Aqui a fila é uma só: primeiro o que falhou, depois o que ainda não tem
 * duração registrada (os maiores arquivos antes) e então os mais longos.
 * Ordem não muda resultado: cada arquivo roda isolado ou, na área
 * `platform`, recebe o worker limpo (tests/setup/file-isolation.ts).
 */
export class DurationSequencer implements TestSequencer {
  private readonly ctx: Vitest;
  constructor(ctx: Vitest) {
    this.ctx = ctx;
  }

  shard(): never {
    throw new Error("A suíte não usa --shard; DurationSequencer não divide arquivos.");
  }

  sort(files: TestSpecification[]) {
    const { cache, config } = this.ctx;
    const key = (spec: TestSpecification) =>
      `${spec.project.name}:${relative(config.root, spec.moduleId)}`;
    return [...files].sort((a, b) => {
      const order = a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder;
      if (order !== 0) return order;
      const [resultA, resultB] = [
        cache.getFileTestResults(key(a)),
        cache.getFileTestResults(key(b)),
      ];
      if (!resultA || !resultB) {
        const [statsA, statsB] = [cache.getFileStats(key(a)), cache.getFileStats(key(b))];
        if (!statsA || !statsB) return !statsA && statsB ? -1 : !statsB && statsA ? 1 : 0;
        return statsB.size - statsA.size;
      }
      if (resultA.failed !== resultB.failed) return resultA.failed ? -1 : 1;
      return resultB.duration - resultA.duration;
    });
  }
}
