import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");

function loadBackground({ fetchImpl, initialStorage = {}, scripting, tabs, permissions, setTimeoutImpl = setTimeout } = {}) {
  const listeners = [];
  const commandListeners = [];
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
    scripting: scripting || {
      async executeScript() { throw new Error("Unexpected script injection"); },
    },
    commands: {
      onCommand: { addListener: (listener) => commandListeners.push(listener) },
    },
    tabs: tabs || {
      async query() { return []; },
    },
    permissions: permissions || {
      async contains() { return true; },
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {},
      async setTitle() {},
    },
  };
  const context = vm.createContext({
    AbortController,
    clearTimeout,
    console,
    fetch: fetchImpl || (async () => { throw new Error("Unexpected fetch"); }),
    Response,
    setTimeout: setTimeoutImpl,
    TypeError,
    chrome,
  });
  vm.runInContext(source, context, { filename: "background.js" });
  assert.equal(listeners.length, 1);

  async function send(message, sender = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Background listener did not respond")), 1000);
      const asynchronous = listeners[0](message, sender, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      if (asynchronous !== true) {
        clearTimeout(timer);
        resolve({ returned: asynchronous });
      }
    });
  }

  function command(name) {
    for (const listener of commandListeners) listener(name);
  }

  return { context, listener: listeners[0], send, storage, command, commandListeners };
}

test("auto-advance button policy permits navigation but blocks final and consent actions", () => {
  const { context } = loadBackground();
  const classify = (label) => vm.runInContext(`classifyAdvanceLabel(${JSON.stringify(label)})`, context);
  assert.equal(classify("Next"), "advance");
  assert.equal(classify("Save and Continue"), "advance");
  assert.equal(classify("Review"), "advance");
  assert.equal(classify("Submit Application"), "terminal");
  assert.equal(classify("Continue and Submit"), "terminal");
  assert.equal(classify("Accept and Continue"), "terminal");
  assert.equal(classify("Delete account"), "ignore");
});

test("auto-advance fills the next page and stops before the final Submit button", async () => {
  let navigationChecks = 0;
  const scripting = {
    async executeScript(details) {
      if (details.func) {
        navigationChecks += 1;
        return navigationChecks === 1
          ? [{ result: { clicked: true, terminal: false, label: "Next" } }]
          : [{ result: { clicked: false, terminal: true, label: "Submit Application" } }];
      }
      return [{ result: { filled: 3, review: 0, aiFilled: 1 } }];
    },
  };
  const background = loadBackground({ scripting, setTimeoutImpl: (callback) => { callback(); return 0; } });
  const started = await background.send({ type: "start-auto-advance", tabId: 42, maxSteps: 5, delayMs: 800 });
  assert.equal(started.started, true);
  for (let index = 0; index < 20 && background.storage.jobAutofillAutoAdvanceStatus?.state !== "awaiting-submit"; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(background.storage.jobAutofillAutoAdvanceStatus.running, false);
  assert.equal(background.storage.jobAutofillAutoAdvanceStatus.state, "awaiting-submit");
  assert.match(background.storage.jobAutofillAutoAdvanceStatus.message, /submit it yourself/i);
});

test("auto-advance does not click Next while required fields need review", async () => {
  let injected = false;
  const background = loadBackground({
    scripting: { async executeScript() { injected = true; return []; } },
    setTimeoutImpl: (callback) => { callback(); return 0; },
  });
  await background.send({ type: "start-auto-advance", tabId: 9, initialReview: 2 });
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(injected, false);
  assert.equal(background.storage.jobAutofillAutoAdvanceStatus.state, "needs-review");
});

test("keyboard command fills the active application tab without opening the popup", async () => {
  const injections = [];
  const scripting = {
    async executeScript(details) {
      injections.push(details);
      if (details.func) return [{ result: { jobDescription: "D".repeat(200), metadata: { jobTitle: "Developer", sourceUrl: "https://jobs.example/apply" } } }];
      return [{ result: { filled: 4, review: 1, aiFilled: 0 } }];
    },
  };
  const background = loadBackground({
    initialStorage: { jobAutofillProfile: {} },
    scripting,
    tabs: { async query() { return [{ id: 17, url: "https://jobs.example/apply" }]; } },
  });

  assert.equal(background.commandListeners.length, 1);
  background.command("fill-current-page");
  for (let index = 0; index < 20 && !background.storage.jobAutofillLastFillStatus; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(injections.some((details) => details.files?.includes("content.js")), true);
  assert.equal(background.storage.jobAutofillJobDescription.length, 200);
  assert.equal(background.storage.jobAutofillLastFillStatus.tabId, 17);
  assert.equal(background.storage.jobAutofillLastFillStatus.filled, 4);
  assert.equal(background.storage.jobAutofillLastFillStatus.source, "shortcut");
});

test("automatic page messages fill only when enabled and deduplicate page signatures", async () => {
  let injections = 0;
  const scripting = {
    async executeScript(details) {
      if (details.files?.includes("content.js")) injections += 1;
      return [{ result: { filled: 2, review: 0, aiFilled: 1 } }];
    },
  };
  const disabled = loadBackground({ initialStorage: { jobAutofillProfile: { autoFillOnPageChange: false } }, scripting });
  const skipped = await disabled.send({ type: "auto-fill-page-ready", signature: "page-a" }, { tab: { id: 7 } });
  assert.equal(skipped.skipped, "disabled");
  assert.equal(injections, 0);

  const enabled = loadBackground({ initialStorage: { jobAutofillProfile: { autoFillOnPageChange: true } }, scripting });
  const message = {
    type: "auto-fill-page-ready",
    signature: "page-b",
    jobDescription: "J".repeat(220),
    metadata: { jobTitle: "Engineer", sourceUrl: "https://ats.example/apply" },
  };
  const filled = await enabled.send(message, { tab: { id: 8 } });
  const duplicate = await enabled.send(message, { tab: { id: 8 } });

  assert.equal(filled.filled, 2);
  assert.equal(duplicate.skipped, "duplicate");
  assert.equal(injections, 1);
  assert.equal(enabled.storage.jobAutofillJobDescription.length, 220);
});

test("automatic fill registration adds and removes the persistent page watcher", async () => {
  const registrations = [];
  let registered = [];
  const scripting = {
    async executeScript() { return []; },
    async getRegisteredContentScripts() { return registered; },
    async unregisterContentScripts(details) {
      registrations.push(["unregister", details.ids]);
      registered = [];
    },
    async registerContentScripts(entries) {
      registrations.push(["register", entries]);
      registered = entries;
    },
  };
  const background = loadBackground({ scripting });
  const enabled = await background.send({ type: "configure-auto-fill", enabled: true });
  const disabled = await background.send({ type: "configure-auto-fill", enabled: false });

  assert.equal(enabled.enabled, true);
  assert.equal(disabled.enabled, false);
  assert.equal(registrations[0][0], "register");
  assert.equal(registrations[0][1][0].js[0], "auto-fill-watcher.js");
  assert.equal(registrations[1][0], "unregister");
});

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
