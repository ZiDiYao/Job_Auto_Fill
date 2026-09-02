import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillPreview, parseSkillList } from "../skills-preview.js";

test("skill preview parses user-friendly comma, line, semicolon, and pipe lists", () => {
  assert.deepEqual(parseSkillList(" C#, Angular\nSQL; Git | C# "), ["C#", "Angular", "SQL", "Git"]);
});

test("skill preview prioritizes shared evidence, JD technology, then resume technology", () => {
  const result = buildSkillPreview({
    jdSkills: "C#, Azure, Docker, Communication",
    resumeSkills: "C#, Communication, SQL, Git, Teamwork",
    maxSkills: 4,
    maxNonTechnicalSkills: 1,
  });
  assert.deepEqual(result.selected.map(({ name, source }) => ({ name, source })), [
    { name: "C#", source: "both" },
    { name: "Communication", source: "both" },
    { name: "Azure", source: "jd" },
    { name: "Docker", source: "jd" },
  ]);
  assert.ok(result.excluded.some((skill) => skill.name === "Teamwork" && skill.reason === "non-technical limit"));
});

test("skill preview explains total and soft-skill exclusions without exceeding either limit", () => {
  const result = buildSkillPreview({
    jdSkills: "Communication, Teamwork, Java, Python",
    resumeSkills: "Communication, Teamwork, SQL",
    maxSkills: 3,
    maxNonTechnicalSkills: 1,
  });
  assert.equal(result.selected.length, 3);
  assert.equal(result.selected.filter((skill) => !skill.technical).length, 1);
  assert.ok(result.excluded.some((skill) => skill.reason === "non-technical limit"));
  assert.ok(result.excluded.some((skill) => skill.reason === "total skill limit"));
});

test("skill preview bounds invalid user limits", () => {
  assert.equal(buildSkillPreview({ jdSkills: "Java", maxSkills: 0 }).maxSkills, 1);
  assert.equal(buildSkillPreview({ jdSkills: "Java", maxSkills: "bad" }).maxSkills, 15);
  assert.equal(buildSkillPreview({ jdSkills: "Communication", maxNonTechnicalSkills: 99 }).maxNonTechnicalSkills, 5);
});

test("skill preview permanently excludes blacklisted skills before applying limits", () => {
  const result = buildSkillPreview({
    jdSkills: "C#, Angular, Negotiation",
    resumeSkills: "C#, SQL, Negotiation",
    blacklistedSkills: "c#\nNEGOTIATION",
    maxSkills: 10,
    maxNonTechnicalSkills: 2,
  });
  assert.deepEqual(result.selected.map((skill) => skill.name), ["Angular", "SQL"]);
  assert.deepEqual(result.blacklist, ["c#", "NEGOTIATION"]);
  assert.equal(result.excluded.filter((skill) => skill.reason === "permanent blacklist").length, 2);
});
