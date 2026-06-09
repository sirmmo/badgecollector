# Badge Collector

A public, file-backed badge and certification system. Apps pin badges to people; people get a permanent wall they can show, embed, share. The whole thing is made of files in this repo — git is the audit log.

Live at **[badgecollector.org](https://badgecollector.org)**.

[![npm](https://img.shields.io/npm/v/badgecollector?label=npm%20%C2%B7%20badgecollector)](https://www.npmjs.com/package/badgecollector)
[![PyPI](https://img.shields.io/pypi/v/badgecollector?label=PyPI%20%C2%B7%20badgecollector)](https://pypi.org/project/badgecollector/)
[![Site](https://img.shields.io/github/actions/workflow/status/sirmmo/badgecollector/deploy-pages.yml?label=site&branch=main)](https://badgecollector.org)
[![Worker](https://img.shields.io/github/actions/workflow/status/sirmmo/badgecollector/deploy-worker.yml?label=worker&branch=main)](https://badgecollector-worker.sirmmo.workers.dev/healthz)

---

## What's here

Four moving parts, no database:

```
catalog        Hugo site of badge definitions     content/badges/{id}.md
issuers        registered third-party apps        data/clients/{id}.yaml
recipients     awards files, public               users/manual.csv  ·  users/{client}/{hash}.json
api            relay Cloudflare Worker            worker/  → workers.dev
```

Three ways to write a badge:

| Procedure | How | Result |
|---|---|---|
| **Define** a badge | open the `Define a Badge` issue | workflow opens a PR adding `content/badges/{id}.md` |
| **Award** a badge manually | open the `Award a Badge` issue (collaborator) | workflow appends to `users/manual.csv`, commits |
| **Register** a client | open the `Register a Client` issue (collaborator) | workflow mints a `bk_*` key, emails it, commits the YAML hash |

Plus a programmatic path: integrators with a `bk_*` call the relay Worker, which fires the same `repository_dispatch` event the issue workflow uses.

## Pin your first badge

```sh
npm install badgecollector
```

```js
import { awardBadge } from "badgecollector";

const result = await awardBadge({
  apiKey: process.env.BC_API_KEY,         // bk_… from the registration email
  workerUrl: "https://badgecollector-worker.sirmmo.workers.dev",
  badge_id: "early-adopter",
  email: "user@example.com",              // hashed locally; never sent
});

console.log(result.recipient_page);
// → https://badgecollector.org/m/{sha256-of-email}/
```

Python is the same shape:

```sh
pip install badgecollector
```

```py
from badgecollector import award_badge

result = award_badge(
    api_key=os.environ["BC_API_KEY"],
    worker_url="https://badgecollector-worker.sirmmo.workers.dev",
    badge_id="early-adopter",
    email="user@example.com",
)
```

The recipient page renders from `users/manual.csv` at build time; the recipient can grab a [self-resizing embed](https://badgecollector.org/m/0af5553c3e18f3d037767cd82ac78f38166c1fa3e4d4d6ac878d8ff8527d6253/embed.html) to put on any other page.

## How a badge gets pinned

```
   SDK call (bk_…)              relay Worker                  GitHub                   Pages
┌──────────────────┐    POST   ┌──────────────┐  dispatch  ┌──────────────────┐   ┌─────────────┐
│  awardBadge({    │ ───────▶  │  /award      │ ─────────▶ │ award workflow   │   │ Hugo build  │
│    apiKey, email │           │  hash check  │            │ appends manual.  │   │ renders     │
│  })              │           │  → dispatch  │            │ csv + stub +     │ ─▶│ /m/{hash}/  │
└──────────────────┘           └──────────────┘            │ commits to main  │   │ + embed     │
                                                          └──────────────────┘   └─────────────┘
```

The relay Worker is the trust boundary — integrators only ever see a `bk_*` key, never a GitHub token.

## Repo layout

```
content/badges/{badge_id}.md           catalog (Hugo content)
content/m/{email_hash}.md              recipient stub (manual awards)
data/clients/{client_id}.yaml          registered apps
users/manual.csv                       manual awards (append-only, RFC 4180)
users/{client_id}/{user_hash}.json     API awards (per-user JSON)
worker/                                Cloudflare relay
sdk/js/                                JS client (npm: badgecollector)
sdk/python/badgecollector/             Python client (PyPI: badgecollector)
layouts/, static/, hugo.yaml           Hugo site
```

Full specification — file formats, identifier rules, hashing, API contract, threat model — lives in **[CLAUDE.md](./CLAUDE.md)**.

## Local dev

Hugo runs from Docker (host install discouraged):

```sh
./bin/hugo               # build to ./public
./bin/hugo server        # preview at http://localhost:1313
```

## Contributing

Propose new badges by opening a **Define a Badge** issue — the workflow opens a PR for review. Awards (manual or API), client registrations, and catalog tweaks all go through the same issue-driven path.

## License

MIT
