# Badge Collector — Specification

A public, file-backed badge & certification system. Four moving parts:

1. **Catalog** — Hugo-built static site of badge definitions (public, PR-driven).
2. **Award API** — Cloudflare Worker that issues badges to users on behalf of registered third-party clients.
3. **Issue-driven workflows** — GitHub Issue Forms + Actions for human-driven badge definition and manual awarding.
4. **Storage** — plain files in this repo. Git history is the audit log. No database.

```
content/badges/{badge_id}.md           # badge definition (Hugo content)
data/clients/{client_id}.yaml          # registered third-party app
users/{client_id}/{user_id_hash}.json  # awards for one (client, user) pair
profiles/{handle}.json                 # email-verified global identity
worker/                                # Cloudflare Worker source
layouts/, themes/, hugo.yaml           # Hugo site
```

`user_id_hash` is a hex string the Worker derives from the raw `user_id` the client submits — see "User ID hashing" below. The raw value is never stored.

## Identifier rules

| Field            | Regex / rule                                              | Notes                                     |
|------------------|-----------------------------------------------------------|-------------------------------------------|
| `client_id`      | `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`                       | matches YAML filename                     |
| `badge_id`       | `^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$`                       | matches markdown filename                 |
| `user_id` (raw)  | UTF-8, 1–256 bytes after NFC, no `\x00`                   | client-supplied, hashed by Worker before storage; emails, UUIDs, internal IDs all fine |
| `user_id_hash`   | `^[0-9a-f]{64}$`                                          | hex SHA-256 HMAC; what actually appears in URLs and filenames |
| `handle`         | `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`                       | reserved: `admin`, `api`, `u`, `a`, `badges`, `clients`, `claim`, `static`, `assets` |

Clients submit raw `user_id` values; the Worker hashes them on the way in and uses the hash everywhere. The raw value never lands on disk or in a URL.

## User ID hashing

```
user_id_hash = hex( HMAC-SHA256( USER_ID_HMAC_SECRET, client_id || 0x00 || nfc(raw_user_id) ) )
```

- Per-client scoped: the same email submitted by two different clients produces two different hashes. Cross-client correlation only happens through the email-verified profile claim flow, never via hash equality.
- NFC-normalized but **case-sensitive**. `"User@x.com"` and `"user@x.com"` hash differently. Clients that want email-style canonicalization must lowercase before submission.
- `USER_ID_HMAC_SECRET` is a Worker secret. Rotating it orphans every existing `users/{client_id}/*.json` file (they remain readable, but no client can target them again). Treat as effectively immutable.
- Filenames and the `user_id` field inside the JSON file both store the hash. The raw value is unrecoverable from the repo.

## File formats

### Badge definition — `content/badges/{badge_id}.md`

```yaml
---
id: early-adopter              # must equal filename stem
name: Early Adopter
description: Joined during the beta period.
image: /img/badges/early-adopter.png   # local path or absolute URL
issuers: [acme-corp]           # allowlist of client_ids; [] or omitted = any registered client
repeatable: false              # if true, the same (client, user, badge) can be awarded multiple times
criteria: >
  Awarded to users who completed onboarding before 2026-01-01.
tags: [milestone, time-limited]
created_at: 2026-01-15
schema: 1
---

Optional long-form markdown shown on the badge page.
```

Rules:
- A badge is awardable only by a `client_id` listed in `issuers`, or by anyone if `issuers` is empty/absent.
- If `repeatable: false` (default), `/award` for an existing `(client, user, badge)` is idempotent and returns `duplicate: true`.
- `image` may be a path (served by Hugo) or an absolute URL.

### Client — `data/clients/{client_id}.yaml`

```yaml
id: acme-corp                  # must equal filename stem
name: Acme Corp
homepage: https://acme.example
owner_contact: ops@acme.example
api_key_hash: sha256:a3f5e9... # sha256 of plaintext key, lowercase hex (null = no API access)
hash_scheme: hmac              # how user_ids are hashed: hmac (default) | email-sha256
created_at: 2026-05-07
revoked: false                 # if true, all /award calls return 401
schema: 1
```

