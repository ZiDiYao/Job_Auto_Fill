import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);

async function trackedFiles() {
  const { stdout } = await execute("git", ["-C", repositoryRoot, "ls-files", "-z"], { encoding: "utf8" });
  return stdout.split("\0").filter(Boolean);
}

test("Git never tracks per-install profile, credentials, database, or resume files", async () => {
  const files = await trackedFiles();
  const forbidden = files.filter((file) => (
    file === "backend/config/local-config.json"
    || file === "backend/data/profile.json"
    || /^backend\/data\/.*\.(pdf|db|sqlite\w*)$/i.test(file)
    || (file.startsWith("local-data/") && file !== "local-data/.gitkeep")
  ));
  assert.deepEqual(forbidden, []);
});

test("tracked source contains no API-key-shaped secret", async () => {
  const files = (await trackedFiles()).filter((file) => !file.startsWith("vendor/") && !file.startsWith("icons/"));
  const offending = [];
  for (const file of files) {
    const text = await readFile(path.join(repositoryRoot, file), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) offending.push(file);
  }
  assert.deepEqual(offending, []);
});

test("Docker image definition copies explicit source only and excludes runtime data", async () => {
  const [dockerfile, dockerignore, compose] = await Promise.all([
    readFile(path.join(repositoryRoot, "Dockerfile"), "utf8"),
    readFile(path.join(repositoryRoot, ".dockerignore"), "utf8"),
    readFile(path.join(repositoryRoot, "compose.yaml"), "utf8"),
  ]);
  assert.equal(/^COPY\s+\.\s+/m.test(dockerfile), false);
  assert.match(dockerignore, /^local-data\/$/m);
  assert.match(compose, /source: \.\/local-data/);
  assert.match(compose, /target: \/data/);
  assert.match(compose, /127\.0\.0\.1:17840:17840/);
  assert.match(compose, /no-new-privileges:true/);
});

test("container bootstrap seeds only blank config and profile files", async () => {
  const entrypoint = await readFile(path.join(repositoryRoot, "backend/docker-entrypoint.sh"), "utf8");
  assert.match(entrypoint, /local-config\.example\.json/);
  assert.match(entrypoint, /profile\.example\.json/);
  assert.equal(/resume/i.test(entrypoint), false);
});

