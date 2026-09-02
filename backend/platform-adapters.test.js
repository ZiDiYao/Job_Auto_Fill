import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../platform-adapters.js", import.meta.url), "utf8");

function loadRegistry() {
  const sandbox = { location: { hostname: "" }, document: { querySelector: () => null } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "platform-adapters.js" });
  return sandbox.JobAutofillPlatformAdapters;
}

test("detects first-class recruiting platforms by hostname", () => {
  const registry = loadRegistry();
  const cases = {
    "company.wd3.myworkdayjobs.com": "workday",
    "jobs.dayforcehcm.com": "dayforce",
    "smartapply.indeed.com": "indeed",
    "www.linkedin.com": "linkedin",
    "boards.greenhouse.io": "greenhouse",
    "jobs.lever.co": "lever",
    "jobs.smartrecruiters.com": "smartrecruiters",
    "careers.icims.com": "icims",
    "company.taleo.net": "taleo",
    "company.successfactors.com": "successfactors",
    "jobs.oraclecloud.com": "oracle-recruiting",
    "jobs.ashbyhq.com": "ashby",
    "workforcenow.adp.com": "adp",
    "recruiting.ultipro.com": "ukg",
    "company.bamboohr.com": "bamboohr",
    "jobs.jobvite.com": "jobvite",
    "company.applytojob.com": "jazzhr",
    "company.recruitee.com": "recruitee",
    "company.pinpointhq.com": "pinpoint",
    "apply.workable.com": "workable",
    "company.teamtailor.com": "teamtailor",
    "company.personio.de": "personio",
    "company.breezy.hr": "breezy",
    "www.comeet.co": "comeet",
    "ats.rippling.com": "rippling",
    "recruiting.paylocity.com": "paylocity",
    "company.csod.com": "cornerstone",
    "company.avature.net": "avature",
    "company.eightfold.ai": "eightfold",
    "company.phenompeople.com": "phenom",
    "company.zohorecruit.com": "zoho-recruit",
  };
  for (const [hostname, expected] of Object.entries(cases)) {
    assert.equal(registry.detect({ hostname, document: null }).id, expected, hostname);
  }
});

test("unknown company career sites receive the generic semantic DOM adapter", () => {
  const registry = loadRegistry();
  assert.equal(registry.detect({ hostname: "careers.example.org", document: null }).id, "generic");
  assert.equal(registry.generic.name, "Company career site");
});

test("every adapter inherits fixed local controls, options, and job metadata selectors", () => {
  const registry = loadRegistry();
  assert.ok(registry.supported.length >= 31);
  for (const adapter of [...registry.registry, registry.generic]) {
    assert.ok(adapter.controlSelectors.includes("input"), adapter.id);
    assert.ok(adapter.optionSelectors.includes("[role='option']"), adapter.id);
    assert.ok(adapter.jobDescriptionSelectors.length > 0, adapter.id);
    assert.ok(adapter.jobTitleSelectors.length > 0, adapter.id);
    assert.ok(adapter.companySelectors.length > 0, adapter.id);
    assert.equal(typeof adapter.settleMs, "number", adapter.id);
  }
});