Rules:
- Plaintext API key is **never** stored. The maintainer mints a key with `tools/issue-client.ts`, writes the hash, and delivers the key out-of-band (one time).
- Rotation = generate new key, replace `api_key_hash`, communicate to client. Old key dies on commit.
- Revocation = set `revoked: true` and commit. Faster than removing the file.
- `hash_scheme: hmac` (default): user_id → `HMAC-SHA256(USER_ID_HMAC_SECRET, client_id || 0x00 || nfc(user_id))`. Used by all API clients.
- `hash_scheme: email-sha256`: user_id → `sha256(lowercase(nfc(user_id)))`. Used by the reserved `manual` client for issue-driven awards.
- `api_key_hash: null` means no API access (used by `manual`).

### User awards — `users/{client_id}/{user_id_hash}.json`

```json
{
  "schema": 1,
  "client_id": "acme-corp",
  "user_id_hash": "8f3e2a91...64hex",
  "awards": [
    {
      "badge_id": "early-adopter",
      "awarded_at": "2026-05-07T10:30:00Z",
      "expires_at": "2027-05-07T00:00:00Z",
      "evidence": "https://acme.example/orders/1234",
      "issued_by": "acme-corp"
    }
  ]
}
```

Rules:
- File is created on first award; never deleted (revocation is an `awards[].revoked_at` field, not removal — preserves audit trail).
- `awards` is append-only ordered by `awarded_at`.
- `issued_by` records who made the call. For API awards = client_id. For manual awards = `gh:{actor}` (the GitHub user who triggered the workflow).
- `expires_at` is optional ISO 8601. Absent = never expires. Rendering decides visual treatment after expiration; the award itself is never deleted.

### Profile — `profiles/{handle}.json`

```json
{
  "schema": 1,
  "handle": "marco",
  "display_name": "Marco",
  "email_hmac": "hmac-sha256:b2c4...",
  "created_at": "2026-05-07T10:00:00Z",
  "claims": [
    {
      "client_id": "acme-corp",
      "user_id_hash": "8f3e2a91...64hex",
      "verified_at": "2026-05-07T10:05:00Z"
    }
  ]
}
```

Rules:
- `email_hmac = HMAC-SHA256(EMAIL_HMAC_SECRET, lowercase(email))`. Distinct from `USER_ID_HMAC_SECRET`. Email itself is never persisted.
- `claims` is append-only. Removing a claim = setting `revoked_at` on the entry.
- Handle is first-claim-wins. A second person attempting to verify with a different `email_hmac` against an existing handle gets 409.
- Public wall at `/u/{handle}` aggregates `awards` from each `users/{client_id}/{user_id_hash}.json` referenced in `claims`.

## API contract

Base URL (TBD): `https://api.badges.example`. All endpoints return JSON unless redirecting.

### `POST /award`

Auth: `Authorization: Bearer <api_key>`

Request:
```json
{
  "user_id": "marco@example.com",
  "badge_id": "early-adopter",
  "evidence": "https://acme.example/orders/1234",
  "awarded_at": "2026-05-07T10:30:00Z"
}
```

`user_id` is whatever the client uses internally — email, UUID, opaque ID. The Worker hashes it before any storage or response. `evidence` and `awarded_at` are optional. `awarded_at` defaults to server time. `Idempotency-Key` is accepted but redundant — `(client_id, user_id_hash, badge_id)` is the natural idempotency key for non-repeatable badges.

Response 200:
```json
{
  "ok": true,
  "client_id": "acme-corp",
  "user_id_hash": "8f3e2a91...64hex",
  "badge_id": "early-adopter",
  "awarded_at": "2026-05-07T10:30:00Z",
  "public_url": "https://badges.example/a/acme-corp/8f3e2a91...64hex",
  "duplicate": false
}
```

The response echoes `user_id_hash`, never the raw `user_id`. Clients are expected to retain the mapping themselves if they need it.

Errors:

| Code | When |
|------|------|
| 400  | malformed body, identifier regex fails |
| 401  | bearer missing, key hash mismatch, client `revoked: true` |
| 403  | `client_id` not in badge `issuers` allowlist |
| 404  | `badge_id` does not exist |
| 409  | GitHub write retry budget exhausted (rare) |
| 422  | `user_id` longer than 256 bytes or contains `\x00` |
| 429  | rate limit exceeded |
| 502  | GitHub API failure |

