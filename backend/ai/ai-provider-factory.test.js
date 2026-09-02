import assert from "node:assert/strict";
import test from "node:test";

import { AiProviderFactory } from "./ai-provider-factory.js";
import { AiProviderStrategy } from "./ai-provider-strategy.js";
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

test("base strategy normalizes constructor inputs and configuration state", () => {
  const configured = new AiProviderStrategy({
    name: "Provider",
    apiKey: "  test-key  ",
    baseUrl: "https://provider.example/v1/",
    model: "  model-1 ",
  });
  assert.equal(configured.apiKey, "test-key");
  assert.equal(configured.baseUrl, "https://provider.example/v1");
  assert.equal(configured.model, "model-1");
  assert.equal(configured.isConfigured(), true);
  assert.equal(new AiProviderStrategy({ name: "Provider", apiKey: "replace_with_key", model: "m" }).isConfigured(), false);
  assert.equal(new AiProviderStrategy({ name: "Provider", apiKey: "key", model: "" }).isConfigured(), false);
});

test("base strategy reports missing keys and models with service status", () => {
  const missingKey = new AiProviderStrategy({ name: "Example", apiKey: "", model: "model" });
  assert.throws(() => missingKey.assertConfigured(), (error) => error.statusCode === 503 && /API key/.test(error.message));
  const missingModel = new AiProviderStrategy({ name: "Example", apiKey: "key", model: "" });
  assert.throws(() => missingModel.assertConfigured(), (error) => error.statusCode === 503 && /model/.test(error.message));
});

test("base strategy parses plain and fenced JSON and rejects invalid output", async () => {
  const strategy = new AiProviderStrategy({ name: "Example", apiKey: "key", model: "model" });
  assert.deepEqual(strategy.parseJson('{"ok":true}'), { ok: true });
  assert.deepEqual(strategy.parseJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => strategy.parseJson(""), (error) => error.statusCode === 502 && /empty response/.test(error.message));
  assert.throws(() => strategy.parseJson("not json"), (error) => error.statusCode === 502 && /invalid JSON/.test(error.message));
  await assert.rejects(strategy.completeJson({}), /must implement/);
});

test("base strategy converts provider HTTP failures and bounds response detail", async () => {
  const strategy = new AiProviderStrategy({ name: "Example", apiKey: "key", model: "model" });
  await assert.rejects(
    strategy.apiError(new Response("x".repeat(500), { status: 429 })),
    (error) => error.statusCode === 502 && error.message.includes("returned 429") && error.message.length < 350,
  );
});

test("factory accepts normalized names and defaults to DeepSeek", () => {
  const factory = new AiProviderFactory({ config: {}, env: {} });
  assert.ok(factory.create() instanceof DeepSeekStrategy);
  assert.ok(factory.create("open-ai") instanceof OpenAiStrategy);
  assert.ok(factory.create("Deep Seek") instanceof DeepSeekStrategy);
});

test("environment configuration overrides file configuration", () => {
  const factory = new AiProviderFactory({
    config: {
      deepSeek: { apiKey: "config-key", baseUrl: "https://config.example", model: "config-model" },
      openAI: { apiKey: "config-openai", baseUrl: "https://config-openai.example", model: "config-openai-model" },
    },
    env: {
      DEEPSEEK_API_KEY: "env-key",
      DEEPSEEK_BASE_URL: "https://env.example/",
      DEEPSEEK_MODEL: "env-model",
      OPENAI_API_KEY: "env-openai",
      OPENAI_BASE_URL: "https://env-openai.example/v1/",
      OPENAI_MODEL: "env-openai-model",
    },
  });
  const deepSeek = factory.create("deepseek");
  assert.equal(deepSeek.apiKey, "env-key");
  assert.equal(deepSeek.baseUrl, "https://env.example");
  assert.equal(deepSeek.model, "env-model");
  const openAI = factory.create("openai");
  assert.equal(openAI.apiKey, "env-openai");
  assert.equal(openAI.baseUrl, "https://env-openai.example/v1");
  assert.equal(openAI.model, "env-openai-model");
});

