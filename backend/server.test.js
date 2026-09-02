import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allowedOrigin,
  boundedInteger,
  confidenceScore,
  isLikelyTechnicalSkill,
  rankSkillCandidates,
  validateAnswers,
  validateFieldPlans,
} from "./server.js";

test("ships blank candidate and credential templates", async () => {
  const profile = JSON.parse(await readFile(new URL("./data/profile.example.json", import.meta.url), "utf8"));
  const config = JSON.parse(await readFile(new URL("./config/local-config.example.json", import.meta.url), "utf8"));
  const candidateFields = [
    "firstName", "lastName", "email", "phone", "address", "city", "province", "postalCode",
    "country", "school", "gpa", "graduationYear", "workAuthorized", "sponsorship",
    "criminalRecord", "pendingCriminalCharges", "nationalTaxIdAvailable", "meetsMinimumWorkingAge", "holdsSecurityClearance",
    "eligibleForSecurityClearance", "bondable", "validDriversLicense", "reliableTransportation",
    "conflictOfInterest", "previouslyAppliedToEmployer", "previouslyInterviewedByEmployer",
    "governmentEmployee", "publicOfficial", "restrictiveCovenant", "terminatedForCause",
    "eligibleForRehire",
  ];

  assert.ok(candidateFields.every((key) => profile[key] === ""));
  assert.deepEqual(profile.workExperiences, []);
  assert.deepEqual(profile.educationEntries, []);
  assert.deepEqual(profile.languages, []);
  assert.deepEqual(profile.skills, []);
  assert.deepEqual(profile.indeedPreferences, {});
  assert.equal(config.deepSeek.apiKey, "");
  assert.equal(config.openAI.apiKey, "");
  assert.equal(config.notion.oauth.clientId, "");
  assert.equal(config.notion.oauth.clientSecret, "");
  assert.equal(config.storage.resumePath, "./data/resume.pdf");
});

test("ranks shared evidence first and enforces total and non-technical limits", () => {
  assert.deepEqual(
    rankSkillCandidates([
      { name: "Communication", source: "both", technical: false },
      { name: "Negotiation", source: "jd", technical: false },
      { name: "Leadership", source: "resume", technical: false },
      { name: "PowerShell", source: "resume", technical: true },
      { name: "Java", source: "jd", technical: true },
      { name: "SQL", source: "both", technical: true },
      { name: "Git", source: "resume", technical: true },
    ], { maxSkills: 5, maxNonTechnicalSkills: 1 }),
    [
      { name: "Communication", source: "both", technical: false },
      { name: "SQL", source: "both", technical: true },
      { name: "PowerShell", source: "resume", technical: true },
      { name: "Java", source: "jd", technical: true },
      { name: "Git", source: "resume", technical: true },
    ],
  );
});

test("deduplicates skill candidates and supports a zero soft-skill budget", () => {
  assert.deepEqual(
    rankSkillCandidates([
      { name: " Apache Kafka ", source: "both", technical: true },
      { name: "apache-kafka", source: "jd", technical: true },
      { name: "Teamwork", source: "both", technical: false },
    ], { maxSkills: 10, maxNonTechnicalSkills: 0 }),
    [{ name: "Apache Kafka", source: "both", technical: true }],
  );
});

test("skill ranking rejects malformed values and normalizes source metadata", () => {
  assert.deepEqual(
    rankSkillCandidates([
      null,
      " TypeScript; ",
      { name: "", source: "both", technical: true },
      { name: "x".repeat(81), source: "jd", technical: true },
      { name: "PostgreSQL", source: "profile", technical: true },
      { name: "Mentoring", source: "JD + Resume", technical: false },
    ], { maxSkills: 10, maxNonTechnicalSkills: 1 }),
    [
      { name: "Mentoring", source: "both", technical: false },
      { name: "TypeScript", source: "jd", technical: true },
      { name: "PostgreSQL", source: "resume", technical: true },
    ],
  );
});

