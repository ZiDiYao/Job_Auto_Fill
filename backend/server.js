import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(currentDirectory, ".env");
const configPath = process.env.JOB_AUTOFILL_CONFIG_PATH
  || path.join(currentDirectory, "config", "local-config.json");

async function loadRuntimeConfig() {
  if (!existsSync(configPath)) return {};
  return JSON.parse(await readFile(configPath, "utf8"));
}

const runtimeConfig = await loadRuntimeConfig();

function resolveLocalPath(configuredPath, fallback) {
  if (!configuredPath) return path.join(currentDirectory, fallback);
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(currentDirectory, configuredPath);
}

const profilePath = resolveLocalPath(runtimeConfig.storage?.profilePath, "data/profile.json");
const resumePath = resolveLocalPath(runtimeConfig.storage?.resumePath, "data/Resume_2027_ZIDI.pdf");

async function loadLocalEnv() {
  if (!existsSync(envPath)) return;
  const text = await readFile(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadLocalEnv();

if (!process.env.DEEPSEEK_API_KEY && !runtimeConfig.deepSeek?.apiKey && process.platform === "darwin") {
  try {
    process.env.DEEPSEEK_API_KEY = execFileSync(
      "security",
      ["find-generic-password", "-a", process.env.USER || "", "-s", "local-job-autofill-deepseek", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    // The health endpoint reports that configuration is still required.
  }
}

const port = Number(process.env.JOB_AUTOFILL_PORT || runtimeConfig.server?.port || 17840);
const host = process.env.JOB_AUTOFILL_HOST || runtimeConfig.server?.host || "127.0.0.1";
const configuredDeepSeekKey = () => process.env.DEEPSEEK_API_KEY || runtimeConfig.deepSeek?.apiKey || "";
const configuredDeepSeekModel = () => process.env.DEEPSEEK_MODEL || runtimeConfig.deepSeek?.model || "deepseek-v4-flash";

let pdfModulePromise;
async function getPdfModule() {
  if (!pdfModulePromise) {
    const originalWarning = console.warn;
    console.warn = (...values) => {
      const message = values.map(String).join(" ");
      if (!message.includes("@napi-rs/canvas") && !message.includes("Cannot polyfill")) originalWarning(...values);
    };
    pdfModulePromise = import("../vendor/pdf.mjs").finally(() => { console.warn = originalWarning; });
  }
  return pdfModulePromise;
}

async function extractPdfText(filePath) {
  const { getDocument } = await getPdfModule();
  const bytes = new Uint8Array(await readFile(filePath));
  const pdf = await getDocument({ data: bytes, disableWorker: true }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || "").join(" ").replace(/\s+/g, " ").trim());
  }
  return pages.filter(Boolean).join("\n\n");
}

let resumeTextPromise;
function getResumeText() {
  resumeTextPromise ||= extractPdfText(resumePath);
  return resumeTextPromise;
}

async function getProfile() {
  return JSON.parse(await readFile(profilePath, "utf8"));
}

const sensitiveQuestion = /\b(salary|compensation|criminal|background|security clearance|consent|terms|privacy|signature|agree|date of birth|birth date|sin|social insurance|ssn|social security|authori[sz]ed to work|work authori[sz]ation|sponsor|sponsorship|visa|gender|sex|sexual orientation|race|racial|ethnic|disability|disabled|veteran|indigenous|aboriginal|first nations?|m[eé]tis|inuit|pronouns?)\b/i;

function safeProfileForModel(profile) {
  const allowedKeys = [
    "firstName", "lastName", "preferredName", "email", "phone", "city", "province", "country",
    "linkedin", "github", "portfolio", "school", "degree", "fieldOfStudy", "graduationMonth",
    "graduationYear", "startDate", "workTerm",
  ];
  return Object.fromEntries(allowedKeys.map((key) => [key, profile[key] || ""]));
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validateAnswers(rawAnswers, questions, { allowSensitive = false } = {}) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const validated = [];
  for (const answer of Array.isArray(rawAnswers) ? rawAnswers : []) {
    const question = byId.get(answer?.id);
    if (!question || (!allowSensitive && sensitiveQuestion.test(question.label || ""))) continue;
    let value = String(answer.value || "").trim();
    const confidence = Math.min(1, Math.max(0, Number(answer.confidence || 0)));
    if (!value || confidence < 0.65) continue;

    if (question.type === "select" && Array.isArray(question.options)) {
      const match = question.options.find((option) => normalize(option) === normalize(value));
      if (!match) continue;
      value = match;
    }
    if (Number(question.maxLength) > 0) value = value.slice(0, Number(question.maxLength));
    validated.push({ id: question.id, value, confidence });
  }
  return validated;
}

async function callDeepSeek({ jobDescription, pageContext, questions }) {
  const apiKey = configuredDeepSeekKey();
  if (!apiKey || apiKey === "replace_with_a_new_key") {
    throw Object.assign(new Error("A DeepSeek API key is not configured."), { statusCode: 503 });
  }

  const profile = await getProfile();
  const resume = await getResumeText();
  const safeQuestions = questions
    .filter((question) => !sensitiveQuestion.test(question.label || ""))
    .slice(0, 20);

  const system = [
    "You are a truthful job-application assistant. Return JSON only in this exact shape:",
    '{"answers":[{"id":0,"value":"answer","confidence":0.9}]}',
    "Use only facts explicitly present in the candidate profile or resume.",
    "Use the job description only to tailor emphasis; never copy requirements into the candidate's experience.",
    "Never invent employers, dates, metrics, education, technologies, authorization, or personal attributes.",
    "When evidence is missing, omit that question from answers.",
    "For subjective preference, motivation, teamwork, learning, and flexibility questions, choose the most employer-positive framing that remains consistent with the supplied evidence.",
    "Sound enthusiastic, adaptable, collaborative, and willing to learn; tailor emphasis to the role without exaggerating experience.",
    "Never improve an answer by inventing a factual, legal, medical, licensing, clearance, employment-history, or criminal-history claim.",
    "Do not answer work authorization, sponsorship, compensation, legal, demographic, disability, veteran, consent, or signature questions.",
    "For select questions, value must exactly equal one of the provided options.",
    "Match the answer length to the field: use a short value for factual inputs and 60-140 first-person words only for essay-style questions.",
  ].join(" ");

  const request = {
    candidateProfile: safeProfileForModel(profile),
    resume,
    jobDescription: String(jobDescription || "").slice(0, 16000),
    visiblePageContext: String(pageContext || "").slice(0, 8000),
    questions: safeQuestions,
  };

  const baseUrl = String(
    process.env.DEEPSEEK_BASE_URL || runtimeConfig.deepSeek?.baseUrl || "https://api.deepseek.com",
  ).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: configuredDeepSeekModel(),
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(request) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
      temperature: 0,
      stream: false,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw Object.assign(new Error(`DeepSeek returned ${response.status}: ${detail.slice(0, 300)}`), { statusCode: 502 });
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error("DeepSeek returned an empty response."), { statusCode: 502 });
  const parsed = JSON.parse(content);
  return {
    answers: validateAnswers(parsed.answers, safeQuestions),
    usage: payload.usage || null,
    model: payload.model || configuredDeepSeekModel(),
  };
}

function decisionProfileForModel(profile) {
  const keys = [
    "firstName", "lastName", "preferredName", "city", "province", "country", "school", "degree",
    "fieldOfStudy", "graduationYear", "startDate", "workTerm", "workAuthorized", "sponsorship",
    "willingToCommute", "willingToRelocate", "willingToTravel", "willingToWorkOnsite",
    "willingFlexibleSchedule", "backgroundCheckConsent", "drugScreeningConsent", "criminalRecord",
    "validSin", "age18OrOlder", "outsideActivitiesConflict", "previouslyWorkedForAuditor",
    "previouslyWorkedForEmployer", "employeeReferral", "relativesAtEmployer", "genderIdentity",
    "pronouns", "sexualOrientation", "visibleMinority", "indigenousIdentity", "raceEthnicity",
    "disabilityStatus", "veteranStatus",
  ];
  return {
    ...Object.fromEntries(keys.map((key) => [key, profile[key] ?? ""])),
    workHistory: (Array.isArray(profile.workExperiences) ? profile.workExperiences : []).map((experience) => ({
      jobTitle: experience.jobTitle || "",
      company: experience.company || "",
      location: experience.location || "",
      startYear: experience.startYear || "",
      endYear: experience.endYear || "",
    })),
    languages: Array.isArray(profile.languages) ? profile.languages : [],
    skills: Array.isArray(profile.skills) ? profile.skills : [],
  };
}

async function resolveStructuredFields({ jobDescription, pageContext, questions, useSensitiveProfile }) {
  const apiKey = configuredDeepSeekKey();
  if (!apiKey || apiKey === "replace_with_a_new_key") {
    throw Object.assign(new Error("A DeepSeek API key is not configured."), { statusCode: 503 });
  }
  const profile = await getProfile();
  const resume = await getResumeText();
  const eligibleQuestions = (Array.isArray(questions) ? questions : [])
    .filter((question) => question && Number.isInteger(question.id) && Array.isArray(question.options) && question.options.length)
    .filter((question) => useSensitiveProfile || !sensitiveQuestion.test(question.label || ""))
    .slice(0, 30);
  if (!eligibleQuestions.length) return { answers: [], model: configuredDeepSeekModel() };

  const system = [
    "You resolve structured job-application fields. Return JSON only in this exact shape:",
    '{"answers":[{"id":0,"value":"exact option","confidence":0.95}]}',
    "For every answer, value must exactly equal one of that question's supplied options.",
    "Map semantically equivalent saved facts to portal wording, for example Male (Mr.) to Male, East Asian Chinese to Chinese, and No disability to No.",
    "Use explicit candidate facts and preferences first. For subjective willingness or preference questions, choose the most employer-positive option consistent with the saved preferences.",
    "Use the resume and complete work history to interpret prior-employer and experience questions.",
    "Never invent a factual, legal, medical, licensing, clearance, education, employment-history, or criminal-history claim.",
    "If the candidate data does not support an answer, omit that question instead of guessing.",
  ].join(" ");

  const request = {
    candidateProfile: useSensitiveProfile ? decisionProfileForModel(profile) : safeProfileForModel(profile),
    resume,
    jobDescription: String(jobDescription || "").slice(0, 16000),
    visiblePageContext: String(pageContext || "").slice(0, 8000),
    questions: eligibleQuestions,
  };
  const baseUrl = String(
    process.env.DEEPSEEK_BASE_URL || runtimeConfig.deepSeek?.baseUrl || "https://api.deepseek.com",
  ).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: configuredDeepSeekModel(),
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(request) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 3000,
      temperature: 0,
      stream: false,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw Object.assign(new Error(`DeepSeek returned ${response.status}: ${detail.slice(0, 300)}`), { statusCode: 502 });
  }
  const payload = await response.json();
  const parsed = JSON.parse(payload?.choices?.[0]?.message?.content || "{}");
  return {
    answers: validateAnswers(parsed.answers, eligibleQuestions, { allowSensitive: useSensitiveProfile }),
    model: payload.model || configuredDeepSeekModel(),
    usage: payload.usage || null,
  };
}

