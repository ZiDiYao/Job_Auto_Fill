import assert from "node:assert/strict";
import test from "node:test";

import { AiProviderFactory } from "./ai-provider-factory.js";
import { DeepSeekStrategy } from "./deepseek-strategy.js";
import { OpenAiStrategy } from "./openai-strategy.js";

test("factory creates the selected provider strategy", () => {
  const factory = new AiProviderFactory({
    config: {
      deepSeek: { apiKey: "deepseek-test", model: "deepseek-test-model" },
      openAI: { apiKey: "openai-test", model: "openai-test-model" },
    },
    env: {},
  });
  assert.ok(factory.create("deepseek") instanceof DeepSeekStrategy);
  assert.ok(factory.create("OpenAI") instanceof OpenAiStrategy);
  assert.throws(() => factory.create("unknown"), /Unsupported backend AI provider/);
});

test("DeepSeek strategy normalizes Chat Completions JSON", async () => {
  let captured;
  const strategy = new DeepSeekStrategy({
    apiKey: "test-key",
    baseUrl: "https://deepseek.example/",
    model: "deepseek-test",
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        model: "deepseek-returned",
        choices: [{ message: { content: '{"answers":[]}' } }],
        usage: { total_tokens: 10 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await strategy.completeJson({ system: "system", request: { value: 1 }, maxTokens: 123 });
  assert.equal(captured.url, "https://deepseek.example/chat/completions");
  assert.equal(captured.body.max_tokens, 123);
  assert.deepEqual(result.data, { answers: [] });
  assert.equal(result.provider, "deepseek");
});

test("OpenAI strategy normalizes Responses API structured JSON", async () => {
  let captured;
  const strategy = new OpenAiStrategy({
    apiKey: "test-key",
    baseUrl: "https://openai.example/v1/",
    model: "openai-test",
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        model: "openai-returned",
        output_text: '{"plans":[]}',
        usage: { total_tokens: 12 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await strategy.completeJson({ system: "system", request: { value: 1 }, maxTokens: 456 });
  assert.equal(captured.url, "https://openai.example/v1/responses");
  assert.equal(captured.body.max_output_tokens, 456);
  assert.deepEqual(captured.body.text, { format: { type: "json_object" } });
  assert.deepEqual(result.data, { plans: [] });
  assert.equal(result.provider, "openai");
});

test("strategies reject calls when their key or model is missing", async () => {
  const strategy = new OpenAiStrategy({ apiKey: "", baseUrl: "https://api.openai.com/v1", model: "" });
  await assert.rejects(
    strategy.completeJson({ system: "system", request: {} }),
    /OpenAI API key is not configured/,
  );
});
