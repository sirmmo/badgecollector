# Badge Collector — Specification

A public, file-backed badge & certification system. Four moving parts:

1. **Catalog** — Hugo-built static site of badge definitions (public, PR-driven).
2. **Award API** — Cloudflare Worker that issues badges to users on behalf of registered third-party clients.
3. **Issue-driven workflows** — GitHub Issue Forms + Actions for human-driven badge definition and manual awarding.
4. **Storage** — plain files in this repo. Git history is the audit log. No database.

```
content/badges/{badge_id}.md           # badge definition (Hugo content)
content/m/{email_hash}.md              # recipient stub (manual awards only)
data/clients/{client_id}.yaml          # registered third-party app
users/{client_id}/{user_id_hash}.json  # awards from API clients (per-user JSON)
users/manual.csv                       # manual awards (single append-only CSV)
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
- Plaintext API key is **never** stored. The maintainer mints a key with `tools/issue-client.mjs`, writes the hash, and delivers the key out-of-band (one time).
- Rotation = generate new key, replace `api_key_hash`, communicate to client. Old key dies on commit.
- Revocation = set `revoked: true` and commit. Faster than removing the file.
- `hash_scheme: hmac` (default): user_id → `HMAC-SHA256(USER_ID_HMAC_SECRET, client_id || 0x00 || nfc(user_id))`. Used by all API clients.
- `hash_scheme: email-sha256`: user_id → `sha256(lowercase(nfc(user_id)))`. Used by the reserved `manual` client for issue-driven awards.
- `api_key_hash: null` means no API access (used by `manual`).

### Manual awards — `users/manual.csv`

Issue-driven awards live in one append-only CSV. Source of truth for the `manual` namespace.

```
email_hash,badge_id,awarded_at,expires_at,issued_by,evidence,revoked_at
8f3e2a91...64hex,early-adopter,2026-06-09T03:43:48.762Z,2027-06-09T00:00:00.000Z,gh:marcomontanari,https://github.com/sirmmo/badgecollector/issues/1,
```

Rules:
- Header row required. Fields use RFC 4180 quoting (double-quote fields that contain `,`, `"`, or newlines; escape inner quotes by doubling).
- `email_hash` is `sha256(lowercase(nfc(email)))` (64 hex chars). See `hash_scheme: email-sha256` on `data/clients/manual.yaml`.
- Rows are append-only and sorted by `awarded_at` ascending. Revocation = filling in `revoked_at`, never removing the row.
- Idempotency = `(email_hash, badge_id)` for non-repeatable badges. Re-adding a row that already exists (and isn't revoked) is a no-op.
- Each recipient also has a `content/m/{email_hash}.md` stub so Hugo generates `/m/{email_hash}/` at build time. The page layout filters the CSV by the stub's `email_hash` frontmatter.

### API client awards — `users/{client_id}/{user_id_hash}.json`

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
| `/m/{email_hash}/`                | manual recipient wall, filters `users/manual.csv` by `email_hash` |
| `/u/{handle}/`                    | global wall, aggregates claims from `profiles/{handle}.json` |

Implementation note: `/a/...` and `/u/...` pages are generated at build time from the JSON files. Each award commit triggers a rebuild. For the MVP this is fine. If award volume grows, switch the user-page layer to a Worker-rendered route that reads JSON live (Hugo still owns badge pages and chrome).

## Issue-driven and dispatch-driven workflows

Three entry points share the same award-application core (`apply-award.mjs`): badge definition (PR), manual award via issue (UI), and programmatic award via `repository_dispatch` (API).

### Procedure 1 — Define a badge

- Form: `.github/ISSUE_TEMPLATE/define-badge.yml` (labelled `badge-definition`).
- Action: `.github/workflows/define-badge.yml` triggers on `issues.opened` / `issues.edited` with that label.
- Behavior: parses the issue body, validates fields, generates `content/badges/{id}.md`, opens a PR for maintainer review, comments back with success/error.
- Authority: anyone can open the issue; merging the PR is the human gate.

### Procedure 2 — Manually award a badge (issue UI)

- Form: `.github/ISSUE_TEMPLATE/award-badge.yml` (labelled `badge-award`).
- Action: `.github/workflows/award-badge.yml` triggers on `issues.opened` / `issues.labeled` with that label.
- Authority gate: only `OWNER`, `MEMBER`, or `COLLABORATOR` can trigger the write; other authors get a comment explaining a maintainer must approve.
- Inputs: `badge_id`, `email_hash` (64 hex), `expires_at` (optional ISO 8601), `evidence` (optional URL).
- Behavior: parses the issue, delegates to `apply-award.mjs`, commits, closes the issue. `issued_by` = `gh:{actor}`.

### Procedure 3 — Programmatic award (repository_dispatch)

The "API" surface. No Worker required.

- Action: `.github/workflows/dispatch-award.yml` triggers on `repository_dispatch` with `event_type: badge-award`.
- Authority gate: GitHub auth — any token with `Actions: write` (`repo` scope on a classic PAT, or a fine-grained PAT with this repo allowlisted) can fire it. Distribute per-client tokens for revocability.
- Payload (`client_payload`): `{ badge_id, email_hash, expires_at?, evidence?, client_id? }`. `client_id` is self-reported attribution — fine-grained PATs are the trust boundary.
- Behavior: validates, delegates to `apply-award.mjs`, commits. `issued_by` = `client:{client_id}` if supplied, else `gh:{sender}`.

#### SDK

`sdk/js/index.mjs` — dependency-free JS client. Works in Node 18+, Bun, Deno, browsers, Cloudflare Workers (Node 16 via `opts.fetch`).

```js
import { awardBadge, hashEmail } from "https://raw.githubusercontent.com/sirmmo/badgecollector/main/sdk/js/index.mjs";

const result = await awardBadge({
  token: process.env.GH_TOKEN,
  badge_id: "early-adopter",
  email: "user@example.com",          // hashed locally; never sent
  expires_at: "2027-06-09T00:00:00Z", // optional
  client_id: "acme-corp",             // optional attribution
});
// → { ok: true, email_hash, badge_id, recipient_page: "https://badgecollector.org/m/.../", accepted_at }
```

For synchronous confirmation, `awaitAwardCompletion({ token, triggeredAt: result.accepted_at })` polls the workflow runs API.

### Procedure 4 — Register a client (issue + email)

- Form: `.github/ISSUE_TEMPLATE/register-client.yml` (labelled `client-registration`).
- Action: `.github/workflows/register-client.yml`.
- Authority gate: collaborators only.
- Inputs: `client_id`, `name`, `homepage?`, `contact_email`, `hash_scheme` (`hmac` | `email-sha256`).
- Behavior: collaborator-gated; mints a `bk_*` key in process memory, writes `data/clients/{client_id}.yaml` with the sha256, emails the plaintext to `contact_email` via Resend, commits the YAML, closes the issue. The plaintext key is never logged, returned in JSON, or committed.
- Required secrets: `RESEND_API_KEY` and `RESEND_FROM` (e.g. `Badge Collector <noreply@badgecollector.org>`). The Resend "from" domain must be verified before delivery works.
- The minted `bk_*` key is currently inert — it will become the Bearer token for `https://api.badgecollector.org/award` once the relay Worker (next step) is deployed.

### Shared award core — `users/manual.csv`

All three award-writing procedures go through `apply-award.mjs`, which appends to `users/manual.csv` and creates the recipient stub. Single source of truth, single set of validation rules.

### Client SDKs

- `sdk/js/` — JS/TS/Bun/Deno/Workers/browsers. Published to npm as **`badgecollector`**. `awardBadge()`, `hashEmail()`, `awaitAwardCompletion()`.
- `sdk/python/` — Python 3.8+, stdlib only. Published to PyPI as **`badgecollector`**. Mirrors the JS API.

Both SDKs accept either auth mode:
- `apiKey`/`api_key` + `workerUrl`/`worker_url` → relay Worker path (the `bk_*` key the registration workflow emails to integrators).
- `token` → direct GitHub `repository_dispatch` (PAT with Actions: write on the repo).

### Publishing

Both SDKs publish from CI on a git tag.

- **npm**: tag `js-v0.1.0` (must match `sdk/js/package.json` version). `.github/workflows/publish-npm.yml` runs `npm publish --provenance --access public`. Requires `NPM_TOKEN` repo secret (npm Granular Access Token, "Publish" permission for the `badgecollector` package).
- **PyPI**: tag `py-v0.1.0` (must match `sdk/python/pyproject.toml` version). `.github/workflows/publish-pypi.yml` uses PyPI trusted publishing (OIDC, no token). Requires a pending publisher configured at <https://pypi.org/manage/account/publishing/> with owner `sirmmo`, repo `badgecollector`, workflow `publish-pypi.yml`, environment `pypi`.

Bump the version in the SDK's manifest, commit, tag with the same version, push the tag. The workflow refuses to publish if tag and manifest disagree.

### Relay Worker — `worker/`

A Cloudflare Worker that turns per-integrator `bk_*` keys into a single GitHub auth surface so integrators never see a GitHub token.

- Endpoint: `POST /award` with `Authorization: Bearer bk_*`. Body: `{ badge_id, email|email_hash, expires_at?, evidence? }`.
- Lookup: SHA-256 of the bearer token is matched against `api_key_hash` in `data/clients/*.yaml`. The client list is fetched via GitHub contents API and cached in module scope for `CLIENT_CACHE_TTL_MS` (default 60s).
- On match: fires the same `repository_dispatch` (`event_type: badge-award`) the SDK direct path uses, with `client_id` set from the matched YAML.
- Auth to GitHub: `GH_BOT_PAT` Worker secret (fine-grained PAT scoped to this repo, Actions: write + Contents: read).
- CORS: `*` on the `/award` endpoint so browser apps can call it directly.
- `GET /healthz` reports cache age and cached client count.

Deploy: `.github/workflows/deploy-worker.yml` runs `wrangler deploy` on pushes that touch `worker/**`. Requires repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The `GH_BOT_PAT` secret is set on the Worker side via `wrangler secret put GH_BOT_PAT` (not stored in GitHub).

Until DNS is added for `api.badgecollector.org`, the service is reachable at `https://badgecollector-worker.<account>.workers.dev`.

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

- Push to `main` → `.github/workflows/deploy-pages.yml` builds Hugo in the pinned Docker image and deploys to GitHub Pages.
- Pages source must be set to "GitHub Actions" in repo settings. The workflow's `actions/configure-pages` step injects the correct `--baseURL` (e.g. `https://sirmmo.github.io/badgecollector/`) at build time, so the local `hugo.yaml` baseURL is irrelevant for production.
- Worker deploys via `wrangler deploy` from `worker/` (separate Action job, future).
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
3. `tools/issue-client.mjs` CLI (mints key, writes YAML).
4. Worker: `/award` and `/lookup`, with lookup cache and optimistic retry.
5. GitHub Action for Pages deploy + Worker deploy.
6. Worker: `/claim/start` and `/claim/verify`, profile pages.
7. Polish: rate limiting, healthz, error pages.
# Badge Collector — Design Context

## Users

**Primary audience: Recipients showing off their badges.**

The person on the site is the person who earned the badges. They land on `/m/{hash}` from the SDK's response URL, from an embed they placed on their own site, or by pasting their hash into the home page lookup. They want their badge wall to feel like a possession — something they can show a friend, embed in a portfolio, link from a profile bio.

Secondary visitors: people *they* show their wall to. So the wall needs to read as legitimate at a glance, not as marketing.

The flow that matters is: API call → email/URL → "this is mine" landing page → "I want this on my Twitter bio / personal site" → copy embed. Everything else is supporting.

## Brand Personality

**Three-word vibe: sticker-pack, collectable, fun.**

References this should *feel* like:
- **Letterboxd** — dense lists of personal taste presented with confidence
- **Backloggd** / **HowLongToBeat** — playful tracking sites that take their domain seriously
- **Discogs collection pages** — somebody's stuff, catalogued
- **Pokédex apps** — every entry is a known object with stats
- **TCG inventory sites** — cards as objects with rarity and provenance

Emotional goal: a recipient sees their `/m/...` page and feels a small, real "huh, nice." Not "wow corporate", not "lol cute" — small genuine pride. The kind of page you'd actually link from your Twitter bio.

## Aesthetic Direction

**Visual tone**: dark warm background, saturated pop accents, dense object-grid. Treat each badge as a *thing* — a physical-feeling object placed on a shelf — not a card in a generic feature grid.

**Theme**: dark. Recipients view this on phones at night ("hey check it out") and on laptops ("paste this in your bio"). Warm dark, not crypto-neon dark — the difference between a hardwood-paneled trophy room and a casino.

**Typography commitment**:
- Display: **Boldonse** — chubby, characterful, has soul. Used for badge names, counts, and the brand mark.
- Body / UI: **Albert Sans** — clean, neutral, doesn't fight the display face.
- Metadata / hashes / file paths: **Fragment Mono** — distinctive monospace for the "made of files" parts (timestamps, hashes, `issued_by`, evidence URLs).

(All three are off the impeccable-skill banned reflex list, all three are on Google Fonts.)

**Color commitment (OKLCH)**:
- Background: warm dark — `oklch(16% 0.015 40)`, like seared oak.
- Surface: `oklch(22% 0.02 40)`.
- Foreground: warm bone `oklch(96% 0.015 60)`.
- Muted text: `oklch(68% 0.02 40)`.
- **Coral** accent (primary, counts, calls-to-action): `oklch(75% 0.20 30)`.
- **Citron** accent (verified, badge-earned highlights): `oklch(80% 0.18 100)`.
- **Gold** accent (rare/expired indicators): `oklch(82% 0.16 78)`.

60-30-10 weighting: ~60% background+surface (warm dark), ~30% foreground+muted text, ~10% pop accents used as moments not as fields.

## Anti-references

This explicitly does NOT look like:
- **Generic SaaS landing pages** — no soft gradients, no three-feature-card row, no hero-metric layout, no tilted-phone screenshot.
- **Crypto / NFT collectibles** — no pixel art, no neon-on-pure-black, no Discord-flavoured purple gradients, no "GM" tone.
- **LinkedIn certifications** — no pale corporate blue, no "show your achievement!" marketing voice, no stock-photo people pointing at things.
- **Mid-2010s Open Badges shields** — no ribbon graphics, no skeuomorphic medals, no "achievement unlocked".

## Design Principles

1. **Treat badges as objects, not features.** Each badge has weight, a place on a shelf, a date of acquisition. Cards should feel like sticker-album sleeves or museum vitrine cards, not "feature blocks". Lean into density — a wall with 12 badges should look like a *collection*, not a sparse grid.

2. **The hash is the truth.** Show it. The site is honestly file-backed; the SHA-256 and `users/manual.csv` are not embarrassments to hide behind UI chrome. Surface them in monospace, treat them as the "this is real" mark — like a serial number on the back of a print.

3. **Pop colour is rare and warm.** Coral, citron, gold — saturated but never neon. The accents work because there are few of them. No gradient text. No neon-on-black. No purple-to-pink anything.

4. **Display type carries the personality.** Boldonse on the count, on the badge name, on the brand mark. Almost everywhere else stays quiet so the display face has air.

5. **Mobile is the canonical view.** The recipient's first look at their page is on a phone, sharing with someone in person. Phone view is not a fallback — design starts there, scales up.