async function extractJobSkills({ jobDescription, pageContext }) {
  const apiKey = configuredDeepSeekKey();
  if (!apiKey || apiKey === "replace_with_a_new_key") {
    throw Object.assign(new Error("A DeepSeek API key is not configured."), { statusCode: 503 });
  }

  const description = String(jobDescription || "").trim();
  const context = String(pageContext || "").trim();
  if (!description && !context) return { skills: [], model: configuredDeepSeekModel() };

  const system = [
    "Extract job-application skill tags from the supplied job description.",
    "Return JSON only in this exact shape: {\"skills\":[\"Skill name\"]}.",
    "Include technical languages, frameworks, platforms, tools, databases, cloud services, engineering practices, domain skills, and certifications that are explicitly required or preferred.",
    "Use concise canonical names suitable for a recruiting-system skill token, such as C#, ASP.NET Core, SQL, Azure, CI/CD, or Agile Software Development.",
    "Do not include responsibilities, personality traits, years of experience, degrees, locations, or complete sentences.",
    "Deduplicate closely equivalent names and return at most 35 skills.",
  ].join(" ");

  const baseUrl = String(
    process.env.DEEPSEEK_BASE_URL || runtimeConfig.deepSeek?.baseUrl || "https://api.deepseek.com",
  ).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: configuredDeepSeekModel(),
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            jobDescription: description.slice(0, 20000),
            visiblePageContext: context.slice(0, 8000),
          }),
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1800,
      temperature: 0,
      stream: false,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw Object.assign(new Error(`DeepSeek returned ${response.status}: ${detail.slice(0, 300)}`), { statusCode: 502 });
  }
  const payload = await response.json();
  const parsed = JSON.parse(payload?.choices?.[0]?.message?.content || "{}");
  const seen = new Set();
  const skills = [];
  for (const candidate of Array.isArray(parsed.skills) ? parsed.skills : []) {
    const skill = String(candidate || "").replace(/^[\s•*-]+|[\s.;,]+$/g, "").trim();
    const key = normalize(skill);
    if (!skill || skill.length > 80 || seen.has(key)) continue;
    seen.add(key);
    skills.push(skill);
    if (skills.length >= 35) break;
  }
  return { skills, model: payload.model || configuredDeepSeekModel() };
}

