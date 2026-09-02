const NON_TECHNICAL = /\b(communication|teamwork|collaboration|leadership|negotiation|presentation|adaptability|interpersonal|time management|problem solving|critical thinking|mentoring|creativity)\b/i;

export function parseSkillList(value) {
  const seen = new Set();
  return String(value || "")
    .split(/[,;\n|]+/)
    .map((skill) => skill.replace(/^[\s•*-]+|[\s.]+$/g, "").trim())
    .filter((skill) => {
      const key = skill.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildSkillPreview({ jdSkills, resumeSkills, maxSkills = 15, maxNonTechnicalSkills = 2 } = {}) {
  const jd = parseSkillList(jdSkills);
  const resume = parseSkillList(resumeSkills);
  const resumeByKey = new Map(resume.map((name) => [name.toLowerCase(), name]));
  const jdKeys = new Set(jd.map((name) => name.toLowerCase()));
  const candidates = [
    ...jd.map((name, index) => ({
      name,
      source: resumeByKey.has(name.toLowerCase()) ? "both" : "jd",
      technical: !NON_TECHNICAL.test(name),
      index,
    })),
    ...resume.filter((name) => !jdKeys.has(name.toLowerCase())).map((name, index) => ({
      name,
      source: "resume",
      technical: !NON_TECHNICAL.test(name),
      index: jd.length + index,
    })),
  ];
  for (const candidate of candidates) {
    candidate.tier = candidate.source === "both" ? 0 : candidate.technical ? (candidate.source === "jd" ? 1 : 2) : 3;
  }
  candidates.sort((left, right) => left.tier - right.tier || left.index - right.index);

  const parsedTotal = Number(maxSkills);
  const parsedSoft = Number(maxNonTechnicalSkills);
  const totalLimit = Number.isFinite(parsedTotal) ? Math.min(50, Math.max(1, Math.trunc(parsedTotal))) : 15;
  const softLimit = Number.isFinite(parsedSoft) ? Math.min(5, Math.max(0, Math.trunc(parsedSoft)), totalLimit) : 2;
  const selected = [];
  const excluded = [];
  let softCount = 0;
  for (const candidate of candidates) {
    if (!candidate.technical && softCount >= softLimit) {
      excluded.push({ ...candidate, reason: "non-technical limit" });
      continue;
    }
    if (selected.length >= totalLimit) {
      excluded.push({ ...candidate, reason: "total skill limit" });
      continue;
    }
    selected.push(candidate);
    if (!candidate.technical) softCount += 1;
  }
  return { selected, excluded, maxSkills: totalLimit, maxNonTechnicalSkills: softLimit };
}
