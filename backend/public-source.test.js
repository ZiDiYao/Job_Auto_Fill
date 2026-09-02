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
    const text = await readFile(path.join(repositoryRoot, file), "utf8");
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

test("structured education settings use constrained browser controls", async () => {
  const html = await readFile(path.join(repositoryRoot, "options.html"), "utf8");
  assert.match(html, /name="educationStartYear" type="number" min="1950" max="2100"/);
  assert.match(html, /name="graduationDate" type="date" min="1950-01-01" max="2100-12-31"/);
  assert.match(html, /name="startDate" type="month" min="1950-01" max="2100-12"/);
  assert.match(html, /<select name="workTerm">[\s\S]*?<option value="4–8 months">/);
  assert.match(html, /<select name="gpaScale">/);
  assert.match(html, /id="gpa" name="gpa" type="password"/);
  assert.match(html, /id="toggleGpaVisibility"[\s\S]*?aria-controls="gpa"/);
});

test("profile settings expose common developer and generic URL fields", async () => {
  const html = await readFile(path.join(repositoryRoot, "options.html"), "utf8");
  for (const name of ["linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter", "otherSocialUrl", "otherWebsiteUrl"]) {
    assert.match(html, new RegExp(`name="${name}" type="url"`));
  }
});
