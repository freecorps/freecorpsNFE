import { mkdirSync, writeFileSync } from "node:fs";
import { referenceCorpus } from "../tests/helpers/reference-corpus";
import { sha256 } from "../lib/reference-dataset";
const root = "tests/fixtures/references/1.0";
mkdirSync(root, { recursive: true });
const files = [];
for (const dataset of ["ncm", "municipalities"] as const) {
  const corpus = await referenceCorpus(dataset);
  const file = `${dataset}.json`,
    data = JSON.stringify(corpus, null, 2) + "\n";
  writeFileSync(`${root}/${file}`, data, "utf8");
  files.push({
    file,
    sha256: await sha256(data),
    origin: "handwritten-synthetic",
    redistribution: "synthetic",
    expected: {
      count: 25,
      firstCodeOn20260922: "out_of_validity",
      secondCodeOn20260922: "valid",
      absentCode: "not_found",
    },
  });
}
writeFileSync(
  `${root}/manifest.json`,
  JSON.stringify(
    {
      version: 1,
      scenarios: [
        "source-version",
        "valid",
        "out-of-validity",
        "absent",
        "snapshot-unknown",
        "incomplete-update",
        "rollback",
      ],
      files,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