test("education settings support repeatable constrained records", async () => {
  const [html, source] = await Promise.all([
    readFile(path.join(repositoryRoot, "options.html"), "utf8"),
    readFile(path.join(repositoryRoot, "options.js"), "utf8"),
  ]);
  assert.match(html, /id="educationList"/);
  assert.match(html, /id="addEducation"/);
  assert.match(html, /name="startDate" type="month" min="1950-01" max="2100-12"/);
  assert.match(html, /name="autoAdvanceDelayMs" type="number" min="500" max="10000"/);
  assert.match(html, /<select name="workTerm">[\s\S]*?<option value="4–8 months">/);
  assert.match(source, /educationEntries: \[\]/);
  assert.match(source, /function createEducationRow\(/);
  assert.match(source, /function collectEducationEntries\(/);
  assert.match(source, /type: "password"[\s\S]*inputmode: "decimal"/);
  assert.match(source, /type: "date"[\s\S]*min: "1950-01-01"[\s\S]*max: "2100-12-31"/);
});

test("profile settings expose common developer and generic URL fields", async () => {
  const html = await readFile(path.join(repositoryRoot, "options.html"), "utf8");
  for (const name of ["linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter", "otherSocialUrl", "otherWebsiteUrl"]) {
    assert.match(html, new RegExp(`name="${name}" type="url"`));
  }
});

test("profile and field mapping support an optional second address line", async () => {
  const [html, optionsSource, contentSource, defaults] = await Promise.all([
    readFile(path.join(repositoryRoot, "options.html"), "utf8"),
    readFile(path.join(repositoryRoot, "options.js"), "utf8"),
    readFile(path.join(repositoryRoot, "content.js"), "utf8"),
    readFile(path.join(repositoryRoot, "backend/data/profile.example.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(html, /name="address" autocomplete="address-line1"/);
  assert.match(html, /name="addressLine2" autocomplete="address-line2"/);
  assert.match(optionsSource, /addressLine2: ""/);
  assert.match(contentSource, /key: "addressLine2"[\s\S]*?address line 2/);
  assert.equal(defaults.addressLine2, "");
});

test("language settings are user-managed and start without assumed languages", async () => {
  const [html, source, defaults] = await Promise.all([
    readFile(path.join(repositoryRoot, "options.html"), "utf8"),
    readFile(path.join(repositoryRoot, "options.js"), "utf8"),
    readFile(path.join(repositoryRoot, "backend/data/profile.example.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(html, /id="languageList"/);
  assert.match(html, /id="addLanguage"/);
  assert.match(html, /id="languageChoices"/);
  assert.match(source, /function collectLanguages\(/);
  assert.match(source, /function renderLanguages\(/);
  assert.deepEqual(defaults.languages, []);
});

test("Workday structured filling creates and fills one row per education record", async () => {
  const source = await readFile(path.join(repositoryRoot, "content.js"), "utf8");
  assert.match(source, /function educationSchoolFields\(/);
  assert.match(source, /async function ensureEducationRows\(targetCount\)/);
  assert.match(source, /const schoolFields = await ensureEducationRows\(educationEntries\.length\)/);
  assert.match(source, /for \(const \[index, schoolField\] of schoolFields\.entries\(\)\)/);
});

test("public extension bundles local platform adapters for common ATS providers", async () => {
  const [manifest, adapters, packager] = await Promise.all([
    readFile(path.join(repositoryRoot, "manifest.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "platform-adapters.js"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts/package-extension.sh"), "utf8"),
  ]);
  for (const platform of ["workday", "dayforce", "indeed", "linkedin", "greenhouse", "lever", "smartrecruiters", "icims", "taleo", "successfactors", "ashby"]) {
    assert.match(adapters, new RegExp(`id: "${platform}"`));
  }
  assert.deepEqual(manifest.version, "2.44.1");
  assert.match(packager, /platform-adapters\.js/);
  assert.doesNotMatch(adapters, /eval\s*\(|new Function\s*\(/);
});

test("saved-state copy is rendered as quiet secondary text", async () => {
  const css = await readFile(path.join(repositoryRoot, "options.css"), "utf8");
  assert.match(css, /#saveStatus \{[^}]*color: #98a2b3;[^}]*font-size: 10px;/);
});

test("settings dropdown arrows are consistently inset from the right edge", async () => {
  const css = await readFile(path.join(repositoryRoot, "options.css"), "utf8");
  assert.match(css, /select \{[\s\S]*?appearance: none;[\s\S]*?padding-right: 42px;[\s\S]*?background-position: right 16px center;/);
  assert.match(css, /:root\[data-theme="dark"\] select \{[\s\S]*?background-image:[\s\S]*?background-position: right 16px center;[\s\S]*?background-repeat: no-repeat;[\s\S]*?background-size: 12px 8px;/);
  assert.doesNotMatch(css, /:root\[data-theme="dark"\][^{]*select,[\s\S]*?background:\s*#111419;/);
});

test("date and month picker icons share the select arrow alignment", async () => {
  const css = await readFile(path.join(repositoryRoot, "options.css"), "utf8");
  assert.match(css, /input\[type="date"\],[\s\S]*?input\[type="month"\] \{[\s\S]*?min-height: 38px;[\s\S]*?padding-right: 14px;/);
  assert.match(css, /::-webkit-calendar-picker-indicator[\s\S]*?width: 16px;[\s\S]*?height: 16px;[\s\S]*?margin: 0;[\s\S]*?padding: 0;[\s\S]*?vertical-align: middle;/);
});

test("destructive icon controls use subtle round buttons instead of square boxes", async () => {
  const css = await readFile(path.join(repositoryRoot, "options.css"), "utf8");
  assert.match(css, /\.remove-language,\n\.icon-button \{[^}]*border: 0;[^}]*border-radius: 50%;[^}]*background: transparent;/);
  assert.match(css, /\.remove-language:hover,\n\.icon-button:hover \{[^}]*background: #fef3f2;/);
});

test("popup and settings pages ship green, blue-default, and dark themes", async () => {
  const [html, optionsCss, popupCss, optionsSource, popupSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "options.html"), "utf8"),
    readFile(path.join(repositoryRoot, "options.css"), "utf8"),
    readFile(path.join(repositoryRoot, "popup.css"), "utf8"),
    readFile(path.join(repositoryRoot, "options.js"), "utf8"),
    readFile(path.join(repositoryRoot, "popup.js"), "utf8"),
  ]);
  assert.match(html, /<select name="theme">[\s\S]*?value="green"[\s\S]*?value="blue"[\s\S]*?value="dark"/);
  for (const css of [optionsCss, popupCss]) {
    assert.match(css, /:root\[data-theme="green"\]/);
    assert.match(css, /:root\[data-theme="dark"\]/);
  }
  assert.match(optionsSource, /function applyTheme\(/);
  assert.match(popupSource, /function applyTheme\(/);
});

test("dark theme uses warm neutral contrast and folder cancel is non-destructive", async () => {
  const [optionsCss, popupCss, optionsSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "options.css"), "utf8"),
    readFile(path.join(repositoryRoot, "popup.css"), "utf8"),
    readFile(path.join(repositoryRoot, "options.js"), "utf8"),
  ]);
  for (const css of [optionsCss, popupCss]) {
    assert.match(css, /:root\[data-theme="dark"\][\s\S]*?--text: #f4efe6;[\s\S]*?--muted: #beb5a8;/);
  }
  assert.match(optionsCss, /:root\[data-theme="dark"\] \.folder-picker \.folder-cancel \{[^}]*color: #29251f;[^}]*background: #f4efe6;/);
  assert.match(optionsSource, /button\.classList\.add\("secondary", "folder-cancel"\)/);
  assert.doesNotMatch(optionsSource, /button\.classList\.add\("danger"\)/);
});

test("extension icons ship at every manifest size with transparent RGBA corners", async () => {
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(path.join(repositoryRoot, "icons", `icon-${size}.png`));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[25], 6);
  }
});

test("MV3 AI protocol is semantic-only and cannot return executable browser instructions", async () => {
  const [serverSource, contentSource, backgroundSource, manifestSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "backend/server.js"), "utf8"),
    readFile(path.join(repositoryRoot, "content.js"), "utf8"),
    readFile(path.join(repositoryRoot, "background.js"), "utf8"),
    readFile(path.join(repositoryRoot, "manifest.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions.includes("unlimitedStorage"), false);
  assert.deepEqual(manifest.host_permissions, [
    "http://127.0.0.1:17840/*",
    "http://localhost:17840/*",
    "http://127.0.0.1:11434/*",
    "http://localhost:11434/*",
  ]);
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
  assert.equal(Object.hasOwn(manifest, "optional_permissions"), false);
  assert.equal(manifest.permissions.includes("identity"), false);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");

  assert.doesNotMatch(serverSource, /request\.url === "\/api\/plan-fields"/);
  assert.doesNotMatch(serverSource, /request\.url === "\/api\/(?:answer|resolve-fields)"/);
  assert.doesNotMatch(backgroundSource, /type === "plan-dom-fields"/);
  assert.doesNotMatch(backgroundSource, /fetch\(`\$\{BACKEND_ENDPOINT\}\/api\/(?:answer|resolve-fields)`/);
  assert.match(serverSource, /schemaName: "field_suggestions"/);
  assert.match(serverSource, /additionalProperties: false/);
  assert.match(serverSource, /const allowedKeys = new Set\(\["id", "category", "answer", "answers", "confidence"\]\)/);
  assert.match(serverSource, /Never return selectors, element paths, JavaScript, event names, click instructions, wait times, navigation instructions, operations, or action sequences/);
  assert.match(contentSource, /async function applySemanticSuggestion\(suggestion, target\)/);
  assert.match(contentSource, /target\.kind === "text"/);
  assert.match(contentSource, /target\.kind === "platform-button"/);
  assert.match(contentSource, /target\.kind === "radio"/);
  assert.match(contentSource, /target\.kind === "checkbox"/);
  assert.doesNotMatch(contentSource, /suggestion\.(?:selector|javascript|operation|action|wait|click|navigate)/i);
  assert.match(backgroundSource, /const semanticSuggestionSchema = \{/);
  assert.match(backgroundSource, /additionalProperties: false/);
  assert.match(backgroundSource, /Never return selectors, JavaScript, event names, clicks, waits, navigation, or action sequences/);
});

test("store-review materials and an extension privacy page ship with the source", async () => {
  const [manifestSource, privacyHtml, privacyPolicy, reviewer, disclosure] = await Promise.all([
    readFile(path.join(repositoryRoot, "manifest.json"), "utf8"),
    readFile(path.join(repositoryRoot, "privacy.html"), "utf8"),
    readFile(path.join(repositoryRoot, "PRIVACY.md"), "utf8"),
    readFile(path.join(repositoryRoot, "REVIEWER_INSTRUCTIONS.md"), "utf8"),
    readFile(path.join(repositoryRoot, "STORE_PRIVACY_DISCLOSURE.md"), "utf8"),
  ]);
  assert.match(manifestSource, /"description": "Locally controlled job-application autofill with optional AI answer suggestions\."/);
  assert.match(privacyHtml, /Job Autofill Privacy Policy/);
  assert.match(privacyPolicy, /AI responses are treated only as untrusted semantic suggestions/);
  assert.match(reviewer, /AI is not an execution engine/);
  assert.match(disclosure, /Single purpose/);
});
