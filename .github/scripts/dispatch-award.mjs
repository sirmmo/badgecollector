// Repository_dispatch path: parses client_payload from env and applies the award.
import { applyAward } from "./apply-award.mjs";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const SENDER = process.env.SENDER_LOGIN || "unknown";

function emit(result) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

async function main() {
  const payloadRaw = process.env.PAYLOAD;
  if (!payloadRaw) emit({ ok: false, errors: ["PAYLOAD env var not set"] });

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (e) {
    emit({ ok: false, errors: [`PAYLOAD is not valid JSON: ${e.message}`] });
  }

  // issued_by attribution: client-supplied client_id if present, else the
  // GitHub identity that fired the dispatch. Client_id is self-reported,
  // not cryptographically verified — fine-grained PATs scoped per client
  // is the recommended trust boundary.
  const issued_by = payload.client_id
    ? `client:${payload.client_id}`
    : `gh:${SENDER}`;

  const result = await applyAward({
    repoRoot: REPO_ROOT,
    badge_id: payload.badge_id,
    email_hash: payload.email_hash,
    expires_at: payload.expires_at || null,
    evidence: payload.evidence || null,
    issued_by,
  });
  emit(result);
}

main().catch((e) => emit({ ok: false, errors: [`Internal error: ${e.message}`] }));
