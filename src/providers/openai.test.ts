import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOpenAiEmbeddings } from "./openai.js";

test("embedding responses require the complete batch of finite nonempty equal-size vectors", () => {
  for (const data of [
    [],
    [{ embedding: [] }],
    [{ embedding: [NaN] }],
    [{ embedding: [Infinity] }],
    [{ embedding: [1] }, { embedding: [1, 2] }],
  ]) {
    assert.throws(
      () =>
        parseOpenAiEmbeddings({ data }, "embedding-model", data.length || 1),
      /invalid embeddings/,
    );
  }
  assert.throws(
    () =>
      parseOpenAiEmbeddings(
        { data: [{ embedding: [1] }] },
        "embedding-model",
        2,
      ),
    /invalid embeddings/,
  );
  assert.deepEqual(
    parseOpenAiEmbeddings(
      { data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] },
      "embedding-model",
      2,
    ).embeddings,
    [
      [1, 2],
      [3, 4],
    ],
  );
});