test("skill limits are bounded and invalid limits fall back safely", () => {
  const candidates = Array.from({ length: 60 }, (_, index) => ({
    name: `Technology ${index}`,
    source: "jd",
    technical: true,
  }));
  assert.equal(rankSkillCandidates(candidates, { maxSkills: 500 }).length, 50);
  assert.equal(rankSkillCandidates(candidates, { maxSkills: 0 }).length, 1);
  assert.equal(rankSkillCandidates(candidates, { maxSkills: "invalid" }).length, 15);
});

test("boundedInteger truncates, clamps, and falls back for non-finite input", () => {
  assert.equal(boundedInteger(4.9, 3, 1, 10), 4);
  assert.equal(boundedInteger(-5, 3, 1, 10), 1);
  assert.equal(boundedInteger(50, 3, 1, 10), 10);
  assert.equal(boundedInteger(Number.NaN, 3, 1, 10), 3);
  assert.equal(boundedInteger(Number.POSITIVE_INFINITY, 3, 1, 10), 3);
});

test("local skill classification recognizes common soft skills", () => {
  assert.equal(isLikelyTechnicalSkill("Teamwork"), false);
  assert.equal(isLikelyTechnicalSkill("Stakeholder Communication"), false);
  assert.equal(isLikelyTechnicalSkill("Time Management"), false);
  assert.equal(isLikelyTechnicalSkill("C#"), true);
  assert.equal(isLikelyTechnicalSkill("Azure DevOps"), true);
});

test("confidence scores clamp finite values and reject invalid values", () => {
  assert.equal(confidenceScore(1.5), 1);
  assert.equal(confidenceScore(-1), 0);
  assert.equal(confidenceScore("0.81"), 0.81);
  assert.equal(confidenceScore("not-a-number"), 0);
  assert.equal(confidenceScore(Number.NaN), 0);
});

test("normalizes an exact portal option and rejects invented options", () => {
  const fields = [{ id: 0, label: "Are you willing to commute?", type: "select", options: ["Yes", "No"] }];
  assert.deepEqual(
    validateFieldPlans([
      { id: 0, value: "yes", confidence: 0.96 },
      { id: 0, value: "Absolutely", confidence: 0.99 },
    ], fields),
    [{ id: 0, operation: "select", value: "Yes", confidence: 0.96 }],
  );
});

test("validates multiple checkbox choices against the DOM option list", () => {
  const fields = [{
    id: 2,
    label: "Select applicable technologies",
    type: "checkbox",
    multiple: true,
    options: ["Java", "C#", "Python"],
  }];
  assert.deepEqual(
    validateFieldPlans([{ id: 2, values: ["java", "Rust", "C#"], confidence: 0.91 }], fields),
    [{ id: 2, operation: "select_many", values: ["Java", "C#"], confidence: 0.91 }],
  );
});

test("rejects low-confidence and always-blocked actions", () => {
  const fields = [
    { id: 3, label: "Submit application", type: "select", options: ["Yes"] },
    { id: 4, label: "Preferred office", type: "select", options: ["Toronto"] },
  ];
  assert.deepEqual(validateFieldPlans([
    { id: 3, value: "Yes", confidence: 1 },
    { id: 4, value: "Toronto", confidence: 0.4 },
  ], fields), []);
});

test("requires sensitive permission and enforces text length", () => {
  const sensitive = [{ id: 5, label: "What is your gender?", type: "select", options: ["Male", "Female"] }];
  assert.deepEqual(validateFieldPlans([{ id: 5, value: "Male", confidence: 0.9 }], sensitive), []);
  assert.deepEqual(
    validateFieldPlans([{ id: 5, value: "male", confidence: 0.9 }], sensitive, { allowSensitive: true }),
    [{ id: 5, operation: "select", value: "Male", confidence: 0.9 }],
  );

  const text = [{ id: 6, label: "Short answer", type: "text", maxLength: 5, options: [] }];
  assert.deepEqual(
    validateFieldPlans([{ id: 6, value: "abcdefgh", confidence: 0.8 }], text),
    [{ id: 6, operation: "fill", value: "abcde", confidence: 0.8 }],
  );
});

