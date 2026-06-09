"""
badgecollector — apify badge assignment via GitHub repository_dispatch.

Stdlib-only client. No external dependencies. Python 3.8+.

Mirrors sdk/js/index.mjs: ``hash_email`` and ``award_badge`` are the
two main entry points; ``await_award_completion`` polls the workflow
runs API for synchronous confirmation.

Usage::

    from badgecollector import award_badge

    result = award_badge(
        token=os.environ["GH_TOKEN"],
        badge_id="early-adopter",
        email="user@example.com",
        expires_at="2027-06-09T00:00:00Z",
        client_id="acme-corp",
    )
    print(result["recipient_page"])
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from urllib import error, request

__all__ = ["hash_email", "award_badge", "await_award_completion", "AwardError"]
__version__ = "0.1.0"

DEFAULT_OWNER = "sirmmo"
DEFAULT_REPO = "badgecollector"
RECIPIENT_BASE = "https://badgecollector.org/m"
EVENT_TYPE = "badge-award"

_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_USER_AGENT = f"badgecollector-client-python/{__version__}"


class AwardError(RuntimeError):
    """Raised when the GitHub API rejects the request or input validation fails."""

    def __init__(self, message: str, *, status: Optional[int] = None, body: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.body = body


def hash_email(email: str) -> str:
    """
    SHA-256 of the NFC-normalised, lowercased, trimmed email.

    Matches the convention documented for the ``manual`` client
    (hash_scheme: email-sha256) in CLAUDE.md.
    """
    if not isinstance(email, str) or not email:
        raise ValueError("email must be a non-empty string")
    normalised = unicodedata.normalize("NFC", email.strip().lower())
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


def _post_json(url: str, body: Dict[str, Any], token: str) -> bytes:
    data = json.dumps(body).encode("utf-8")
    req = request.Request(
        url,
        method="POST",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": _USER_AGENT,
        },
    )
    try:
        with request.urlopen(req) as resp:
            return resp.read()
    except error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        raise AwardError(
            f"GitHub API {e.code} {e.reason}: {body_text}",
            status=e.code,
            body=body_text,
        ) from e


def _get_json(url: str, token: str) -> Any:
    req = request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": _USER_AGENT,
        },
    )
    try:
        with request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as e:
        raise AwardError(f"GitHub API {e.code} {e.reason}", status=e.code) from e


def award_badge(
    *,
    badge_id: str,
    email: Optional[str] = None,
    email_hash: Optional[str] = None,
    api_key: Optional[str] = None,
    worker_url: Optional[str] = None,
    token: Optional[str] = None,
    expires_at: Optional[str] = None,
    evidence: Optional[str] = None,
    client_id: Optional[str] = None,
    owner: str = DEFAULT_OWNER,
    repo: str = DEFAULT_REPO,
) -> Dict[str, Any]:
    """
    Award a badge. Two auth modes:

    * **Worker path** (recommended): pass ``api_key`` (a ``bk_*`` key
      minted by the register-client workflow) and ``worker_url``. The
      Worker validates the key and fires the dispatch.

    * **Direct dispatch**: pass ``token`` (a GitHub PAT with
      Actions:write on the repo). Self-reports ``client_id`` for
      attribution.

    Either ``email`` (hashed locally; never sent) or ``email_hash``
    (a pre-computed sha256 hex) must be provided.

    :raises AwardError: on upstream rejection.
    :raises ValueError: on invalid input.
    """
    if not badge_id:
        raise ValueError("badge_id is required")
    if not email and not email_hash:
        raise ValueError("pass either email or email_hash")
    if api_key and token:
        raise ValueError("pass api_key OR token, not both")
    if not api_key and not token:
        raise ValueError("pass api_key (with worker_url) or token")
    if api_key and not worker_url:
        raise ValueError("worker_url is required when api_key is set")

    digest = (email_hash or hash_email(email)).lower()
    if not _HEX64.match(digest):
        raise ValueError("email_hash must be 64 lowercase hex characters")

    if expires_at:
        try:
            dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError as e:
            raise ValueError(f"expires_at is not a valid ISO 8601 datetime: {expires_at}") from e
        if dt <= datetime.now(timezone.utc):
            raise ValueError(f"expires_at is in the past: {expires_at}")

    if api_key:
        body: Dict[str, Any] = {"badge_id": badge_id, "email_hash": digest}
        if expires_at:
            body["expires_at"] = expires_at
        if evidence:
            body["evidence"] = evidence
        url = f"{worker_url.rstrip('/')}/award"
        raw = _post_json(url, body, api_key)
        try:
            out = json.loads(raw.decode("utf-8"))
        except Exception:
            out = {}
        out.setdefault("ok", True)
        out.setdefault("email_hash", digest)
        out.setdefault("badge_id", badge_id)
        out.setdefault("recipient_page", f"{RECIPIENT_BASE}/{digest}/")
        out.setdefault("accepted_at", datetime.now(timezone.utc).isoformat())
        return out

    client_payload: Dict[str, Any] = {"badge_id": badge_id, "email_hash": digest}
    if expires_at:
        client_payload["expires_at"] = expires_at
    if evidence:
        client_payload["evidence"] = evidence
    if client_id:
        client_payload["client_id"] = client_id

    url = f"https://api.github.com/repos/{owner}/{repo}/dispatches"
    _post_json(url, {"event_type": EVENT_TYPE, "client_payload": client_payload}, token)
    return {
        "ok": True,
        "email_hash": digest,
        "badge_id": badge_id,
        "recipient_page": f"{RECIPIENT_BASE}/{digest}/",
        "accepted_at": datetime.now(timezone.utc).isoformat(),
    }


def await_award_completion(
    *,
    token: str,
    triggered_at: str,
    owner: str = DEFAULT_OWNER,
    repo: str = DEFAULT_REPO,
    timeout_s: float = 120.0,
    interval_s: float = 4.0,
) -> Dict[str, Any]:
    """
    Poll the dispatch-award workflow runs until the one we triggered
    finishes. Returns ``{ok, state, conclusion?, run_url?}``.

    Best-effort matching: GitHub's dispatch API does not return a
    ``run_id``, so we filter by ``created_at`` >= ``triggered_at``.
    """
    if not token:
        raise ValueError("token is required")
    if not triggered_at:
        raise ValueError("triggered_at is required")

    threshold = datetime.fromisoformat(triggered_at.replace("Z", "+00:00")).timestamp() - 5
    runs_url = (
        f"https://api.github.com/repos/{owner}/{repo}/actions/workflows/"
        "dispatch-award.yml/runs?event=repository_dispatch&per_page=10"
    )
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        payload = _get_json(runs_url, token)
        for run in payload.get("workflow_runs", []):
            created = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00")).timestamp()
            if created >= threshold and run.get("status") == "completed":
                return {
                    "ok": run.get("conclusion") == "success",
                    "state": "completed",
                    "conclusion": run.get("conclusion"),
                    "run_url": run.get("html_url"),
                }
        time.sleep(interval_s)
    return {"ok": False, "state": "timeout"}
