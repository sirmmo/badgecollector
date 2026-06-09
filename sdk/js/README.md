# badgecollector

JS/TS client for [badgecollector.org](https://badgecollector.org) — apify badge assignment via GitHub `repository_dispatch` or the relay Cloudflare Worker.

Dependency-free. Runs in Node 18+, Bun, Deno, browsers, and Cloudflare Workers (Node 16 via `opts.fetch`).

## Install

```sh
npm install badgecollector
```

## Use

Two auth modes — pick one per call.

### Worker path (recommended)

A `bk_*` key from the [register-client](https://github.com/sirmmo/badgecollector/issues/new?template=register-client.yml) workflow plus the Worker URL.

```js
import { awardBadge } from "badgecollector";

await awardBadge({
  apiKey: process.env.BC_API_KEY,            // bk_…
  workerUrl: "https://badgecollector-worker.sirmmo.workers.dev",
  badge_id: "early-adopter",
  email: "user@example.com",                 // hashed locally; never sent
  expires_at: "2027-06-09T00:00:00Z",        // optional
  evidence: "https://example.com/transcript", // optional
});
```

### Direct dispatch

A GitHub PAT with **Actions: write** + **Contents: read** on the repo.

```js
await awardBadge({
  token: process.env.GH_TOKEN,
  badge_id: "early-adopter",
  email: "user@example.com",
  client_id: "acme-corp",                    // optional attribution
});
```

## API

```ts
hashEmail(email: string): Promise<string>
// SHA-256 of nfc(lowercase(trim(email))). Matches the manual client's
// hash_scheme so the recipient page URL is predictable from the email.

awardBadge(opts): Promise<{
  ok: true,
  email_hash: string,
  badge_id: string,
  recipient_page: string,
  accepted_at: string,
}>

awaitAwardCompletion(opts): Promise<{
  ok: boolean,
  state: "completed" | "timeout",
  conclusion?: string,
  run_url?: string,
}>
// Polls the dispatch-award workflow runs API. Use when you need a
// synchronous "the badge is written" confirmation.
```

See [CLAUDE.md](https://github.com/sirmmo/badgecollector/blob/main/CLAUDE.md) for the full system specification.

## License

MIT
