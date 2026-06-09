// Process a "Award a Badge" issue. Appends a row to users/manual.csv
// and creates content/m/{email_hash}.md stub for Hugo if missing.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseIssueBody, isHex64, isValidBadgeId, isIsoDate } from "./parse-issue.mjs";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const ACTOR = process.env.GITHUB_ACTOR || "unknown";
const ISSUE_URL = process.env.ISSUE_URL || "";

const CSV_PATH = join(REPO_ROOT, "users/manual.csv");
const STUB_DIR = join(REPO_ROOT, "content/m");
const HEADER = "email_hash,badge_id,awarded_at,expires_at,issued_by,evidence,revoked_at";

function fail(errors) {
  console.log(JSON.stringify({ ok: false, errors }));
  process.exit(0);
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// RFC 4180 row parser: handles quoted fields with embedded commas/quotes.
function parseRow(line) {
  const out = [];
  let i = 0, cur = "", inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      cur += c; i++;
    } else {
      if (c === ',') { out.push(cur); cur = ""; i++; continue; }
      if (c === '"' && cur === "") { inQuotes = true; i++; continue; }
      cur += c; i++;
    }
  }
  out.push(cur);
  return out;
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

  const issuersMatch = badgeMd.match(/^issuers:\s*\[(.*?)\]/m);
  if (issuersMatch) {
    const list = issuersMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    if (list.length > 0 && !list.includes("manual")) {
      fail([`Badge "${badgeId}" does not allow manual issuance (issuers: [${list.join(", ")}])`]);
    }
  }

  // Load CSV (header + data rows).
  let rows = [];
  if (await fileExists(CSV_PATH)) {
    const content = (await readFile(CSV_PATH, "utf8")).replace(/\r\n/g, "\n");
    const lines = content.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0 || lines[0] !== HEADER) {
      fail([`users/manual.csv has unexpected header. Expected "${HEADER}".`]);
    }
    rows = lines.slice(1).map(parseRow);
  }

  // Duplicate check on (email_hash, badge_id) where revoked_at is empty.
  if (!repeatable && rows.some((r) => r[0] === emailHash && r[1] === badgeId && !r[6])) {
    console.log(JSON.stringify({
      ok: true,
      duplicate: true,
      badge_id: badgeId,
      email_hash: emailHash,
      path: "users/manual.csv",
    }));
    return;
  }

  const awardedAt = new Date().toISOString();
  const expIso = expiresAt ? new Date(expiresAt).toISOString() : "";
  const ev = evidence || ISSUE_URL || "";
  const issuedBy = `gh:${ACTOR}`;

  rows.push([emailHash, badgeId, awardedAt, expIso, issuedBy, ev, ""]);
  rows.sort((a, b) => (a[2] || "").localeCompare(b[2] || ""));

  const csv = [HEADER, ...rows.map((r) => r.map(csvEscape).join(","))].join("\n") + "\n";
  await mkdir(dirname(CSV_PATH), { recursive: true });
  await writeFile(CSV_PATH, csv, "utf8");

  // Create the Hugo recipient stub if missing.
  const stubPath = join(STUB_DIR, `${emailHash}.md`);
  let stubCreated = false;
  if (!(await fileExists(stubPath))) {
    const stub = [
      "---",
      `email_hash: ${emailHash}`,
      `title: "Recipient ${emailHash.slice(0, 8)}…"`,
      "---",
      "",
    ].join("\n");
    await mkdir(STUB_DIR, { recursive: true });
    await writeFile(stubPath, stub, "utf8");
    stubCreated = true;
  }

  console.log(JSON.stringify({
    ok: true,
    duplicate: false,
    badge_id: badgeId,
    email_hash: emailHash,
    expires_at: expIso || null,
    path: "users/manual.csv",
    stub_path: stubCreated ? `content/m/${emailHash}.md` : null,
  }));
}

main().catch((e) => fail([`Internal error: ${e.message}`]));
