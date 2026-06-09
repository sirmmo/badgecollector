# badgecollector

Python client for [badgecollector.org](https://badgecollector.org) — apify badge assignment via GitHub `repository_dispatch` or the relay Cloudflare Worker.

Stdlib only. No `requests`, no `httpx`. Python 3.8+.

## Install

```sh
pip install badgecollector
```

## Use

Two auth modes — pick one per call.

### Worker path (recommended)

A `bk_*` key from the [register-client](https://github.com/sirmmo/badgecollector/issues/new?template=register-client.yml) workflow plus the Worker URL.

```py
import os
from badgecollector import award_badge

result = award_badge(
    api_key=os.environ["BC_API_KEY"],
    worker_url="https://badgecollector-worker.sirmmo.workers.dev",
    badge_id="early-adopter",
    email="user@example.com",                  # hashed locally; never sent
    expires_at="2027-06-09T00:00:00Z",
    evidence="https://example.com/transcript",
)
print(result["recipient_page"])
```

### Direct dispatch

A GitHub PAT with **Actions: write** + **Contents: read** on the repo.

```py
result = award_badge(
    token=os.environ["GH_TOKEN"],
    badge_id="early-adopter",
    email="user@example.com",
    client_id="acme-corp",
)
```

## API

```py
hash_email(email: str) -> str
# SHA-256 hex of nfc(lowercase(trim(email))).

award_badge(*, badge_id, email=None, email_hash=None,
            api_key=None, worker_url=None, token=None,
            expires_at=None, evidence=None, client_id=None,
            owner="sirmmo", repo="badgecollector") -> dict

await_award_completion(*, token, triggered_at,
                       owner="sirmmo", repo="badgecollector",
                       timeout_s=120.0, interval_s=4.0) -> dict

# Raises AwardError on upstream rejection, ValueError on invalid input.
```

See [CLAUDE.md](https://github.com/sirmmo/badgecollector/blob/main/CLAUDE.md) for the full system specification.

## License

MIT
