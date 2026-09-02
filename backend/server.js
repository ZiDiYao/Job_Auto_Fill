import http from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiProviderFactory } from "./ai/ai-provider-factory.js";
import { exchangeNotionAuthorizationCode, getNotionOAuthConfig } from "./notion-oauth.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(currentDirectory, ".env");
const configPath = process.env.JOB_AUTOFILL_CONFIG_PATH
  || path.join(currentDirectory, "config", "local-config.json");

async function loadRuntimeConfig() {
  if (!existsSync(configPath)) return {};
  return JSON.parse(await readFile(configPath, "utf8"));
}

const runtimeConfig = await loadRuntimeConfig();
const profileDefaults = JSON.parse(await readFile(path.join(currentDirectory, "data", "profile.example.json"), "utf8"));

function resolveLocalPath(configuredPath, fallback) {
  if (!configuredPath) return path.join(currentDirectory, fallback);
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(currentDirectory, configuredPath);
}

const profilePath = resolveLocalPath(
  process.env.JOB_AUTOFILL_PROFILE_PATH || runtimeConfig.storage?.profilePath,
  "data/profile.json",
);
const resumePath = resolveLocalPath(
  process.env.JOB_AUTOFILL_RESUME_PATH || runtimeConfig.storage?.resumePath,
  "data/resume.pdf",
);

async function initializeLocalStorage() {
  await mkdir(path.dirname(profilePath), { recursive: true });
  await mkdir(path.dirname(resumePath), { recursive: true });
  if (!existsSync(profilePath)) {
    await copyFile(path.join(currentDirectory, "data", "profile.example.json"), profilePath);
  }
}

await initializeLocalStorage();

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
const aiProviderFactory = new AiProviderFactory({ config: runtimeConfig, env: process.env });

function selectedAiStrategy(profile, requestedProvider) {
  const provider = requestedProvider || profile?.backendAiProvider || runtimeConfig.ai?.provider || "deepseek";
  return aiProviderFactory.create(provider);
}

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
  if (!existsSync(resumePath)) return Promise.resolve("");
  resumeTextPromise ||= extractPdfText(resumePath);
  return resumeTextPromise;
}

async function getProfile() {
  const savedProfile = JSON.parse(await readFile(profilePath, "utf8"));
  if (!savedProfile.nationalTaxIdAvailable && savedProfile.validSin) savedProfile.nationalTaxIdAvailable = savedProfile.validSin;
  if (!savedProfile.meetsMinimumWorkingAge && savedProfile.age18OrOlder) savedProfile.meetsMinimumWorkingAge = savedProfile.age18OrOlder;
  return Object.fromEntries(Object.entries(profileDefaults).map(([key, defaultValue]) => [
    key,
    Object.prototype.hasOwnProperty.call(savedProfile, key) ? savedProfile[key] : defaultValue,
  ]));
}

