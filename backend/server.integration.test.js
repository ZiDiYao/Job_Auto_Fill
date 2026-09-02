import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

let baseUrl;
let aiRequests = [];
let mockAiServer;
let profilePath;
let resumePath;
let server;
let temporaryDirectory;

async function request(pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "job-autofill-test-"));
  profilePath = path.join(temporaryDirectory, "profile.json");
  resumePath = path.join(temporaryDirectory, "resume.pdf");
  const configPath = path.join(temporaryDirectory, "local-config.json");
  mockAiServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const system = String(body.messages?.[0]?.content || "");
    const payload = JSON.parse(body.messages?.[1]?.content || "{}");
    aiRequests.push({ url: request.url, body, system, payload });

    let data;
    if (payload.resume && !payload.questions && !payload.visibleDomFields && !payload.savedProfileSkills) {
      data = {
        fields: [
          { key: "firstName", value: "Ada", confidence: 0.99 },
          { key: "lastName", value: "Lovelace", confidence: 0.99 },
          { key: "school", value: "Example University", confidence: 0.96 },
          { key: "graduationMonth", value: "May", confidence: 0.92 },
          { key: "graduationYear", value: "2028", confidence: 0.92 },
          { key: "criminalRecord", value: "No", confidence: 1 },
        ],
      };
    } else if (payload.savedProfileSkills) {
      data = {
        skills: [
          { name: "SQL", source: "both", technical: true },
          { name: "TypeScript", source: "jd", technical: true },
          { name: "Communication", source: "both", technical: false },
          { name: "Unrelated", source: "resume", technical: true },
        ],
      };
    } else if (payload.visibleDomFields) {
      data = {
        plans: payload.visibleDomFields.flatMap((field) => {
          if (field.options?.length) return [{ id: field.id, value: String(field.options[0]).toLowerCase(), confidence: 0.93 }];
          return [{ id: field.id, value: "A concise evidence-based answer", confidence: 0.91 }];
        }),
      };
    } else {
      data = {
        answers: (payload.questions || []).map((question) => ({
          id: question.id,
          value: question.options?.[0] || "A concise evidence-based answer",
          confidence: 0.94,
        })),
      };
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      model: "mock-model",
      choices: [{ message: { content: JSON.stringify(data) } }],
      usage: { total_tokens: 25 },
    }));
  });
  await new Promise((resolve, reject) => {
    mockAiServer.once("error", reject);
    mockAiServer.listen(0, "127.0.0.1", resolve);
  });
  const mockAiUrl = `http://127.0.0.1:${mockAiServer.address().port}`;
  await writeFile(configPath, `${JSON.stringify({
    deepSeek: { apiKey: "integration-test-key", baseUrl: mockAiUrl, model: "mock-model" },
    openAI: { apiKey: "", model: "" },
    notion: { oauth: { clientId: "notion-client", clientSecret: "notion-secret" } },
  })}\n`, "utf8");

  process.env.JOB_AUTOFILL_CONFIG_PATH = configPath;
  process.env.JOB_AUTOFILL_PROFILE_PATH = profilePath;
  process.env.JOB_AUTOFILL_RESUME_PATH = resumePath;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.OPENAI_API_KEY = "";
  delete process.env.NOTION_OAUTH_CLIENT_ID;
  delete process.env.NOTION_OAUTH_CLIENT_SECRET;

  const { createServer } = await import("./server.js");
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (mockAiServer?.listening) await new Promise((resolve) => mockAiServer.close(resolve));
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("health endpoint exposes provider status without credentials", async () => {
  const { response, payload } = await request("/health");
  assert.equal(response.status, 200);
  assert.equal(payload.status, "ok");
  assert.equal(payload.providers.deepseek.configured, true);
  assert.equal(payload.providers.openai.configured, false);
  assert.equal(payload.resumeAvailable, false);
  assert.equal(JSON.stringify(payload).includes("integration-test-key"), false);
});

test("Notion OAuth configuration endpoint exposes only connection readiness and public client ID", async () => {
  const { response, payload } = await request("/api/notion/oauth-config");
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { configured: true, clientId: "notion-client" });
  assert.equal(JSON.stringify(payload).includes("notion-secret"), false);
});

test("context endpoint initializes a blank profile and tolerates a missing resume", async () => {
  const { response, payload } = await request("/api/context");
  assert.equal(response.status, 200);
  assert.equal(payload.profile.firstName, "");
  assert.deepEqual(payload.profile.workExperiences, []);
  assert.deepEqual(payload.profile.languages, []);
  assert.equal(payload.resume, null);
  assert.equal(JSON.parse(await readFile(profilePath, "utf8")).email, "");
});