test("field-plan validation ignores malformed, unknown, empty, and unsupported plans", () => {
  const fields = [
    { id: 1, label: "Name", type: "text", options: [] },
    { id: 2, label: "Custom widget", type: "combobox", options: [] },
  ];
  assert.deepEqual(validateFieldPlans([
    null,
    { id: 99, value: "Unknown", confidence: 1 },
    { id: 1, value: "", confidence: 1 },
    { id: 1, value: "Valid", confidence: "bad" },
    { id: 2, value: "Cannot type freely", confidence: 1 },
  ], fields), []);
  assert.deepEqual(validateFieldPlans("not-an-array", fields), []);
});

test("field-plan validation clamps high confidence and accepts textarea values", () => {
  const fields = [{ id: 7, label: "Why this role?", type: "textarea", maxLength: 12, options: [] }];
  assert.deepEqual(
    validateFieldPlans([{ id: 7, value: "A specific reason", confidence: 8 }], fields),
    [{ id: 7, operation: "fill", value: "A specific r", confidence: 1 }],
  );
});

test("multiple selections are deduplicated and require exact supplied options", () => {
  const fields = [{
    id: 8,
    label: "Select languages",
    type: "checkbox",
    multiple: true,
    options: ["Java", "Python"],
  }];
  assert.deepEqual(
    validateFieldPlans([{ id: 8, values: ["java", "JAVA", "Rust"], confidence: 0.9 }], fields),
    [{ id: 8, operation: "select_many", values: ["Java"], confidence: 0.9 }],
  );
  assert.deepEqual(validateFieldPlans([{ id: 8, values: ["Rust"], confidence: 1 }], fields), []);
});

test("always-blocked actions stay blocked even with sensitive permission", () => {
  const fields = [
    { id: 9, label: "Enter your signature", type: "text", options: [] },
    { id: 10, label: "Expected compensation", type: "text", options: [] },
    { id: 11, label: "Social insurance number", type: "text", options: [] },
  ];
  assert.deepEqual(validateFieldPlans(fields.map((field) => ({
    id: field.id,
    value: "test",
    confidence: 1,
  })), fields, { allowSensitive: true }), []);
});

test("answer validation normalizes exact options and truncates text", () => {
  const questions = [
    { id: 1, label: "Preferred arrangement", type: "select", options: ["Hybrid", "Remote"] },
    { id: 2, label: "Short statement", type: "text", maxLength: 5 },
  ];
  assert.deepEqual(validateAnswers([
    { id: 1, value: "hybrid", confidence: 0.8 },
    { id: 2, value: "abcdefgh", confidence: 2 },
  ], questions), [
    { id: 1, value: "Hybrid", confidence: 0.8 },
    { id: 2, value: "abcde", confidence: 1 },
  ]);
});

test("answer validation omits invented options, low confidence, and unknown ids", () => {
  const questions = [{ id: 1, label: "Office", type: "select", options: ["Toronto", "Ottawa"] }];
  assert.deepEqual(validateAnswers([
    { id: 1, value: "Montreal", confidence: 1 },
    { id: 1, value: "Toronto", confidence: 0.64 },
    { id: 1, value: "Toronto", confidence: "bad" },
    { id: 99, value: "Toronto", confidence: 1 },
  ], questions), []);
  assert.deepEqual(validateAnswers(null, questions), []);
});

test("answer validation requires permission for sensitive fields", () => {
  const questions = [{ id: 3, label: "Disability status", type: "select", options: ["Yes", "No"] }];
  const answers = [{ id: 3, value: "No", confidence: 0.95 }];
  assert.deepEqual(validateAnswers(answers, questions), []);
  assert.deepEqual(validateAnswers(answers, questions, { allowSensitive: true }), [
    { id: 3, value: "No", confidence: 0.95 },
  ]);
});

test("origin validation allows local extension requests only", () => {
  assert.equal(allowedOrigin({ headers: {} }), true);
  assert.equal(allowedOrigin({ headers: { origin: "null" } }), true);
  assert.equal(allowedOrigin({ headers: { origin: "chrome-extension://abcdefghijklmnop" } }), true);
  assert.equal(allowedOrigin({ headers: { origin: "https://example.com" } }), false);
  assert.equal(allowedOrigin({ headers: { origin: "moz-extension://example" } }), false);
});