const sensitiveQuestion = /\b(salary|compensation|criminal|conviction|pending charges?|background|security clearance|bondable|driver'?s? licen[cs]e|transportation|consent|terms|privacy|signature|agree|date of birth|birth date|sin|social insurance|ssn|social security|national insurance|\bnin\b|tax identification|taxpayer id|\btin\b|authori[sz]ed to work|work authori[sz]ation|sponsor|sponsorship|visa|government employee|public official|conflict of interest|non[ -]?compete|restrictive covenant|terminated|dismissed|rehire|gender|sex|sexual orientation|race|racial|ethnic|disability|disabled|veteran|indigenous|aboriginal|first nations?|m[eé]tis|inuit|pronouns?)\b/i;
const neverAutomateQuestion = /\b(submit|send application|sign(?:ed|ing)?|signature|e[ -]?signature|certif(?:y|ication)|attest|declaration|consent to|agree to|terms(?: of use)?|privacy policy|salary|compensation|expected pay|date of birth|birth date|social insurance number|\bsin\b|ssn|social security number|national insurance number|\bnin\b|tax identification number|taxpayer id|\btin\b)\b/i;

function safeProfileForModel(profile) {
  const allowedKeys = [
    "firstName", "lastName", "preferredName", "email", "phone", "city", "province", "country",
    "linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter", "otherSocialUrl", "otherWebsiteUrl",
    "school", "degree", "fieldOfStudy", "gpa", "gpaScale", "educationStartYear",
    "graduationMonth", "graduationDay", "graduationYear", "graduationDate", "startDate", "workTerm",
  ];
  return {
    ...Object.fromEntries(allowedKeys.map((key) => [key, profile[key] || ""])),
    educationEntries: Array.isArray(profile.educationEntries) ? profile.educationEntries.slice(0, 12) : [],
  };
}

const resumeProfileKeys = new Set([
  "firstName", "lastName", "preferredName", "email", "phone", "address", "city", "province",
  "postalCode", "country", "linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter",
  "otherSocialUrl", "otherWebsiteUrl", "school", "degree", "fieldOfStudy",
  "gpa", "gpaScale", "educationStartYear", "graduationMonth", "graduationDay", "graduationYear",
  "graduationDate", "startDate", "workTerm",
]);
const monthNames = new Set([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);
const gpaScales = new Set(["4.0", "4.3", "5.0", "10.0", "20.0", "100", "Letter", "Other"]);
const workTerms = new Set(["3 months", "4 months", "6 months", "8 months", "12 months", "16 months", "4–8 months", "8–12 months", "Flexible"]);
const languageLevels = new Set(["Native or bilingual", "Fluent", "Advanced", "Intermediate", "Classroom"]);

function validProfileYear(value) {
  return /^\d{4}$/.test(value) && Number(value) >= 1950 && Number(value) <= 2100;
}

function validIsoProfileDate(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !validProfileYear(match[1])) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

export function validateResumeProfileFields(rawFields) {
  const result = {};
  for (const field of Array.isArray(rawFields) ? rawFields : []) {
    const key = String(field?.key || "").trim();
    let value = String(field?.value || "").replace(/\s+/g, " ").trim();
    if (!resumeProfileKeys.has(key) || !value || confidenceScore(field?.confidence) < 0.78) continue;
    if (value.length > 200) value = value.slice(0, 200).trim();
    if (key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) continue;
    if (["linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter", "otherSocialUrl", "otherWebsiteUrl"].includes(key) && !/^https?:\/\//i.test(value)) continue;
    if (["educationStartYear", "graduationYear"].includes(key) && !validProfileYear(value)) continue;
    if (key === "graduationDay" && (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 31)) continue;
    if (key === "graduationMonth" && !monthNames.has(value)) continue;
    if (key === "graduationDate" && !validIsoProfileDate(value)) continue;
    if (key === "startDate" && (!/^(\d{4})-(?:0[1-9]|1[0-2])$/.test(value) || !validProfileYear(value.slice(0, 4)))) continue;
    if (key === "gpa" && (!/^\d{1,3}(?:\.\d{1,3})?$/.test(value) || Number(value) > 100)) continue;
    if (key === "gpaScale" && !gpaScales.has(value)) continue;
    if (key === "workTerm" && !workTerms.has(value)) continue;
    result[key] = value;
  }
  return result;
}

export function validateResumeLanguages(rawLanguages) {
  const languages = [];
  const seen = new Set();
  for (const rawLanguage of Array.isArray(rawLanguages) ? rawLanguages : []) {
    const name = String(rawLanguage?.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const level = String(rawLanguage?.level || "").trim();
    const key = name.toLocaleLowerCase("en");
    if (!name || !/^[\p{L}\p{M} .()'’/-]+$/u.test(name) || !languageLevels.has(level)
      || confidenceScore(rawLanguage?.confidence) < 0.78 || seen.has(key)) continue;
    seen.add(key);
    languages.push({
      name,
      fluent: level === "Native or bilingual" || level === "Fluent",
      overall: level,
      reading: level,
      speaking: level,
      writing: level,
    });
    if (languages.length >= 12) break;
  }
  return languages;
}

export function validateResumeEducationEntries(rawEntries) {
  const entries = [];
  const seen = new Set();
  for (const rawEntry of Array.isArray(rawEntries) ? rawEntries : []) {
    if (confidenceScore(rawEntry?.confidence) < 0.78) continue;
    const entry = {
      school: String(rawEntry?.school || "").replace(/\s+/g, " ").trim().slice(0, 160),
      degree: String(rawEntry?.degree || "").replace(/\s+/g, " ").trim().slice(0, 120),
      fieldOfStudy: String(rawEntry?.fieldOfStudy || "").replace(/\s+/g, " ").trim().slice(0, 120),
      gpa: String(rawEntry?.gpa || "").trim().slice(0, 16),
      gpaScale: String(rawEntry?.gpaScale || "").trim(),
      startMonth: String(rawEntry?.startMonth || "").trim(),
      startDay: String(rawEntry?.startDay || "").trim(),
      startYear: String(rawEntry?.startYear || "").trim(),
      endMonth: String(rawEntry?.endMonth || "").trim(),
      endDay: String(rawEntry?.endDay || "").trim(),
      endYear: String(rawEntry?.endYear || "").trim(),
      graduationDate: String(rawEntry?.graduationDate || "").trim(),
    };
    if (!entry.school) continue;
    if (entry.gpa && (!/^\d{1,3}(?:\.\d{1,3})?$/.test(entry.gpa) || Number(entry.gpa) > 100)) entry.gpa = "";
    if (entry.gpaScale && !gpaScales.has(entry.gpaScale)) entry.gpaScale = "";
    for (const key of ["startMonth", "endMonth"]) {
      if (entry[key] && !monthNames.has(entry[key])) entry[key] = "";
    }
    for (const key of ["startYear", "endYear"]) {
      if (entry[key] && !validProfileYear(entry[key])) entry[key] = "";
    }
    for (const key of ["startDay", "endDay"]) {
      if (entry[key] && (!/^\d{1,2}$/.test(entry[key]) || Number(entry[key]) < 1 || Number(entry[key]) > 31)) entry[key] = "";
    }
    if (entry.graduationDate && !validIsoProfileDate(entry.graduationDate)) entry.graduationDate = "";
    if (entry.graduationDate) {
      const [year, month, day] = entry.graduationDate.split("-");
      entry.endYear ||= year;
      entry.endMonth ||= [...monthNames][Number(month) - 1] || "";
      entry.endDay ||= String(Number(day));
    }
    const key = `${entry.school}|${entry.degree}|${entry.endYear}`.toLocaleLowerCase("en");
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= 12) break;
  }
  return entries;
}

async function extractResumeProfile({ resumeText, provider }) {
  const profile = await getProfile();
  const resume = String(resumeText || profile.resumeText || await getResumeText().catch(() => "")).trim();
  if (!resume) throw Object.assign(new Error("No resume text is available to analyze."), { statusCode: 400 });
  const aiStrategy = selectedAiStrategy(profile, provider);
  const system = [
    "Extract candidate profile facts from a resume. Return JSON only in this exact shape:",
    '{"fields":[{"key":"firstName","value":"Ada","confidence":0.98}],"educationEntries":[{"school":"Example University","degree":"Master of Science","fieldOfStudy":"Computer Science","gpa":"3.8","gpaScale":"4.0","startMonth":"September","startDay":"","startYear":"2024","endMonth":"May","endDay":"","endYear":"2026","graduationDate":"","confidence":0.98}],"languages":[{"name":"Spanish","level":"Fluent","confidence":0.95}]}',
    `Allowed keys: ${[...resumeProfileKeys].join(", ")}.`,
    "Include a field only when its value is explicitly supported by the resume. Never guess or infer missing facts.",
    "Never extract or infer work authorization, sponsorship, age, government identifiers, criminal history, medical/disability information, demographics, gender, race, veteran status, consent, preferences, or other legal facts.",
    "Preserve names and organization capitalization exactly. Do not truncate names.",
    "Use YYYY-MM-DD for an exact graduation date, YYYY-MM for available start date, full English month names, and four digits for years.",
    "If only a graduation month and year are stated, return graduationMonth and graduationYear separately; never invent a day.",
    "Return every explicitly listed education record in educationEntries, including high school, college, bachelor's, master's, and doctoral education. Keep each school as a separate record and order current or most recent education first.",
    "For educationEntries use startMonth/startDay/startYear and endMonth/endDay/endYear. Leave unknown values empty and never combine two schools into one record.",
    "GPA scale must be one of 4.0, 4.3, 5.0, 10.0, 20.0, 100, Letter, Other. Omit it when unstated.",
    `workTerm must be one of: ${[...workTerms].join(", ")}. Omit it when the resume does not state availability.`,
    `Language level must be one of: ${[...languageLevels].join(", ")}. Return a language only when both the language and proficiency are explicitly supported by the resume; never assume English or any other language.`,
  ].join(" ");
  const completion = await aiStrategy.completeJson({
    system,
    request: { resume: resume.slice(0, 24000) },
    maxTokens: 2500,
    temperature: 0,
  });
  const languages = validateResumeLanguages(completion.data.languages);
  const educationEntries = validateResumeEducationEntries(completion.data.educationEntries);
  const primaryEducation = educationEntries[0];
  return {
    profile: {
      ...validateResumeProfileFields(completion.data.fields),
      ...(primaryEducation ? {
        school: primaryEducation.school,
        degree: primaryEducation.degree,
        fieldOfStudy: primaryEducation.fieldOfStudy,
        gpa: primaryEducation.gpa,
        gpaScale: primaryEducation.gpaScale,
        educationStartYear: primaryEducation.startYear,
        graduationMonth: primaryEducation.endMonth,
        graduationDay: primaryEducation.endDay,
        graduationYear: primaryEducation.endYear,
        graduationDate: primaryEducation.graduationDate,
        educationEntries,
      } : {}),
      ...(languages.length ? { languages } : {}),
    },
    usage: completion.usage,
    model: completion.model,
    provider: completion.provider,
  };
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function confidenceScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
}

export function validateAnswers(rawAnswers, questions, { allowSensitive = false } = {}) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const validated = [];
  for (const answer of Array.isArray(rawAnswers) ? rawAnswers : []) {
    const question = byId.get(answer?.id);
    if (!question || (!allowSensitive && sensitiveQuestion.test(question.label || ""))) continue;
    let value = String(answer.value || "").trim();
    const confidence = confidenceScore(answer.confidence);
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

export function validateFieldPlans(rawPlans, fields, { allowSensitive = false } = {}) {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const plans = [];
  for (const rawPlan of Array.isArray(rawPlans) ? rawPlans : []) {
    const field = byId.get(rawPlan?.id);
    if (!field || neverAutomateQuestion.test(field.label || "")) continue;
    if (!allowSensitive && sensitiveQuestion.test(field.label || "")) continue;
    const confidence = confidenceScore(rawPlan.confidence);
    if (confidence < 0.7) continue;

    const options = Array.isArray(field.options) ? field.options.map(String) : [];
    const exactOption = (candidate) => options.find((option) => normalize(option) === normalize(candidate));
    if (field.multiple && options.length) {
      const values = [...new Set((Array.isArray(rawPlan.values) ? rawPlan.values : [rawPlan.value])
        .map(exactOption)
        .filter(Boolean))];
      if (!values.length) continue;
      plans.push({ id: field.id, operation: "select_many", values, confidence });
      continue;
    }

    let value = String(rawPlan.value || rawPlan.values?.[0] || "").trim();
    if (!value) continue;
    if (options.length) {
      value = exactOption(value) || "";
      if (!value) continue;
      plans.push({ id: field.id, operation: "select", value, confidence });
      continue;
    }

    if (!["text", "textarea"].includes(field.type)) continue;
    if (Number(field.maxLength) > 0) value = value.slice(0, Number(field.maxLength));
    plans.push({ id: field.id, operation: "fill", value, confidence });
  }
  return plans;
}

async function answerQuestions({ jobDescription, pageContext, questions, provider }) {
  const profile = await getProfile();
  const aiStrategy = selectedAiStrategy(profile, provider);
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

  const completion = await aiStrategy.completeJson({ system, request, maxTokens: 4000, temperature: 0 });
  return {
    answers: validateAnswers(completion.data.answers, safeQuestions),
    usage: completion.usage,
    model: completion.model,
    provider: completion.provider,
  };
}

function decisionProfileForModel(profile) {
  const keys = [
    "firstName", "lastName", "preferredName", "email", "phone", "address", "city", "province",
    "postalCode", "country", "linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter",
    "otherSocialUrl", "otherWebsiteUrl", "school", "degree",
    "fieldOfStudy", "gpa", "gpaScale", "educationStartYear", "graduationMonth", "graduationDay", "graduationYear",
    "graduationDate", "startDate", "workTerm", "workAuthorized", "sponsorship",
    "willingToCommute", "willingToRelocate", "willingToTravel", "willingToWorkOnsite",
    "willingFlexibleSchedule", "backgroundCheckConsent", "drugScreeningConsent", "criminalRecord",
    "pendingCriminalCharges", "nationalTaxIdAvailable", "meetsMinimumWorkingAge", "holdsSecurityClearance",
    "eligibleForSecurityClearance", "bondable", "validDriversLicense", "reliableTransportation",
    "outsideActivitiesConflict", "conflictOfInterest", "previouslyWorkedForAuditor",
    "previouslyWorkedForEmployer", "previouslyAppliedToEmployer", "previouslyInterviewedByEmployer",
    "employeeReferral", "relativesAtEmployer", "governmentEmployee", "publicOfficial",
    "restrictiveCovenant", "terminatedForCause", "eligibleForRehire", "genderIdentity",
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
    educationEntries: Array.isArray(profile.educationEntries) ? profile.educationEntries.slice(0, 12) : [],
    languages: Array.isArray(profile.languages) ? profile.languages : [],
    skills: Array.isArray(profile.skills) ? profile.skills : [],
  };
}

async function resolveStructuredFields({ jobDescription, pageContext, questions, useSensitiveProfile, provider }) {
  const profile = await getProfile();
  const aiStrategy = selectedAiStrategy(profile, provider);
  const resume = await getResumeText();
  const eligibleQuestions = (Array.isArray(questions) ? questions : [])
    .filter((question) => question && Number.isInteger(question.id) && Array.isArray(question.options) && question.options.length)
    .filter((question) => useSensitiveProfile || !sensitiveQuestion.test(question.label || ""))
    .slice(0, 30);
  if (!eligibleQuestions.length) return { answers: [], model: aiStrategy.model, provider: aiStrategy.name.toLowerCase() };

  const system = [
    "You resolve structured job-application fields. Return JSON only in this exact shape:",
    '{"answers":[{"id":0,"value":"exact option","confidence":0.95}]}',
    "For every answer, value must exactly equal one of that question's supplied options.",
    "Map semantically equivalent saved facts to portal wording, for example Male (Mr.) to Male, East Asian Chinese to Chinese, and No disability to No.",
    "Use explicit candidate facts and preferences first. For subjective willingness or preference questions, choose the most employer-positive option consistent with the saved preferences.",
    "For a recruitment-source question such as How did you hear about us, infer from the current application context: prefer the employer careers/company website when offered, otherwise an internet job board or internet search; never choose employee referral, agency, campus event, or personal contact without explicit evidence.",
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
  const completion = await aiStrategy.completeJson({ system, request, maxTokens: 3000, temperature: 0 });
  return {
    answers: validateAnswers(completion.data.answers, eligibleQuestions, { allowSensitive: useSensitiveProfile }),
    model: completion.model,
    usage: completion.usage,
    provider: completion.provider,
  };
}

async function planDomFields({ jobDescription, pageContext, fields, useSensitiveProfile, provider }) {
  const profile = await getProfile();
  const aiStrategy = selectedAiStrategy(profile, provider);
  const resume = await getResumeText();
  const eligibleFields = (Array.isArray(fields) ? fields : [])
    .filter((field) => field && Number.isInteger(field.id) && String(field.label || "").trim())
    .filter((field) => ["text", "textarea", "select", "radio", "checkbox", "combobox"].includes(field.type))
    .filter((field) => !neverAutomateQuestion.test(field.label || ""))
    .filter((field) => useSensitiveProfile || !sensitiveQuestion.test(field.label || ""))
    .slice(0, 45)
    .map((field) => ({
      id: field.id,
      label: String(field.label).slice(0, 600),
      section: String(field.section || "").slice(0, 300),
      type: field.type,
      required: Boolean(field.required),
      multiple: Boolean(field.multiple),
      placeholder: String(field.placeholder || "").slice(0, 180),
      currentValue: String(field.currentValue || "").slice(0, 300),
      maxLength: Math.max(0, Math.min(5000, Number(field.maxLength || 0))),
      options: [...new Set((Array.isArray(field.options) ? field.options : [])
        .map((option) => String(option || "").trim())
        .filter(Boolean))].slice(0, 60),
    }));
  if (!eligibleFields.length) return { plans: [], model: aiStrategy.model, provider: aiStrategy.name.toLowerCase() };

  const system = [
    "You plan values for visible fields in a job application. Return JSON only in this exact shape:",
    '{"plans":[{"id":0,"value":"answer","values":["option"],"confidence":0.95}]}',
    "The supplied fields are a semantic summary of the current page DOM. Treat each numeric id as opaque.",
    "For fields with options, value (or each item in values for a multiple field) must exactly equal a supplied option.",
    "Use only facts explicitly present in the candidate profile or resume. Use the job description only to tailor truthful written answers.",
    "Use saved candidate facts and preferences to map equivalent portal wording. Never infer a referral, credential, employer, date, technology, authorization, demographic trait, medical fact, criminal-history fact, or conflict-of-interest fact.",
    "For subjective willingness and preference questions, choose the most employer-positive option that is consistent with the saved profile.",
    "For recruitment source, prefer an employer/company careers website when offered, otherwise an internet job board or internet search; never claim a referral or personal contact without evidence.",
    "Omit any field when evidence is missing. Never plan a submit, continue, signature, certification, attestation, consent, privacy, terms, compensation, government identifier, or birth-date action.",
    "Keep factual text short. Use 60-140 first-person words only for genuine essay or motivation fields.",
  ].join(" ");

  const request = {
    candidateProfile: useSensitiveProfile ? decisionProfileForModel(profile) : safeProfileForModel(profile),
    resume,
    jobDescription: String(jobDescription || "").slice(0, 16000),
    visiblePageContext: String(pageContext || "").slice(0, 6000),
    visibleDomFields: eligibleFields,
  };
  const completion = await aiStrategy.completeJson({ system, request, maxTokens: 5000, temperature: 0 });
  return {
    plans: validateFieldPlans(completion.data.plans, eligibleFields, { allowSensitive: useSensitiveProfile }),
    model: completion.model,
    usage: completion.usage,
    provider: completion.provider,
  };
}

export function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed))) : fallback;
}

const likelyNonTechnicalSkill = /\b(communication|teamwork|collaboration|leadership|negotiation|presentation|adaptability|interpersonal|time management|problem solving|critical thinking|mentoring|creativity)\b/i;

export function isLikelyTechnicalSkill(value) {
  return !likelyNonTechnicalSkill.test(String(value || ""));
}

export function normalizeSkillKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
}

export function parseSkillBlacklist(value) {
  const entries = Array.isArray(value) ? value : String(value || "").split(/[,;\n|]+/);
  return [...new Set(entries.map(normalizeSkillKey).filter(Boolean))];
}

export function rankSkillCandidates(rawSkills, { maxSkills = 15, maxNonTechnicalSkills = 2, blacklistedSkills = [] } = {}) {
  const totalLimit = boundedInteger(maxSkills, 15, 1, 50);
  const nonTechnicalLimit = boundedInteger(maxNonTechnicalSkills, 2, 0, Math.min(5, totalLimit));
  const blacklist = new Set(parseSkillBlacklist(blacklistedSkills));
  const seen = new Set();
  const candidates = [];

  for (const [index, candidate] of (Array.isArray(rawSkills) ? rawSkills : []).entries()) {
    const rawName = typeof candidate === "string" ? candidate : candidate?.name;
    const name = String(rawName || "").replace(/^[\s•*-]+|[\s.;,]+$/g, "").trim();
    const key = normalizeSkillKey(name);
    if (!name || name.length > 80 || !key || seen.has(key) || blacklist.has(key)) continue;
    seen.add(key);

    const sourceText = normalize(typeof candidate === "object" ? candidate?.source : "jd");
    const source = sourceText.includes("both") || (sourceText.includes("jd") && sourceText.includes("resume"))
      ? "both"
      : sourceText.includes("resume") || sourceText.includes("profile")
        ? "resume"
        : "jd";
    const technical = typeof candidate === "object" ? candidate?.technical !== false : true;
    const tier = source === "both" ? 0 : technical ? 1 : source === "resume" ? 2 : 3;
    candidates.push({ name, source, technical, tier, index });
  }

  candidates.sort((left, right) => left.tier - right.tier || left.index - right.index);
  const selected = [];
  let nonTechnicalCount = 0;
  for (const candidate of candidates) {
    if (!candidate.technical) {
      if (nonTechnicalCount >= nonTechnicalLimit) continue;
      nonTechnicalCount += 1;
    }
    selected.push(candidate);
    if (selected.length >= totalLimit) break;
  }

  return selected.map(({ tier: _tier, index: _index, ...candidate }) => candidate);
}

async function extractJobSkills({ jobDescription, pageContext, maxSkills, maxNonTechnicalSkills, provider }) {
  const description = String(jobDescription || "").trim();
  const context = String(pageContext || "").trim();
  const profile = await getProfile();
  const aiStrategy = selectedAiStrategy(profile, provider);
  const totalLimit = boundedInteger(maxSkills ?? profile.maxSkills, 15, 1, 50);
  const nonTechnicalLimit = boundedInteger(
    maxNonTechnicalSkills ?? profile.maxNonTechnicalSkills,
    2,
    0,
    Math.min(5, totalLimit),
  );
  const profileSkills = Array.isArray(profile.skills) ? profile.skills.map(String).filter(Boolean) : [];
  const blacklistedSkills = parseSkillBlacklist(profile.skillBlacklist);
  const resume = String(profile.resumeText || await getResumeText().catch(() => "")).trim();
  if (!description && !context && !resume) {
    const rankedSkills = rankSkillCandidates(
      profileSkills.map((name) => ({ name, source: "resume", technical: isLikelyTechnicalSkill(name) })),
      { maxSkills: totalLimit, maxNonTechnicalSkills: nonTechnicalLimit, blacklistedSkills },
    );
    return { skills: rankedSkills.map(({ name }) => name), rankedSkills, maxSkills: totalLimit, maxNonTechnicalSkills: nonTechnicalLimit, model: aiStrategy.model, provider: aiStrategy.name.toLowerCase() };
  }

  const system = [
    "Rank job-application skill tokens using the supplied JD, resume, and saved profile skills.",
    "Return JSON only in this exact shape: {\"skills\":[{\"name\":\"Skill name\",\"source\":\"both|jd|resume\",\"technical\":true}]}.",
    "source=both only when the skill is supported by both the JD and the resume/profile; source=jd when it appears only in the JD; source=resume when it appears only in the resume/profile.",
    "When no job description is supplied, create a resume-only baseline: include only skills supported by the resume/profile and label their source as resume.",
    "Order candidates by: (1) skills supported by both JD and resume/profile, (2) job-relevant technical or hard/domain skills, (3) resume/profile-only skills, and finally a very small number of genuinely useful non-technical skills.",
    "Technical/hard skills include languages, frameworks, platforms, tools, databases, cloud services, engineering practices, certifications, and concrete domain methods. Mark communication, teamwork, negotiation, leadership, adaptability, generic developer/software terms, and similar traits as technical=false.",
    "Use concise canonical recruiting-system names such as C#, ASP.NET Core, SQL, Azure, CI/CD, Apache Kafka, or Unit Testing. Never output complete sentences, responsibilities, years, degrees, locations, or vague labels such as Developer or Software.",
    "Never return a skill listed in neverIncludeSkills, even when the JD requests it.",
    `Return at most ${Math.min(50, Math.max(totalLimit * 2, totalLimit + 8))} ranked candidates so the server can enforce a final limit of ${totalLimit} skills and ${nonTechnicalLimit} non-technical skills.`,
  ].join(" ");

  const completion = await aiStrategy.completeJson({
    system,
    request: {
      jobDescription: description.slice(0, 20000),
      visiblePageContext: context.slice(0, 8000),
      savedProfileSkills: profileSkills.slice(0, 80),
      neverIncludeSkills: blacklistedSkills,
      resume: resume.slice(0, 30000),
    },
    maxTokens: 3000,
    temperature: 0,
  });
  const rankedSkills = rankSkillCandidates(completion.data.skills, {
    maxSkills: totalLimit,
    maxNonTechnicalSkills: nonTechnicalLimit,
    blacklistedSkills,
  });
  return {
    skills: rankedSkills.map(({ name }) => name),
    rankedSkills,
    maxSkills: totalLimit,
    maxNonTechnicalSkills: nonTechnicalLimit,
    model: completion.model,
    usage: completion.usage,
    provider: completion.provider,
  };
}

export function allowedOrigin(request) {
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must contain valid JSON."), { statusCode: 400 });
  }
}

