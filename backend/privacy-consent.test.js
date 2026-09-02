import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PRIVACY_CONSENT_VERSION,
  consentAllows,
  hasRequiredPrivacyConsent,
  normalizePrivacyConsent,
} from "../privacy-consent.js";

test("privacy choices default to denied and require the current disclosure version", () => {
  assert.deepEqual(normalizePrivacyConsent(), {
    version: 0,
    acceptedAt: "",
    localProcessing: false,
    automaticPageAccess: false,
    cloudAi: false,
    sensitiveAi: false,
  });
  assert.equal(hasRequiredPrivacyConsent({ localProcessing: true }), false);
  assert.equal(hasRequiredPrivacyConsent({ version: PRIVACY_CONSENT_VERSION, localProcessing: true }), true);
});

test("optional capabilities remain independently denied until explicitly enabled", () => {
  const base = { version: PRIVACY_CONSENT_VERSION, localProcessing: true };
  assert.equal(consentAllows(base, "automaticPageAccess"), false);
  assert.equal(consentAllows(base, "cloudAi"), false);
  assert.equal(consentAllows(base, "sensitiveAi"), false);
  assert.equal(consentAllows({ ...base, cloudAi: true }, "cloudAi"), true);
});

test("first-run disclosure names sensitive data, external destinations, and separate choices", async () => {
  const html = await readFile(new URL("../onboarding.html", import.meta.url), "utf8");
  for (const id of ["localProcessing", "automaticPageAccess", "cloudAi", "sensitiveAi"]) {
    assert.match(html, new RegExp(`id="${id}" type="checkbox"`));
  }
  assert.match(html, /resume and profile may contain your name, address, phone, email/i);
  assert.match(html, /gender, sexual orientation, disability, race or ethnicity/i);
  assert.match(html, /criminal-history answers/i);
  assert.match(html, /configured DeepSeek or OpenAI account/i);
  assert.doesNotMatch(html, /Notion/i);
  assert.match(html, /id="selectAll"[^>]*>Select all</);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
});

test("public privacy notice uses the product support email", async () => {
  const [html, markdown] = await Promise.all([
    readFile(new URL("../privacy.html", import.meta.url), "utf8"),
    readFile(new URL("../PRIVACY.md", import.meta.url), "utf8"),
  ]);
  for (const notice of [html, markdown]) {
    assert.match(notice, /zidiyaocanada@outlook\.com/i);
    assert.doesNotMatch(notice, /yaoz25@mcmaster\.ca/i);
  }
});

test("privacy settings support revocation and complete local deletion", async () => {
  const [html, source, background] = await Promise.all([
    readFile(new URL("../options.html", import.meta.url), "utf8"),
    readFile(new URL("../options.js", import.meta.url), "utf8"),
    readFile(new URL("../background.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-settings-target="privacy"/);
  assert.match(html, /id="deleteLocalData"/);
  assert.match(source, /chrome\.permissions\.remove\(\{ origins: AUTO_FILL_ORIGINS \}/);
  assert.match(source, /backendJson\("\/api\/data", \{ method: "DELETE" \}\)/);
  assert.match(source, /chrome\.storage\.local\.clear\(\)/);
  assert.match(background, /requirePrivacyConsent\("automaticPageAccess"\)/);
  assert.match(background, /requirePrivacyConsent\("cloudAi"\)/);
  assert.match(background, /requirePrivacyConsent\("sensitiveAi"\)/);
});