Write flow inside the Worker:
1. Validate bearer → resolve `client_id` by scanning `data/clients/*.yaml` (cached in Worker memory for ~60s).
2. Hash the raw `user_id` (NFC, HMAC-SHA256 with `client_id` prefix → hex).
3. Load `content/badges/{badge_id}.md` frontmatter; check `issuers` allowlist.
4. GET `users/{client_id}/{user_id_hash}.json` (capture SHA, or note 404 = create).
5. Append award (or short-circuit if duplicate and not repeatable).
6. PUT with parent SHA. On 409, refetch + retry (max 3 attempts).

### `POST /claim/start`

No auth. Initiates email-based ownership claim.

Request:
```json
{
  "client_id": "acme-corp",
  "user_id": "marco@example.com",
  "email": "marco@example.com",
  "handle": "marco"
}
```

`user_id` is the raw value the client originally awarded against; the Worker hashes it the same way `/award` does. `email` is for the magic link.

Worker:
1. Hashes `user_id` → `user_id_hash`.
2. Verifies `users/{client_id}/{user_id_hash}.json` exists.
3. Validates `handle` regex + not reserved.
4. Generates a 32-byte token, stores in Worker KV: `claim:{token} → {client_id, user_id_hash, email_lower, handle}` with `expirationTtl: 600`.
5. Sends magic link: `https://api.badges.example/claim/verify?t={token}` via Resend/Postmark.

Response 200: `{ "ok": true }` — no info leak about whether email exists.

### `GET /claim/verify?t={token}`

Worker:
1. Pops token from KV.
2. Computes `email_hmac` from stored email.
3. Loads or creates `profiles/{handle}.json`.
   - If exists and `email_hmac` differs → 409 page.
   - Otherwise append `{client_id, user_id_hash, verified_at}` to `claims` (deduplicated).
4. Commits, redirects 302 to `https://badges.example/u/{handle}`.

### `GET /a/{client_id}/{user_id_hash}`  *(public read)*

- `Accept: application/json` → returns the user awards JSON.
- Otherwise → 302 to the Hugo-rendered page for that user.

There is intentionally no public endpoint that maps raw `user_id` → hash. Clients that need to deep-link without retaining the hash from `/award` should use `POST /lookup` (below).

### `POST /lookup`

Auth: `Authorization: Bearer <api_key>`

Request:
```json
{ "user_id": "marco@example.com" }
```

Returns the user's awards file scoped to the calling client — i.e. the contents of `users/{client_id}/{user_id_hash}.json` — or 404 if no awards exist for that pair. The Worker hashes `user_id` using the caller's `client_id`; a client cannot probe another client's namespace.

Response 200: same shape as the user awards JSON, plus a top-level `public_url`.

Errors: 401 (auth), 404 (no awards yet), 422 (invalid `user_id`), 429 (rate limit).

Rate-limited per `client_id` to discourage bulk enumeration. The endpoint reveals nothing a determined client couldn't learn by calling `/award` for arbitrary IDs, but `/lookup` is read-only and audit-friendly (no spurious commits in git history).

### `GET /healthz`

Liveness probe. Returns build SHA.

## Hugo rendering

Pages built from the file tree:

| Path                              | Source                                      |
|-----------------------------------|---------------------------------------------|
| `/badges/`                        | list of `content/badges/*.md`               |
| `/badges/{badge_id}/`             | `content/badges/{badge_id}.md`              |
| `/clients/`                       | list of `data/clients/*.yaml` (public fields only — no key hash) |
| `/clients/{client_id}/`           | client homepage card + badges they can issue |
| `/a/{client_id}/{user_id_hash}/`  | per-(client,user) wall from `users/{client_id}/{user_id_hash}.json` |
| `/u/{handle}/`                    | global wall, aggregates claims from `profiles/{handle}.json` |

Implementation note: `/a/...` and `/u/...` pages are generated at build time from the JSON files. Each award commit triggers a rebuild. For the MVP this is fine. If award volume grows, switch the user-page layer to a Worker-rendered route that reads JSON live (Hugo still owns badge pages and chrome).

## Issue-driven workflows

Two GitHub Issue Forms back two Actions, giving a no-Worker path for both badge definition and manual awarding.

### Procedure 1 — Define a badge