test("profile updates accept known fields and discard unknown fields", async () => {
  const update = await request("/api/profile", {
    method: "PUT",
    body: {
      firstName: "Test",
      genderIdentity: "Male",
      skills: ["SQL", "Teamwork", "SQL"],
      unknownPrivateField: "must not persist",
    },
  });
  assert.equal(update.response.status, 200);
  assert.deepEqual(update.payload, { saved: true });

  const persisted = JSON.parse(await readFile(profilePath, "utf8"));
  assert.equal(persisted.firstName, "Test");
  assert.deepEqual(persisted.skills, ["SQL", "Teamwork", "SQL"]);
  assert.equal("unknownPrivateField" in persisted, false);
});

test("skill extraction can rank saved skills without calling an AI provider", async () => {
  const { response, payload } = await request("/api/extract-skills", {
    method: "POST",
    body: { jobDescription: "", pageContext: "", maxSkills: 2, maxNonTechnicalSkills: 0 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload.skills, ["SQL"]);
  assert.equal(payload.maxSkills, 2);
  assert.equal(payload.maxNonTechnicalSkills, 0);
});

test("skill extraction generates a resume-only AI baseline when CV evidence exists without a JD", async () => {
  await request("/api/profile", {
    method: "PUT",
    body: { resumeText: "TypeScript, SQL, communication, and unit testing experience." },
  });
  const beforeCount = aiRequests.length;
  const { response, payload } = await request("/api/extract-skills", {
    method: "POST",
    body: { jobDescription: "", pageContext: "", maxSkills: 3, maxNonTechnicalSkills: 1 },
  });
  assert.equal(response.status, 200);
  assert.equal(aiRequests.length, beforeCount + 1);
  assert.deepEqual(payload.skills, ["SQL", "Communication", "TypeScript"]);
  assert.deepEqual(aiRequests.at(-1).payload.jobDescription, "");
  assert.match(aiRequests.at(-1).system, /resume-only baseline/i);
  await request("/api/profile", { method: "PUT", body: { resumeText: "" } });
});

test("resume profile endpoint extracts only validated non-sensitive facts", async () => {
  const beforeCount = aiRequests.length;
  const { response, payload } = await request("/api/extract-profile", {
    method: "POST",
    body: { provider: "deepseek", resumeText: "Ada Lovelace — Example University — expected May 2028" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload.profile, {
    firstName: "Ada",
    lastName: "Lovelace",
    school: "Example University",
    graduationMonth: "May",
    graduationYear: "2028",
  });
  assert.equal(aiRequests.length, beforeCount + 1);
  assert.equal(aiRequests.at(-1).system.includes("Never extract or infer work authorization"), true);
});

test("empty structured-field requests return empty validated results", async () => {
  const resolved = await request("/api/resolve-fields", {
    method: "POST",
    body: { questions: [], provider: "deepseek" },
  });
  assert.equal(resolved.response.status, 200);
  assert.deepEqual(resolved.payload.answers, []);

  const planned = await request("/api/plan-fields", {
    method: "POST",
    body: { fields: [], provider: "deepseek" },
  });
  assert.equal(planned.response.status, 200);
  assert.deepEqual(planned.payload.plans, []);
});

test("AI answer endpoint fails safely when the selected provider is unconfigured", async () => {
  const { response, payload } = await request("/api/answer", {
    method: "POST",
    body: { questions: [], provider: "openai" },
  });
  assert.equal(response.status, 503);
  assert.match(payload.error, /OpenAI API key is not configured/);
});

test("answer endpoint calls the provider and filters sensitive questions before transmission", async () => {
  const beforeCount = aiRequests.length;
  const { response, payload } = await request("/api/answer", {
    method: "POST",
    body: {
      provider: "deepseek",
      jobDescription: "Hybrid software role",
      pageContext: "Application questionnaire",
      questions: [
        { id: 1, label: "Preferred work arrangement", type: "select", options: ["Hybrid", "Remote"] },
        { id: 2, label: "What is your gender?", type: "select", options: ["Male", "Female"] },
      ],
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload.answers, [{ id: 1, value: "Hybrid", confidence: 0.94 }]);
  assert.equal(payload.provider, "deepseek");
  assert.equal(payload.model, "mock-model");
  assert.equal(aiRequests.length, beforeCount + 1);
  const providerRequest = aiRequests.at(-1);
  assert.deepEqual(providerRequest.payload.questions.map((question) => question.id), [1]);
  assert.equal(providerRequest.payload.jobDescription, "Hybrid software role");
  assert.equal(providerRequest.system.includes("Never invent"), true);
});

test("structured dropdown resolution can use explicitly saved sensitive profile values", async () => {
  const { response, payload } = await request("/api/resolve-fields", {
    method: "POST",
    body: {
      provider: "deepseek",
      useSensitiveProfile: true,
      questions: [{ id: 3, label: "What is your gender?", type: "select", options: ["Male", "Female"] }],
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload.answers, [{ id: 3, value: "Male", confidence: 0.94 }]);
  assert.equal(aiRequests.at(-1).payload.candidateProfile.genderIdentity, "Male");
});

test("semantic DOM planning validates select options and bounds text length", async () => {
  const { response, payload } = await request("/api/plan-fields", {
    method: "POST",
    body: {
      provider: "deepseek",
      fields: [
        { id: 4, label: "Preferred office", type: "select", options: ["Toronto", "Ottawa"], required: true },
        { id: 5, label: "Why this role?", type: "textarea", options: [], maxLength: 12 },
        { id: 6, label: "Sign your application", type: "text", options: [] },
      ],
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload.plans, [
    { id: 4, operation: "select", value: "Toronto", confidence: 0.93 },
    { id: 5, operation: "fill", value: "A concise ev", confidence: 0.91 },
  ]);
  assert.deepEqual(aiRequests.at(-1).payload.visibleDomFields.map((field) => field.id), [4, 5]);
});

test("AI skill extraction enforces ranking and user-configured limits", async () => {
  const { response, payload } = await request("/api/extract-skills", {
    method: "POST",
    body: {
      provider: "deepseek",
      jobDescription: "SQL, TypeScript, communication",
      pageContext: "Technical requirements",
      maxSkills: 3,
      maxNonTechnicalSkills: 1,
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload.skills, ["SQL", "Communication", "TypeScript"]);
  assert.equal(payload.maxSkills, 3);
  assert.equal(payload.maxNonTechnicalSkills, 1);
  assert.deepEqual(payload.rankedSkills.map(({ source, technical }) => ({ source, technical })), [
    { source: "both", technical: true },
    { source: "both", technical: false },
    { source: "jd", technical: true },
  ]);
});

test("unsupported providers produce a bounded client error", async () => {
  const { response, payload } = await request("/api/plan-fields", {
    method: "POST",
    body: { fields: [], provider: "unsupported-provider" },
  });
  assert.equal(response.status, 400);
  assert.match(payload.error, /Unsupported backend AI provider/);
});

test("resume upload rejects wrong extensions, invalid headers, and oversized files", async () => {
  const wrongExtension = await request("/api/resume", {
    method: "PUT",
    body: { name: "resume.txt", base64: Buffer.from("%PDF-test").toString("base64") },
  });
  assert.equal(wrongExtension.response.status, 400);
  assert.match(wrongExtension.payload.error, /Only PDF/);

  const invalidHeader = await request("/api/resume", {
    method: "PUT",
    body: { name: "resume.pdf", base64: Buffer.from("not a pdf").toString("base64") },
  });
  assert.equal(invalidHeader.response.status, 400);
  assert.match(invalidHeader.payload.error, /not a valid PDF/);

  const oversized = await request("/api/resume", {
    method: "PUT",
    body: { name: "resume.pdf", base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") },
  });
  assert.equal(oversized.response.status, 400);
  assert.match(oversized.payload.error, /between 1 byte and 5 MB/);

  const health = await request("/health");
  assert.equal(health.payload.resumeAvailable, false);
});

test("invalid and oversized JSON requests return explicit client errors", async () => {
  const malformed = await request("/api/profile", { method: "PUT", body: "{invalid" });
  assert.equal(malformed.response.status, 400);
  assert.match(malformed.payload.error, /valid JSON/);

  const oversized = await request("/api/profile", {
    method: "PUT",
    body: JSON.stringify({ value: "x".repeat(1_050_000) }),
  });
  assert.equal(oversized.response.status, 413);
  assert.match(oversized.payload.error, /too large/);
});

test("CORS permits Chrome extensions and rejects web origins", async () => {
  const allowed = await request("/health", { headers: { Origin: "chrome-extension://abcdefghijklmnop" } });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.response.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");

  const rejected = await request("/health", { headers: { Origin: "https://malicious.example" } });
  assert.equal(rejected.response.status, 403);
  assert.match(rejected.payload.error, /local Chrome extension/);
});

test("preflight and unknown routes are handled predictably", async () => {
  const preflight = await request("/api/profile", {
    method: "OPTIONS",
    headers: { Origin: "chrome-extension://abcdefghijklmnop" },
  });
  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.payload, null);

  const missing = await request("/missing");
  assert.equal(missing.response.status, 404);
  assert.deepEqual(missing.payload, { error: "Not found" });
});
