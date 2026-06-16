#!/usr/bin/env python3
"""Thin GraphQL-over-HTTP client for the deployed accelerator's AppSync API.

AppSync returns HTTP 200 even when individual fields error, so we inspect the
`errors` array rather than trusting the status code. The Authorization header is
the raw Cognito ID token (no "Bearer" prefix — AppSync Cognito mode).

Note: createAgentCoreRuntime returns "" on validation failure with NO GraphQL
error (see schema). That ambiguity is why local validation (task 03) runs before
submitting — gql.py cannot distinguish that from a successful empty result.

Usage:
  python gql.py 'query { listRuntimeAgents { agentName status } }'
  import: from gql import post; data = post(query, variables)
"""
from __future__ import annotations

import argparse
import json
import sys

import requests

try:
    from discover_endpoint import discover_endpoint
    from get_token import get_token
except ImportError:
    from .discover_endpoint import discover_endpoint
    from .get_token import get_token

_TIMEOUT_SECONDS = 30


def post(query: str, variables: dict | None = None) -> dict:
    """POST a GraphQL document and return the `data` object.

    Raises RuntimeError on transport failure or if the response carries a
    non-empty `errors` array (surfaced readably)."""
    resolved = discover_endpoint()
    endpoint = resolved["endpoint"]
    token = get_token(client_id=resolved["clientId"])

    try:
        resp = requests.post(
            endpoint,
            headers={
                # Raw JWT, no "Bearer" prefix — AppSync Cognito user-pools mode.
                "Authorization": token,
                "Content-Type": "application/json",
            },
            json={"query": query, "variables": variables or {}},
            timeout=_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"GraphQL request failed (transport): {exc}") from exc

    if resp.status_code != 200:
        raise RuntimeError(
            f"GraphQL endpoint returned HTTP {resp.status_code}: {resp.text[:500]}"
        )

    try:
        payload = resp.json()
    except ValueError as exc:
        raise RuntimeError(f"GraphQL response was not JSON: {resp.text[:500]}") from exc

    errors = payload.get("errors")
    if errors:
        messages = []
        for err in errors:
            msg = err.get("message", "<no message>")
            etype = err.get("errorType")
            messages.append(f"  - {msg}" + (f" [{etype}]" if etype else ""))
        raise RuntimeError("GraphQL returned errors:\n" + "\n".join(messages))

    return payload.get("data", {})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", help="GraphQL query/mutation document")
    parser.add_argument("--variables", help="JSON object of variables", default="{}")
    args = parser.parse_args()

    try:
        variables = json.loads(args.variables)
    except json.JSONDecodeError as exc:
        print(f"--variables is not valid JSON: {exc}", file=sys.stderr)
        return 1

    try:
        data = post(args.query, variables)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(data, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