export function createServer() {
  return http.createServer(async (request, response) => {
    setCors(response, request);
    if (!allowedOrigin(request)) return sendJson(response, 403, { error: "Only the local Chrome extension may call this backend." });
    if (request.method === "OPTIONS") return sendJson(response, 204, {});

    try {
      if (request.method === "GET" && request.url === "/health") {
        const providers = aiProviderFactory.status();
        return sendJson(response, 200, {
          status: "ok",
          providers,
          deepSeekConfigured: providers.deepseek.configured,
          resumeAvailable: existsSync(resumePath),
        });
      }

      if (request.method === "GET" && request.url === "/api/context") {
        const [profile, resumeText] = await Promise.all([getProfile(), getResumeText()]);
        const resumeBytes = existsSync(resumePath) ? await readFile(resumePath) : null;
        return sendJson(response, 200, {
          profile: { ...profile, resumeText },
          resume: resumeBytes ? {
            name: profile.resumeFileName || path.basename(resumePath),
            type: "application/pdf",
            size: resumeBytes.length,
            lastModified: Date.now(),
            base64: resumeBytes.toString("base64"),
          } : null,
        });
      }

      if (request.method === "GET" && request.url === "/api/notion/oauth-config") {
        const notionOAuth = getNotionOAuthConfig(runtimeConfig, process.env);
        return sendJson(response, 200, { configured: Boolean(notionOAuth.clientId && notionOAuth.clientSecret), clientId: notionOAuth.clientId });
      }

      if (request.method === "POST" && request.url === "/api/notion/oauth/exchange") {
        const body = await readJson(request);
        const result = await exchangeNotionAuthorizationCode({
          code: body.code,
          redirectUri: body.redirectUri,
          config: getNotionOAuthConfig(runtimeConfig, process.env),
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "PUT" && request.url === "/api/resume") {
        const body = await readJson(request, 8_000_000);
        const originalName = path.basename(String(body.name || "resume.pdf"));
        if (!/\.pdf$/i.test(originalName)) {
          throw Object.assign(new Error("Only PDF resumes are supported."), { statusCode: 400 });
        }
        const bytes = Buffer.from(String(body.base64 || ""), "base64");
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) {
          throw Object.assign(new Error("Resume PDF must be between 1 byte and 5 MB."), { statusCode: 400 });
        }
        if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
          throw Object.assign(new Error("The uploaded file is not a valid PDF."), { statusCode: 400 });
        }
        await writeFile(resumePath, bytes);
        resumeTextPromise = undefined;
        const resumeText = await getResumeText();
        const currentProfile = await getProfile();
        await writeFile(profilePath, `${JSON.stringify({
          ...currentProfile,
          resumeFileName: originalName,
          resumeText,
        }, null, 2)}\n`, "utf8");
        return sendJson(response, 200, {
          saved: true,
          resumeText,
          resume: {
            name: originalName,
            type: "application/pdf",
            size: bytes.length,
            lastModified: Number(body.lastModified || Date.now()),
          },
        });
      }

      if (request.method === "PUT" && request.url === "/api/profile") {
        const nextProfile = await readJson(request);
        const currentProfile = await getProfile();
        const allowed = new Set(Object.keys(profileDefaults));
        const sanitized = Object.fromEntries(Object.entries(nextProfile).filter(([key]) => allowed.has(key)));
        await writeFile(profilePath, `${JSON.stringify({ ...currentProfile, ...sanitized }, null, 2)}\n`, "utf8");
        return sendJson(response, 200, { saved: true });
      }

      if (request.method === "POST" && request.url === "/api/answer") {
        const body = await readJson(request, 2_000_000);
        const result = await answerQuestions({
          jobDescription: body.jobDescription,
          pageContext: body.pageContext,
          questions: Array.isArray(body.questions) ? body.questions : [],
          provider: body.provider,
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/api/extract-skills") {
        const body = await readJson(request, 2_000_000);
        const result = await extractJobSkills({
          jobDescription: body.jobDescription,
          pageContext: body.pageContext,
          maxSkills: body.maxSkills,
          maxNonTechnicalSkills: body.maxNonTechnicalSkills,
          provider: body.provider,
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/api/extract-profile") {
        const body = await readJson(request, 2_000_000);
        const result = await extractResumeProfile({ resumeText: body.resumeText, provider: body.provider });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/api/resolve-fields") {
        const body = await readJson(request, 2_000_000);
        const result = await resolveStructuredFields({
          jobDescription: body.jobDescription,
          pageContext: body.pageContext,
          questions: body.questions,
          useSensitiveProfile: body.useSensitiveProfile === true,
          provider: body.provider,
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/api/plan-fields") {
        const body = await readJson(request, 3_000_000);
        const result = await planDomFields({
          jobDescription: body.jobDescription,
          pageContext: body.pageContext,
          fields: body.fields,
          useSensitiveProfile: body.useSensitiveProfile === true,
          provider: body.provider,
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
