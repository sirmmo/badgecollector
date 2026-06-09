// Issue-form path: parses a "Award a Badge" issue and applies the award.
import { readFile } from "node:fs/promises";
import { parseIssueBody } from "./parse-issue.mjs";
import { applyAward } from "./apply-award.mjs";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const ACTOR = process.env.GITHUB_ACTOR || "unknown";
const ISSUE_URL = process.env.ISSUE_URL || "";

function emit(result) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

async function main() {
  const issueBodyPath = process.env.ISSUE_BODY_PATH;
  if (!issueBodyPath) emit({ ok: false, errors: ["ISSUE_BODY_PATH env var not set"] });
  const body = await readFile(issueBodyPath, "utf8");
  const fields = parseIssueBody(body);

  const result = await applyAward({
    repoRoot: REPO_ROOT,
    badge_id: fields["Badge ID"],
    email_hash: fields["Email hash"],
    expires_at: fields["Expires at"],
    evidence: fields["Evidence URL"] || ISSUE_URL || null,
    issued_by: `gh:${ACTOR}`,
  });
  emit(result);
}

main().catch((e) => emit({ ok: false, errors: [`Internal error: ${e.message}`] }));