test("factory status reports configuration without exposing credentials", () => {
  const factory = new AiProviderFactory({
    config: { deepSeek: { apiKey: "private-key", model: "model" } },
    env: {},
  });
  const status = factory.status();
  assert.deepEqual(status.deepseek, { configured: true, model: "model" });
  assert.deepEqual(status.openai, { configured: false, model: null });
  assert.equal(JSON.stringify(status).includes("private-key"), false);
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
  assert.equal(captured.body.temperature, 0);
  assert.deepEqual(captured.body.thinking, { type: "disabled" });
  assert.deepEqual(captured.body.response_format, { type: "json_object" });
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(captured.body.messages, [
    { role: "system", content: "system" },
    { role: "user", content: '{"value":1}' },
  ]);
  assert.deepEqual(result.data, { answers: [] });
  assert.equal(result.model, "deepseek-returned");
  assert.deepEqual(result.usage, { total_tokens: 10 });
  assert.equal(result.provider, "deepseek");
});

test("DeepSeek strategy propagates bounded provider errors", async () => {
  const strategy = new DeepSeekStrategy({
    apiKey: "test-key",
    baseUrl: "https://deepseek.example",
    model: "model",
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  });
  await assert.rejects(
    strategy.completeJson({ system: "system", request: {} }),
    (error) => error.statusCode === 502 && /rate limited/.test(error.message),
  );
});

test("DeepSeek strategy rejects missing or malformed response content", async () => {
  const strategy = new DeepSeekStrategy({
    apiKey: "test-key",
    baseUrl: "https://deepseek.example",
    model: "model",
    fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
  });
  await assert.rejects(strategy.completeJson({ system: "system", request: {} }), /empty response/);
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
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.instructions, "system");
  assert.equal(captured.body.input, '{"value":1}');
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(result.data, { plans: [] });
  assert.equal(result.model, "openai-returned");
  assert.deepEqual(result.usage, { total_tokens: 12 });
  assert.equal(result.provider, "openai");
});

test("OpenAI strategy reads output text from the response item fallback", async () => {
  const strategy = new OpenAiStrategy({
    apiKey: "test-key",
    baseUrl: "https://openai.example/v1",
    model: "model",
    fetchImpl: async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "reasoning", text: "ignore" }, { type: "output_text", text: '{"answers":[]}' }] }],
    }), { status: 200 }),
  });
  const result = await strategy.completeJson({ system: "system", request: {} });
  assert.deepEqual(result.data, { answers: [] });
  assert.equal(result.model, "model");
  assert.equal(result.usage, null);
});

test("OpenAI strategy rejects HTTP errors and invalid JSON output", async () => {
  const failed = new OpenAiStrategy({
    apiKey: "test-key",
    baseUrl: "https://openai.example/v1",
    model: "model",
    fetchImpl: async () => new Response("bad gateway", { status: 502 }),
  });
  await assert.rejects(failed.completeJson({ system: "system", request: {} }), /bad gateway/);

  const malformed = new OpenAiStrategy({
    apiKey: "test-key",
    baseUrl: "https://openai.example/v1",
    model: "model",
    fetchImpl: async () => new Response(JSON.stringify({ output_text: "not-json" }), { status: 200 }),
  });
  await assert.rejects(malformed.completeJson({ system: "system", request: {} }), /invalid JSON/);
});

test("strategies reject calls when their key or model is missing", async () => {
  const strategy = new OpenAiStrategy({ apiKey: "", baseUrl: "https://api.openai.com/v1", model: "" });
  await assert.rejects(
    strategy.completeJson({ system: "system", request: {} }),
    /OpenAI API key is not configured/,
  );

  const strategyWithoutModel = new DeepSeekStrategy({ apiKey: "key", baseUrl: "https://api.deepseek.com", model: "" });
  await assert.rejects(
    strategyWithoutModel.completeJson({ system: "system", request: {} }),
    /DeepSeek model is not configured/,
  );
});
