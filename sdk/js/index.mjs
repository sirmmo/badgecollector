// badgecollector-client (JS) — apify badge assignment via GitHub
// repository_dispatch. Dependency-free. Runs anywhere with fetch:
// Node 18+, Bun, Deno, browsers, Cloudflare Workers. (Node 16 supported
// via opts.fetch.)
//
// Architecture: the dispatch fires an event the repo's award workflow
// listens for. The workflow validates, appends to users/manual.csv,
// creates the recipient stub, commits, and the next Pages deploy
// publishes the recipient page at https://badgecollector.org/m/{hash}/.

const DEFAULT_OWNER = "sirmmo";
const DEFAULT_REPO = "badgecollector";
const RECIPIENT_BASE = "https://badgecollector.org/m";
const EVENT_TYPE = "badge-award";

async function sha256Hex(text) {
  // Web Crypto (browsers, Workers, Deno, Bun, Node 19+).
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node 16–18 fallback.
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

/**
 * SHA-256 of the NFC-normalised, lowercased, trimmed email.
 * Matches the hashing convention documented for the `manual` client
 * (hash_scheme: email-sha256) in CLAUDE.md.
 *
 * @param {string} email
 * @returns {Promise<string>} 64-char hex
 */
export async function hashEmail(email) {
  if (typeof email !== "string" || email.length === 0) {
    throw new Error("hashEmail: email must be a non-empty string");
  }
  const normalised = email.trim().toLowerCase().normalize("NFC");
  return sha256Hex(normalised);
}

/**
 * Award a badge by firing a repository_dispatch event on the badgecollector
 * repo. Returns once GitHub has accepted the event (HTTP 204); the workflow
 * runs asynchronously a few seconds later.
 *
 * @param {{
 *   token: string,                  // PAT or installation token with Actions:write (Contents:read) on the repo
 *   badge_id: string,               // must exist in content/badges/{badge_id}.md
 *   email?: string,                 // raw email — hashed locally; never sent
 *   email_hash?: string,            // alternatively, a pre-computed sha256(lowercase(nfc(email)))
 *   expires_at?: string|null,       // optional ISO 8601 datetime
 *   evidence?: string|null,         // optional URL
 *   client_id?: string,             // optional self-reported attribution; ends up as issued_by="client:<id>"
 *   owner?: string,                 // defaults to sirmmo
 *   repo?: string,                  // defaults to badgecollector
 *   fetch?: typeof fetch,           // override for Node <18
 * }} opts
 * @returns {Promise<{
 *   ok: true,
 *   email_hash: string,
 *   badge_id: string,
 *   recipient_page: string,
 *   accepted_at: string,
 * }>}
 */
export async function awardBadge(opts = {}) {
  const {
    token,
    badge_id,
    email,
    expires_at = null,
    evidence = null,
    client_id = null,
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    fetch: fetchFn,
  } = opts;

  if (!token) throw new Error("awardBadge: token is required");
  if (!badge_id) throw new Error("awardBadge: badge_id is required");
  if (!email && !opts.email_hash) {
    throw new Error("awardBadge: pass either email or email_hash");
  }

  const email_hash = (opts.email_hash || (await hashEmail(email))).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(email_hash)) {
    throw new Error("awardBadge: email_hash must be 64 lowercase hex characters");
  }

  if (expires_at) {
    const t = Date.parse(expires_at);
    if (Number.isNaN(t)) throw new Error("awardBadge: expires_at is not a valid date");
    if (t <= Date.now()) throw new Error("awardBadge: expires_at is in the past");
  }

  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("awardBadge: fetch is not available; pass opts.fetch on Node <18");
  }

  const client_payload = {
    badge_id,
    email_hash,
    ...(expires_at ? { expires_at } : {}),
    ...(evidence ? { evidence } : {}),
    ...(client_id ? { client_id } : {}),
  };

  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "badgecollector-client",
    },
    body: JSON.stringify({ event_type: EVENT_TYPE, client_payload }),
  });

  if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`awardBadge: GitHub API ${res.status} ${res.statusText}: ${text}`);
  }

  return {
    ok: true,
    email_hash,
    badge_id,
    recipient_page: `${RECIPIENT_BASE}/${email_hash}/`,
    accepted_at: new Date().toISOString(),
  };
}

/**
 * Poll the repo's most recent dispatch workflow runs until the one we
 * triggered finishes. Use after awardBadge() when the caller needs a
 * synchronous "the badge has been written" confirmation.
 *
 * GitHub's dispatch API doesn't return a run_id, so we rely on time +
 * event-type matching. Best-effort.
 *
 * @param {{
 *   token: string,
 *   triggeredAt: string|number,     // timestamp from awardBadge().accepted_at
 *   owner?: string,
 *   repo?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   fetch?: typeof fetch,
 * }} opts
 * @returns {Promise<{ok: boolean, conclusion?: string, run_url?: string, state: 'completed'|'timeout'}>}
 */
export async function awaitAwardCompletion(opts = {}) {
  const {
    token,
    triggeredAt,
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    timeoutMs = 120_000,
    intervalMs = 4_000,
    fetch: fetchFn,
  } = opts;

  if (!token) throw new Error("awaitAwardCompletion: token is required");
  if (!triggeredAt) throw new Error("awaitAwardCompletion: triggeredAt is required");

  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("awaitAwardCompletion: fetch is not available; pass opts.fetch on Node <18");
  }

  const threshold = new Date(triggeredAt).getTime() - 5_000; // small grace
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "badgecollector-client",
  };
  const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/dispatch-award.yml/runs?event=repository_dispatch&per_page=10`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchImpl(runsUrl, { headers });
    if (!res.ok) throw new Error(`awaitAwardCompletion: ${res.status} ${res.statusText}`);
    const { workflow_runs = [] } = await res.json();
    const match = workflow_runs.find((r) => new Date(r.created_at).getTime() >= threshold);
    if (match && match.status === "completed") {
      return {
        ok: match.conclusion === "success",
        state: "completed",
        conclusion: match.conclusion,
        run_url: match.html_url,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, state: "timeout" };
}
