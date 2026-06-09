// Process a "Award a Badge" issue. Appends to users/manual/{email_hash}.json.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseIssueBody, isHex64, isValidBadgeId, isIsoDate } from "./parse-issue.mjs";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const ACTOR = process.env.GITHUB_ACTOR || "unknown";
const ISSUE_URL = process.env.ISSUE_URL || "";

function fail(errors) {
  console.log(JSON.stringify({ ok: false, errors }));
  process.exit(0);
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function parseBadgeFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2];
  }
  return fm;
}

async function main() {
  const issueBodyPath = process.env.ISSUE_BODY_PATH;
  if (!issueBodyPath) fail(["ISSUE_BODY_PATH env var not set"]);
  const body = await readFile(issueBodyPath, "utf8");
  const fields = parseIssueBody(body);

  const badgeId = fields["Badge ID"];
  const emailHash = (fields["Email hash"] || "").toLowerCase();
  const expiresAt = fields["Expires at"];
  const evidence = fields["Evidence URL"];

  const errors = [];
  if (!isValidBadgeId(badgeId)) errors.push(`Badge ID "${badgeId}" is invalid`);
  if (!isHex64(emailHash)) errors.push(`Email hash must be 64 lowercase hex characters`);
  if (expiresAt && !isIsoDate(expiresAt)) errors.push(`Expires at "${expiresAt}" is not a valid ISO 8601 datetime`);
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (d.getTime() <= Date.now()) errors.push(`Expires at "${expiresAt}" is in the past`);
  }

  if (errors.length) fail(errors);

  const badgePath = join(REPO_ROOT, "content/badges", `${badgeId}.md`);
  if (!(await fileExists(badgePath))) fail([`Badge "${badgeId}" not found at content/badges/${badgeId}.md`]);

  const badgeMd = await readFile(badgePath, "utf8");
  const badgeFm = parseBadgeFrontmatter(badgeMd);
  const repeatable = badgeFm.repeatable === "true";

  // Optional issuer allowlist: if present and non-empty, must include "manual".
  const issuersMatch = badgeMd.match(/^issuers:\s*\[(.*?)\]/m);
  if (issuersMatch) {
    const list = issuersMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    if (list.length > 0 && !list.includes("manual")) {
      fail([`Badge "${badgeId}" does not allow manual issuance (issuers: [${list.join(", ")}])`]);
    }
  }

  const userPath = join(REPO_ROOT, "users/manual", `${emailHash}.json`);
  let file;
  if (await fileExists(userPath)) {
    file = JSON.parse(await readFile(userPath, "utf8"));
  } else {
    file = {
      schema: 1,
      client_id: "manual",
      user_id_hash: emailHash,
      awards: [],
    };
  }

  if (!repeatable && file.awards.some((a) => a.badge_id === badgeId && !a.revoked_at)) {
    console.log(JSON.stringify({
      ok: true,
      duplicate: true,
      badge_id: badgeId,
      user_id_hash: emailHash,
      path: `users/manual/${emailHash}.json`,
    }));
    return;
  }

  const award = {
    badge_id: badgeId,
    awarded_at: new Date().toISOString(),
    ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
    ...(evidence ? { evidence } : ISSUE_URL ? { evidence: ISSUE_URL } : {}),
    issued_by: `gh:${ACTOR}`,
  };
  file.awards.push(award);
  file.awards.sort((a, b) => a.awarded_at.localeCompare(b.awarded_at));

  await mkdir(dirname(userPath), { recursive: true });
  await writeFile(userPath, JSON.stringify(file, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({
    ok: true,
    duplicate: false,
    badge_id: badgeId,
    user_id_hash: emailHash,
    expires_at: award.expires_at || null,
    path: `users/manual/${emailHash}.json`,
  }));
}

main().catch((e) => fail([`Internal error: ${e.message}`]));