- Form: `.github/ISSUE_TEMPLATE/define-badge.yml` (labelled `badge-definition`).
- Action: `.github/workflows/define-badge.yml` triggers on `issues.opened` / `issues.edited` with that label.
- Behavior: parses the issue body, validates fields, generates `content/badges/{id}.md`, opens a PR for maintainer review, comments back with success/error.
- Authority: anyone can open the issue; merging the PR is the human gate.

### Procedure 2 — Manually award a badge

- Form: `.github/ISSUE_TEMPLATE/award-badge.yml` (labelled `badge-award`).
- Action: `.github/workflows/award-badge.yml` triggers on `issues.opened` / `issues.labeled` with that label.
- Authority gate: only `OWNER`, `MEMBER`, or `COLLABORATOR` can trigger the write; other authors get a comment explaining a maintainer must approve.
- Inputs: `badge_id`, `email_hash` (64 hex), `expires_at` (optional ISO 8601), `evidence` (optional URL).
- Behavior: validates inputs, reads `users/manual/{email_hash}.json` (creates if missing), appends the award (idempotent unless the badge is `repeatable`), commits directly to `main`, closes the issue.
- The submitter is responsible for computing `email_hash = sha256(lowercase(nfc(email)))` themselves. The raw email never appears in the issue, the workflow, or the repo.

### Reserved `manual` client

`data/clients/manual.yaml` is a pseudo-client with `api_key_hash: null` and `hash_scheme: email-sha256`. The Worker rejects API calls authenticated as `manual`; only the issue workflow can write to `users/manual/`.

## Local development

Hugo runs from Docker via `bin/hugo`. Do not install Hugo on the host.

```sh
./bin/hugo                  # build into ./public
./bin/hugo server           # live preview at http://localhost:1313
HUGO_PORT=8080 ./bin/hugo server   # different port
```

Image is pinned to `hugomods/hugo:exts-0.154.5`. To bump, edit `bin/hugo`.

## Build & deploy

- Push to `main` → GitHub Action runs Hugo (via the same image) → deploys to Cloudflare Pages.
- Worker deploys via `wrangler deploy` from `worker/` (separate Action job).
- Worker secrets: `GITHUB_TOKEN` (fine-grained PAT, contents: write on this repo), `USER_ID_HMAC_SECRET`, `EMAIL_HMAC_SECRET`, `RESEND_API_KEY` (or chosen provider).

## Concurrency

Optimistic write: GET-with-SHA, PUT-if-match, retry on 409 (max 3). Acceptable up to ~1 award/second per `(client, user)` pair. Cross-pair writes don't conflict because they touch different files.

If a client's volume outgrows this, the Worker can buffer awards per-user in a Durable Object and flush every N seconds as a single commit. Not built yet; design hook is `issued_by` already living in each award entry.

## Privacy & threat model

- Every file under `users/`, `profiles/`, `data/clients/` (minus key hash), `content/badges/` is **public**.
- Public surface: badge definitions, client metadata (no key hash), per-user awards keyed by hash, profile claims with HMAC'd email.
- Never in repo: plaintext API keys, plaintext emails, plaintext `user_id`s, magic-link tokens (KV only).
- Maintainer responsibility: set `USER_ID_HMAC_SECRET` and `EMAIL_HMAC_SECRET` once. Rotating either is destructive — `USER_ID_HMAC_SECRET` orphans every existing user file; `EMAIL_HMAC_SECRET` invalidates all profile claims. Keep both in a password manager.
- Hash collision risk: 256-bit HMAC, negligible.
- Brute-force risk: an attacker who knows the secret could enumerate hashes for a guessed `user_id` set. Treat the secret with the same gravity as the GitHub token.

## Open questions deferred to implementation

- Which email provider (Resend vs Postmark vs SES)?
- Rate limiting — Cloudflare's built-in vs Durable Object counter?
- Public domain names for the API and the catalog.
- Badge image hosting: in-repo `static/img/badges/` vs external URLs.

## Implementation order

1. Hugo skeleton, two example badges, listing + detail templates, client list page.
2. Issue-driven workflows: define-badge (issue → PR) and award-badge (issue → commit). Self-contained, needs only Actions.
3. `tools/issue-client.ts` CLI (mints key, writes YAML).
4. Worker: `/award` and `/lookup`, with lookup cache and optimistic retry.
5. GitHub Action for Pages deploy + Worker deploy.
6. Worker: `/claim/start` and `/claim/verify`, profile pages.
7. Polish: rate limiting, healthz, error pages.