function allowedOrigin(request) {
  const origin = request.headers.origin || "";
  return !origin || origin === "null" || origin.startsWith("chrome-extension://");
}

function setCors(response, request) {
  const origin = request.headers.origin || "";
  response.setHeader("Access-Control-Allow-Origin", origin.startsWith("chrome-extension://") ? origin : "null");
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

async function readJson(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createServer() {
  return http.createServer(async (request, response) => {
    setCors(response, request);
    if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Only the local Chrome extension may call this backend." });
    if (request.method === "OPTIONS") return sendJson(response, 204, {});

    try {
      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, {
          status: "ok",
          deepSeekConfigured: Boolean(configuredDeepSeekKey() && configuredDeepSeekKey() !== "replace_with_a_new_key"),
          resumeAvailable: existsSync(resumePath),
        });
      }

      if (request.method === "GET" && request.url === "/api/context") {
        const [profile, resumeText, resumeBytes] = await Promise.all([
          getProfile(),
          getResumeText(),
          readFile(resumePath),
        ]);
        return sendJson(response, 200, {
          profile: { ...profile, resumeText },
          resume: {
            name: path.basename(resumePath),
            type: "application/pdf",
            size: resumeBytes.length,
            lastModified: Date.now(),
            base64: resumeBytes.toString("base64"),
          },
        });
      }

      if (request.method === "PUT" && request.url === "/api/profile") {
        const nextProfile = await readJson(request);
        const currentProfile = await getProfile();
        const allowed = new Set(Object.keys(currentProfile));
        const sanitized = Object.fromEntries(Object.entries(nextProfile).filter(([key]) => allowed.has(key)));
        await writeFile(profilePath, `${JSON.stringify({ ...currentProfile, ...sanitized }, null, 2)}\n`, "utf8");
        return sendJson(response, 200, { saved: true });
      }

      if (request.method === "POST" && request.url === "/api/answer") {
        const body = await readJson(request, 2_000_000);
        const result = await callDeepSeek({
          jobDescription: body.jobDescription,
          pageContext: body.pageContext,
          questions: Array.isArray(body.questions) ? body.questions : [],
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/api/extract-skills") {
        const body = await readJson(request, 2_000_000);
        const result = await extractJobSkills({
          jobDescription: body.jobDescription,
          pageContext: body.pageContext,
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/api/resolve-fields") {
        const body = await readJson(request, 2_000_000);
        const result = await resolveStructuredFields({
          jobDescription: body.jobDescription,
          pageContext: body.pageContext,
          questions: body.questions,
          useSensitiveProfile: body.useSensitiveProfile === true,
        });
        return sendJson(response, 200, result);
      }

      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message || "Unexpected backend error." });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    process.stdout.write(`Job Autofill backend listening on http://${displayHost}:${port}\n`);
  });
}
