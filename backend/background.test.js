import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");

function loadBackground({ fetchImpl, initialStorage = {} } = {}) {
  const listeners = [];
  const storage = structuredClone(initialStorage);
  const chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
    },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => key in storage).map((key) => [key, storage[key]]));
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
      },
    },
  };
  const context = vm.createContext({
    AbortController,
    clearTimeout,
    console,
    fetch: fetchImpl || (async () => { throw new Error("Unexpected fetch"); }),
    Response,
    setTimeout,
    TypeError,
    chrome,
  });
  vm.runInContext(source, context, { filename: "background.js" });
  assert.equal(listeners.length, 1);

  async function send(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Background listener did not respond")), 1000);
      const asynchronous = listeners[0](message, {}, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      if (asynchronous !== true) {
        clearTimeout(timer);
        resolve({ returned: asynchronous });
      }
    });
  }

  return { listener: listeners[0], send, storage };
}

test("backend answer messages forward normalized request data", async () => {
  let captured;
  const background = loadBackground({
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ answers: [{ id: 1, value: "Answer", confidence: 0.9 }] }), { status: 200 });
    },
  });
  const result = await background.send({
    type: "answer-application-questions",
    provider: "backend",
    jobDescription: "JD",
    jobContext: "Page",
    questions: [{ id: 1 }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.answers)), [{ id: 1, value: "Answer", confidence: 0.9 }]);
  assert.equal(captured.url, "http://127.0.0.1:17840/api/answer");
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(captured.body, {
    jobDescription: "JD",
    pageContext: "Page",
    questions: [{ id: 1 }],
    provider: "deepseek",
  });
});

test("backend errors are returned to the extension caller", async () => {
  const background = loadBackground({
    fetchImpl: async () => new Response(JSON.stringify({ error: "Provider unavailable" }), { status: 503 }),
  });
  const result = await background.send({ type: "answer-application-questions", provider: "backend" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Provider unavailable");
});

test("Ollama answers are parsed, trimmed, and filtered by integer id", async () => {
  let requestBody;
  const background = loadBackground({
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            answers: [
              { id: 2, value: "  concise answer  ", confidence: "0.88" },
              { id: "bad", value: "ignored", confidence: 1 },
            ],
          }),
        },
      }), { status: 200 });
    },
  });
  const result = await background.send({
    type: "answer-application-questions",
    provider: "ollama",
    model: "qwen-test",
    resumeText: "Resume evidence",
    jobContext: "Page context",
    questions: [{ id: 2, label: "Why this role?" }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.answers)), [{ id: 2, value: "concise answer", confidence: 0.88 }]);
  assert.equal(requestBody.model, "qwen-test");
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.format.required[0], "answers");
  assert.equal(requestBody.options.temperature, 0);
});

test("Ollama validation rejects missing setup and avoids calls for empty questions", async () => {
  let calls = 0;
  const background = loadBackground({ fetchImpl: async () => { calls += 1; return new Response("{}"); } });
  const missingModel = await background.send({
    type: "answer-application-questions",
    provider: "ollama",
    resumeText: "resume",
    questions: [{}],
  });
  assert.equal(missingModel.ok, false);
  assert.match(missingModel.error, /Choose an Ollama model/);

  const missingResume = await background.send({
    type: "answer-application-questions",
    provider: "ollama",
    model: "model",
    questions: [{}],
  });
  assert.equal(missingResume.ok, false);
  assert.match(missingResume.error, /Add resume text/);

  const empty = await background.send({
    type: "answer-application-questions",
    provider: "ollama",
    model: "model",
    resumeText: "resume",
    questions: [],
  });
  assert.equal(empty.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(empty.answers)), []);
  assert.equal(calls, 0);
});

test("Ollama network failures receive a useful local-service message", async () => {
  const background = loadBackground({ fetchImpl: async () => { throw new TypeError("connection refused"); } });
  const result = await background.send({
    type: "answer-application-questions",
    provider: "ollama",
    model: "model",
    resumeText: "resume",
    questions: [{}],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not reach Ollama/);
});

test("skill, dropdown, and DOM-plan messages use their dedicated endpoints", async () => {
  const calls = [];
  const background = loadBackground({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("/api/extract-skills")) return new Response(JSON.stringify({ skills: ["SQL"], rankedSkills: [], maxSkills: 4, maxNonTechnicalSkills: 1 }));
      if (url.endsWith("/api/resolve-fields")) return new Response(JSON.stringify({ answers: [{ id: 1, value: "Yes" }] }));
      return new Response(JSON.stringify({ plans: [{ id: 2, value: "Toronto" }] }));
    },
  });

  const skills = await background.send({ type: "extract-job-skills", maxSkills: 4, maxNonTechnicalSkills: 1 });
  const dropdowns = await background.send({ type: "resolve-workday-dropdowns", questions: [{ id: 1 }], useSensitiveProfile: true });
  const plans = await background.send({ type: "plan-dom-fields", fields: [{ id: 2 }], backendProvider: "openai" });
  assert.deepEqual(JSON.parse(JSON.stringify(skills.skills)), ["SQL"]);
  assert.deepEqual(JSON.parse(JSON.stringify(dropdowns.answers)), [{ id: 1, value: "Yes" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(plans.plans)), [{ id: 2, value: "Toronto" }]);
  assert.deepEqual(calls.map((call) => call.url.split("/").at(-1)), ["extract-skills", "resolve-fields", "plan-fields"]);
  assert.equal(calls[1].body.useSensitiveProfile, true);
  assert.equal(calls[2].body.provider, "openai");
});

test("backend sync merges nonblank values without erasing browser-only values", async () => {
  const background = loadBackground({
    initialStorage: { jobAutofillProfile: { firstName: "Browser", city: "Existing" } },
    fetchImpl: async () => new Response(JSON.stringify({
      profile: { firstName: "", lastName: "Backend", city: null },
      resume: null,
    }), { status: 200 }),
  });
  const result = await background.send({ type: "sync-backend-context" });
  assert.equal(result.ok, true);
  assert.equal(result.profile.firstName, "Browser");
  assert.equal(result.profile.lastName, "Backend");
  assert.equal(result.profile.city, "Existing");
  assert.equal(result.profile.aiEnabled, true);
  assert.equal(result.profile.aiProvider, "backend");
  assert.equal(background.storage.jobAutofillResume, null);
});

test("resume save persists backend metadata and the browser upload cache", async () => {
  const background = loadBackground({
    initialStorage: { jobAutofillProfile: { firstName: "Test" } },
    fetchImpl: async () => new Response(JSON.stringify({
      resumeText: "Extracted text",
      resume: { name: "returned.pdf", size: 123, lastModified: 456 },
    }), { status: 200 }),
  });
  const result = await background.send({
    type: "save-backend-resume",
    resume: { name: "upload.pdf", size: 100, lastModified: 200, base64: "UERG" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.resume.name, "returned.pdf");
  assert.equal(background.storage.jobAutofillProfile.firstName, "Test");
  assert.equal(background.storage.jobAutofillProfile.resumeText, "Extracted text");
  assert.equal(background.storage.jobAutofillResume.base64, "UERG");
});

test("unknown messages are ignored synchronously", () => {
  const { listener } = loadBackground();
  assert.equal(listener({ type: "unknown" }, {}, () => {}), false);
});
