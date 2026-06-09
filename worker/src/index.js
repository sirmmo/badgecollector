// badgecollector-worker — accepts Authorization: Bearer bk_* and fires
// a repository_dispatch event using the bot PAT. The Worker is the
// trust boundary that turns per-client bk_* keys into a single GitHub
// auth surface, so individual integrators never need a GitHub token.
//
// Flow:
//   POST /award
//     Authorization: Bearer bk_<base64url>
//     Body: { badge_id, email|email_hash, expires_at?, evidence? }
//   →
//   sha256(bk_*) matched against api_key_hash in data/clients/*.yaml
//   →
//   repository_dispatch with event_type=badge-award, client_id attribution
//
// The award workflow already validates badge_id/email_hash/expires_at,
// so the Worker keeps its own validation minimal and lets the workflow
// be the single source of truth.

const HEADERS_JSON = { "Content-Type": "application/json" };
const HEADERS_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

let clientCache = { fetchedAt: 0, byHash: {} };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...HEADERS_JSON, ...HEADERS_CORS },
  });
}

async function sha256Hex(text) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchClients(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/data/clients`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "badgecollector-worker",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub contents API ${res.status}`);
  }
  const items = await res.json();

  const byHash = {};
  for (const item of items) {
    if (!item.name.endsWith(".yaml")) continue;
    const yamlRes = await fetch(item.download_url, {
      headers: { "User-Agent": "badgecollector-worker" },
    });
    if (!yamlRes.ok) continue;
    const yaml = await yamlRes.text();
    const hashMatch = yaml.match(/^api_key_hash:\s*sha256:([0-9a-f]{64})/m);
    const revoked = /^revoked:\s*true/m.test(yaml);
    if (!hashMatch || revoked) continue;
    const schemeMatch = yaml.match(/^hash_scheme:\s*(\S+)/m);
    byHash[hashMatch[1]] = {
      client_id: item.name.replace(/\.yaml$/, ""),
      hash_scheme: schemeMatch ? schemeMatch[1] : "hmac",
    };
  }
  return byHash;
}

async function getClients(env) {
  const ttl = parseInt(env.CLIENT_CACHE_TTL_MS || "60000", 10);
  if (Date.now() - clientCache.fetchedAt < ttl) {
    return clientCache.byHash;
  }
  const byHash = await fetchClients(env.GH_REPO);
  clientCache = { fetchedAt: Date.now(), byHash };
  return byHash;
}

async function handleAward(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return json({ ok: false, error: "missing Bearer token" }, 401);
  }
  const apiKey = auth.slice(7).trim();
  if (!/^bk_[A-Za-z0-9_-]+$/.test(apiKey)) {
    return json({ ok: false, error: "invalid token format" }, 401);
  }

  const candidateHash = await sha256Hex(apiKey);
  let clients;
  try {
    clients = await getClients(env);
  } catch (e) {
    return json({ ok: false, error: `client registry unavailable: ${e.message}` }, 503);
  }
  const client = clients[candidateHash];
  if (!client) {
    return json({ ok: false, error: "unknown or revoked key" }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { badge_id, email, expires_at, evidence } = body;
  if (!badge_id || !/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/.test(badge_id)) {
    return json({ ok: false, error: "badge_id is required and must match ^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$" }, 400);
  }

  let email_hash = body.email_hash;
  if (!email_hash && email) {
    email_hash = await sha256Hex(email.trim().toLowerCase().normalize("NFC"));
  }
  if (!email_hash) {
    return json({ ok: false, error: "email or email_hash is required" }, 400);
  }
  email_hash = email_hash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(email_hash)) {
    return json({ ok: false, error: "email_hash must be 64 hex chars" }, 400);
  }

  if (!env.GH_BOT_PAT) {
    return json({ ok: false, error: "GH_BOT_PAT secret not configured" }, 500);
  }

  const dispatchRes = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_BOT_PAT}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "badgecollector-worker",
    },
    body: JSON.stringify({
      event_type: env.DISPATCH_EVENT_TYPE || "badge-award",
      client_payload: {
        badge_id,
        email_hash,
        ...(expires_at ? { expires_at } : {}),
        ...(evidence ? { evidence } : {}),
        client_id: client.client_id,
      },
    }),
  });

  if (dispatchRes.status !== 204) {
    const text = await dispatchRes.text().catch(() => "");
    return json(
      { ok: false, error: `dispatch failed (${dispatchRes.status})`, detail: text.slice(0, 300) },
      502,
    );
  }

  return json({
    ok: true,
    client_id: client.client_id,
    badge_id,
    email_hash,
    recipient_page: `https://badgecollector.org/m/${email_hash}/`,
    accepted_at: new Date().toISOString(),
  });
}

function handleHealth(env) {
  return json({
    ok: true,
    cache_age_ms: clientCache.fetchedAt ? Date.now() - clientCache.fetchedAt : null,
    clients_cached: Object.keys(clientCache.byHash).length,
    repo: env.GH_REPO,
  });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: HEADERS_CORS });
    }
    const url = new URL(req.url);
    if (url.pathname === "/award" && req.method === "POST") return handleAward(req, env);
    if (url.pathname === "/healthz") return handleHealth(env);
    if (url.pathname === "/") return json({ ok: true, service: "badgecollector-worker" });
    return json({ ok: false, error: "not found" }, 404);
  },
};
