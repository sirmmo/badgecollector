// Process a "Register a Client" issue.
//  - mints a bk_* API key (32 random bytes, base64url)
//  - writes data/clients/{client_id}.yaml with sha256 of the key
//  - sends the plaintext key to the contact email via Resend
//  - emits a JSON result for the workflow to commit and comment with
//
// The plaintext key is only ever held in process memory and the
// Resend POST body. It is never logged, committed, or echoed.
import { readFile, writeFile, access } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { parseIssueBody, isValidClientId } from "./parse-issue.mjs";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "";
const DOCS_URL = "https://github.com/sirmmo/badgecollector#api";

function emit(result) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function yamlString(s) {
  return JSON.stringify(String(s || ""));
}

function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function sendKeyEmail({ to, clientId, name, apiKey }) {
  if (!RESEND_API_KEY || !RESEND_FROM) {
    return { sent: false, reason: "RESEND_API_KEY or RESEND_FROM secret not set" };
  }
  const html = `
    <p>Hello,</p>
    <p>Your Badge Collector API key for client <strong>${name}</strong> (<code>${clientId}</code>) is ready.</p>
    <p><strong>Save this key now</strong> — it cannot be recovered. If you lose it, ask a maintainer to rotate it via <code>tools/issue-client.mjs --rotate ${clientId}</code>.</p>
    <pre style="background:#f5f5f3;padding:1rem;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:0.9rem;word-break:break-all">${apiKey}</pre>
    <p>Once the relay endpoint is deployed (<code>https://api.badgecollector.org/award</code>), use it as a Bearer token. Until then the key is inert — bookmark this email.</p>
    <p>Docs: <a href="${DOCS_URL}">${DOCS_URL}</a></p>
    <p>— Badge Collector</p>
  `.trim();
  const text = `Hello,\n\nYour Badge Collector API key for client ${name} (${clientId}) is ready.\n\nSave this key now — it cannot be recovered:\n\n${apiKey}\n\nOnce the relay endpoint is deployed at https://api.badgecollector.org/award, use it as a Bearer token.\n\nDocs: ${DOCS_URL}\n\n— Badge Collector`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: `Your Badge Collector API key for ${clientId}`,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { sent: false, reason: `Resend ${res.status}: ${body.slice(0, 200)}` };
  }
  const out = await res.json();
  return { sent: true, message_id: out.id };
}

async function main() {
  const issueBodyPath = process.env.ISSUE_BODY_PATH;
  if (!issueBodyPath) emit({ ok: false, errors: ["ISSUE_BODY_PATH env var not set"] });
  const body = await readFile(issueBodyPath, "utf8");
  const fields = parseIssueBody(body);

  const clientId = fields["Client ID"];
  const name = fields["Name"];
  const homepage = fields["Homepage"] || "";
  const contactEmail = fields["Contact email"];
  const scheme = (fields["Hash scheme"] || "hmac").trim();

  const errors = [];
  if (!isValidClientId(clientId)) errors.push(`Client ID "${clientId}" must match ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`);
  if (!name) errors.push("Name is required");
  if (!isEmail(contactEmail)) errors.push("Contact email is not a valid email address");
  if (scheme !== "hmac" && scheme !== "email-sha256") errors.push(`Hash scheme "${scheme}" must be hmac or email-sha256`);
  if (errors.length) emit({ ok: false, errors });

  const yamlPath = join(REPO_ROOT, "data/clients", `${clientId}.yaml`);
  if (await fileExists(yamlPath)) {
    emit({ ok: false, errors: [`Client "${clientId}" already exists. To rotate the key, run tools/issue-client.mjs --rotate locally.`] });
  }

  // Mint the key. Never persist plaintext.
  const keyBytes = randomBytes(32);
  const apiKey = `bk_${keyBytes.toString("base64url")}`;
  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
  const today = new Date().toISOString().slice(0, 10);

  const yaml = [
    `id: ${clientId}`,
    `name: ${yamlString(name)}`,
    `homepage: ${yamlString(homepage)}`,
    `owner_contact: ${yamlString("set on registration, not stored")}`,
    `api_key_hash: sha256:${apiKeyHash}`,
    `hash_scheme: ${scheme}`,
    `created_at: ${today}`,
    `revoked: false`,
    `schema: 1`,
    "",
  ].join("\n");

  await writeFile(yamlPath, yaml, "utf8");

  const mail = await sendKeyEmail({ to: contactEmail, clientId, name, apiKey });

  emit({
    ok: true,
    client_id: clientId,
    yaml_path: `data/clients/${clientId}.yaml`,
    email_sent: mail.sent,
    email_reason: mail.reason || null,
    email_message_id: mail.message_id || null,
    // contact_email_masked is what we say back to the issue; raw email never leaks.
    contact_email_masked: contactEmail.replace(/^(.{2}).+(@.+)$/, "$1…$2"),
  });
}

main().catch((e) => emit({ ok: false, errors: [`Internal error: ${e.message}`] }));
