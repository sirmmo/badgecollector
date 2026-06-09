#!/usr/bin/env node
// Mint or rotate an API key for a client. Writes data/clients/{id}.yaml
// and prints the plaintext key once. The plaintext is never stored.

import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

function usage() {
  console.error(`Usage: node tools/issue-client.mjs <client_id> [options]

Mint a fresh API key for a client and write data/clients/{client_id}.yaml.
The plaintext key is printed once and cannot be recovered.

Options:
  --name <text>        Display name (required for new clients)
  --homepage <url>     Client homepage
  --contact <text>     Owner contact (email or handle)
  --scheme <s>         Hash scheme: hmac (default) | email-sha256
  --rotate             Rotate the key on an existing client YAML

Examples:
  node tools/issue-client.mjs acme-corp --name "Acme Corp" \\
      --homepage https://acme.example --contact ops@acme.example

  node tools/issue-client.mjs acme-corp --rotate
`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rotate") args.rotate = true;
    else if (a === "--help" || a === "-h") usage();
    else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) usage();
      args[a.slice(2)] = v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function yamlString(s) {
  // Always quote with JSON syntax for safety; valid YAML.
  return JSON.stringify(String(s));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientId = args._[0];
  if (!clientId) usage();
  if (!ID_RE.test(clientId)) {
    console.error(`Error: client_id "${clientId}" must match ${ID_RE}`);
    process.exit(1);
  }
  if (args.scheme && args.scheme !== "hmac" && args.scheme !== "email-sha256") {
    console.error(`Error: --scheme must be "hmac" or "email-sha256"`);
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = process.env.PROJECT_ROOT || resolve(here, "..");
  const yamlPath = join(projectRoot, "data/clients", `${clientId}.yaml`);
  const relPath = yamlPath.replace(projectRoot + "/", "");
  const exists = await fileExists(yamlPath);

  const keyBytes = randomBytes(32);
  const key = `bk_${keyBytes.toString("base64url")}`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  const today = new Date().toISOString().slice(0, 10);

  if (exists) {
    if (!args.rotate) {
      console.error(`Error: ${relPath} already exists. Pass --rotate to replace its API key.`);
      process.exit(1);
    }
    const original = await readFile(yamlPath, "utf8");
    const updated = original.replace(/^api_key_hash:.*$/m, `api_key_hash: sha256:${keyHash}`);
    if (updated === original) {
      console.error(`Error: could not find api_key_hash field in ${relPath}`);
      process.exit(1);
    }
    await writeFile(yamlPath, updated, "utf8");
  } else {
    if (!args.name) {
      console.error(`Error: --name is required when creating a new client`);
      process.exit(1);
    }
    const yaml = [
      `id: ${clientId}`,
      `name: ${yamlString(args.name)}`,
      `homepage: ${yamlString(args.homepage || "")}`,
      `owner_contact: ${yamlString(args.contact || "")}`,
      `api_key_hash: sha256:${keyHash}`,
      `hash_scheme: ${args.scheme || "hmac"}`,
      `created_at: ${today}`,
      `revoked: false`,
      `schema: 1`,
      "",
    ].join("\n");
    await writeFile(yamlPath, yaml, "utf8");
  }

  const verb = exists ? "Rotated" : "Created";
  process.stdout.write(`
${verb} ${relPath}

API key (save this now -- it cannot be recovered):

  ${key}

Deliver this key out-of-band to the client. Commit the updated YAML.
`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
