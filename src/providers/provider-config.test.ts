import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModelsConfig, modelsSchema, priceFor } from "./provider-config.js";

test("model settings reject bad price dates, budgets and provider URLs", () => {
  const config = loadModelsConfig();
  for (const change of [
    { pricesAsOf: "2026-02-31" },
    { unknownCallReserveUsd: -1 },
    {
      providers: {
        ...config.providers,
        openai: { ...config.providers.openai, baseURL: "file:///secret" },
      },
    },
    {
      providers: {
        ...config.providers,
        gemini: { ...config.providers.gemini, maxAttempts: 0 },
      },
    },
    {
      prices: {
        broken: {
          inputPerMillionUsd: -1,
          outputPerMillionUsd: 0,
          source: "https://example.com",
        },
      },
    },
  ])
    assert.equal(
      modelsSchema.safeParse({ ...config, ...change }).success,
      false,
    );
});

test("a new unpriced model stays configurable but never receives an invented price", () => {
  const config = modelsSchema.parse({
    ...loadModelsConfig(),
    answer: "new-model",
  });
  assert.equal(priceFor(config, "new-model"), null);
  const known = priceFor(config, config.embedding);
  assert.equal(known?.pricesAsOf, config.pricesAsOf);
});
