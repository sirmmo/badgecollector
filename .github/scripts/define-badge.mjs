// Process a "Define a Badge" issue. Writes content/badges/{id}.md
// and prints a JSON summary on stdout for the workflow to read.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseIssueBody, isValidBadgeId, isValidClientId, csvList } from "./parse-issue.mjs";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();

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

function yamlEscape(s) {
  // Quote if the string would be ambiguous in YAML.
  if (s === null || s === undefined) return '""';
  const str = String(s);
  if (/^[A-Za-z0-9 _.,/:?!()-]*$/.test(str) && !str.startsWith(" ") && !str.endsWith(" ")) {
    return str;
  }
  return JSON.stringify(str);
}

async function main() {
  const issueBodyPath = process.env.ISSUE_BODY_PATH;
  if (!issueBodyPath) fail(["ISSUE_BODY_PATH env var not set"]);
  const body = await readFile(issueBodyPath, "utf8");
  const fields = parseIssueBody(body);

  const id = fields["Badge ID"];
  const name = fields["Name"];
  const description = fields["Description"];
  const imageUrl = fields["Image URL"];
  const issuersRaw = fields["Issuers"];
  const repeatable = (fields["Repeatable"] || "").toLowerCase() === "yes";
  const criteria = fields["Criteria"];
  const tagsRaw = fields["Tags"];
  const longBody = fields["Long-form description"];

  const errors = [];
  if (!isValidBadgeId(id)) errors.push(`Badge ID "${id}" must match ^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$`);
  if (!name) errors.push("Name is required");
  if (!description) errors.push("Description is required");
  if (!criteria) errors.push("Criteria is required");

  const issuers = csvList(issuersRaw);
  for (const cid of issuers) {
    if (!isValidClientId(cid)) errors.push(`Issuer "${cid}" is not a valid client_id`);
    const cidPath = join(REPO_ROOT, "data/clients", `${cid}.yaml`);
    if (!(await fileExists(cidPath))) errors.push(`Issuer "${cid}" is not a registered client`);
  }

  const tags = csvList(tagsRaw);

  if (errors.length) fail(errors);

  const targetPath = join(REPO_ROOT, "content/badges", `${id}.md`);
  if (await fileExists(targetPath)) fail([`Badge "${id}" already exists at content/badges/${id}.md`]);

  const today = new Date().toISOString().slice(0, 10);

  const frontmatter = [
    "---",
    `id: ${id}`,
    `name: ${yamlEscape(name)}`,
    `description: ${yamlEscape(description)}`,
    ...(imageUrl ? [`image: ${yamlEscape(imageUrl)}`] : []),
    `issuers: [${issuers.map(yamlEscape).join(", ")}]`,
    `repeatable: ${repeatable}`,
    `criteria: >`,
    `  ${criteria.replace(/\n/g, "\n  ")}`,
    `tags: [${tags.map(yamlEscape).join(", ")}]`,
    `created_at: ${today}`,
    `schema: 1`,
    "---",
    "",
    longBody || "",
    "",
  ].join("\n");

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, frontmatter, "utf8");

  console.log(JSON.stringify({
    ok: true,
    path: `content/badges/${id}.md`,
    id,
    name,
    branch: `badge/${id}`,
  }));
}

main().catch((e) => fail([`Internal error: ${e.message}`]));
