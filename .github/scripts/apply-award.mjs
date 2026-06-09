// Shared award-application logic. Called by both:
//  - award-badge.mjs       (issue-form trigger)
//  - dispatch-award.mjs    (repository_dispatch trigger)
//
// Validates inputs, appends a row to users/manual.csv, creates the
// recipient stub if missing. Returns a structured result.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isHex64, isValidBadgeId, isIsoDate } from "./parse-issue.mjs";

const HEADER = "email_hash,badge_id,awarded_at,expires_at,issued_by,evidence,revoked_at";

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

/**
 * @param {{
 *   repoRoot: string,
 *   badge_id: string,
 *   email_hash: string,
 *   expires_at?: string|null,
 *   evidence?: string|null,
 *   issued_by: string,
 * }} input
 * @returns {Promise<{ok: true, duplicate: boolean, ...} | {ok: false, errors: string[]}>}
 */
export async function applyAward(input) {
  const errors = [];
  const badge_id = input.badge_id;
  const email_hash = (input.email_hash || "").toLowerCase();
  const expires_at = input.expires_at || null;
  const evidence = input.evidence || null;
  const issued_by = input.issued_by || "gh:unknown";
  const repoRoot = input.repoRoot;

  if (!isValidBadgeId(badge_id)) errors.push(`Badge ID "${badge_id}" is invalid`);
  if (!isHex64(email_hash)) errors.push(`Email hash must be 64 lowercase hex characters`);
  if (expires_at && !isIsoDate(expires_at)) errors.push(`Expires at "${expires_at}" is not a valid ISO 8601 datetime`);
  if (expires_at) {
    const d = new Date(expires_at);
    if (d.getTime() <= Date.now()) errors.push(`Expires at "${expires_at}" is in the past`);
  }
  if (errors.length) return { ok: false, errors };

  const badgePath = join(repoRoot, "content/badges", `${badge_id}.md`);
  if (!(await fileExists(badgePath))) return { ok: false, errors: [`Badge "${badge_id}" not found at content/badges/${badge_id}.md`] };

  const badgeMd = await readFile(badgePath, "utf8");
  const badgeFm = parseBadgeFrontmatter(badgeMd);
  const repeatable = badgeFm.repeatable === "true";

  const issuersMatch = badgeMd.match(/^issuers:\s*\[(.*?)\]/m);
  if (issuersMatch) {
    const list = issuersMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    if (list.length > 0 && !list.includes("manual")) {
      return { ok: false, errors: [`Badge "${badge_id}" does not allow manual issuance (issuers: [${list.join(", ")}])`] };
    }
  }

  const csvPath = join(repoRoot, "users/manual.csv");
  let rows = [];
  if (await fileExists(csvPath)) {
    const content = (await readFile(csvPath, "utf8")).replace(/\r\n/g, "\n");
    const lines = content.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0 || lines[0] !== HEADER) {
      return { ok: false, errors: [`users/manual.csv has unexpected header. Expected "${HEADER}".`] };
    }
    rows = lines.slice(1).map(parseRow);
  }

  if (!repeatable && rows.some((r) => r[0] === email_hash && r[1] === badge_id && !r[6])) {
    return {
      ok: true,
      duplicate: true,
      badge_id,
      email_hash,
      path: "users/manual.csv",
      stub_path: null,
    };
  }

  const awardedAt = new Date().toISOString();
  const expIso = expires_at ? new Date(expires_at).toISOString() : "";

  rows.push([email_hash, badge_id, awardedAt, expIso, issued_by, evidence || "", ""]);
  rows.sort((a, b) => (a[2] || "").localeCompare(b[2] || ""));

  const csv = [HEADER, ...rows.map((r) => r.map(csvEscape).join(","))].join("\n") + "\n";
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(csvPath, csv, "utf8");

  const stubDir = join(repoRoot, "content/m");
  const stubPath = join(stubDir, `${email_hash}.md`);
  let stubCreated = false;
  if (!(await fileExists(stubPath))) {
    const stub = [
      "---",
      `email_hash: ${email_hash}`,
      `title: "Recipient ${email_hash.slice(0, 8)}…"`,
      "---",
      "",
    ].join("\n");
    await mkdir(stubDir, { recursive: true });
    await writeFile(stubPath, stub, "utf8");
    stubCreated = true;
  }

  return {
    ok: true,
    duplicate: false,
    badge_id,
    email_hash,
    expires_at: expIso || null,
    path: "users/manual.csv",
    stub_path: stubCreated ? `content/m/${email_hash}.md` : null,
  };
}
