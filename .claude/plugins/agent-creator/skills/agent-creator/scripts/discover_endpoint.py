#!/usr/bin/env python3
"""Resolve the AppSync endpoint + Cognito IDs for a deployed accelerator stack.

Resolution order:
  1. CloudFormation describe-stacks — read outputs GraphQLApiUrl, UserPoolId,
     UserPoolWebClientId. Outputs live in nested constructs, so we match on the
     output *key suffix*, not an exact logical ID.
  2. Local aws-exports.json fallback — read aws_appsync_graphqlEndpoint etc.

Resolved values are cached to .agent-creator-cache.json (gitignored) so repeated
calls in a session don't re-hit CloudFormation. Pass --refresh to bypass the cache.

Settings (honoured like the project Makefile) are read from the process
environment first, then from the sibling `.env` file as a fallback — so you can
either `export PROFILE=…` or drop `PROFILE="…"` in `.env` alongside the Cognito
creds. A real environment variable always wins over `.env`.
  PROFILE  — AWS profile name
  REGION   — AWS region
  ACA_STACK_NAME       — explicit stack name (else scan for a *-aca stack)
  ACA_AWS_EXPORTS_PATH — explicit aws-exports.json path for the fallback

Usage:
  python discover_endpoint.py [--refresh] [--stack-name NAME] [--json]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import boto3
from botocore.exceptions import BotoCoreError, ClientError

# Cache and fallback locations are resolved relative to this script so the plugin
# works regardless of the caller's CWD.
_SCRIPT_DIR = Path(__file__).resolve().parent
_CACHE_PATH = _SCRIPT_DIR / ".agent-creator-cache.json"
_ENV_PATH = _SCRIPT_DIR / ".env"

# Output key suffixes we need, mapped to the dict key we return. CDK wraps the
# logical name on BOTH sides: it prefixes the nested-construct path
# (e.g. "ChatbotApiGraphQLApiUrl") and appends an 8-hex-char uniqueness hash
# (e.g. "...GraphQLApiUrl1ED912E9"). So we strip the trailing hash, then match on
# suffix — a plain endswith() would miss every hashed key.
_OUTPUT_SUFFIXES = {
    "GraphQLApiUrl": "endpoint",
    "UserPoolId": "userPoolId",
    "UserPoolWebClientId": "clientId",
}

# CDK appends an 8-char uppercase-hex hash to CfnOutput logical IDs.
_CDK_HASH_SUFFIX = re.compile(r"[0-9A-F]{8}$")

# Best-effort walk up to the repo root to locate the React app's aws-exports.json.
_AWS_EXPORTS_RELATIVE = Path("src/user-interface/react-app/public/aws-exports.json")


def load_env_file() -> dict[str, str]:
    """Minimal .env reader (KEY=VALUE per line); avoids a python-dotenv dep.

    Shared by get_token.py for the Cognito creds and by _setting() below for
    PROFILE/REGION — one parser so the two never drift."""
    values: dict[str, str] = {}
    if not _ENV_PATH.exists():
        return values
    for line in _ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def _setting(name: str) -> str | None:
    """Resolve a setting from the real environment first, then the .env file.

    A genuine environment variable always wins so callers can override .env
    ad hoc (e.g. `REGION=eu-west-1 python discover_endpoint.py`)."""
    return os.environ.get(name) or load_env_file().get(name)


# The settings that determine WHICH stack we resolve. The cache is stamped with
# these so it self-invalidates when you switch profile/region/stack — otherwise a
# valid-but-stale cache would mask a changed .env (the #1 footgun of this script).
_FINGERPRINT_KEYS = ("PROFILE", "REGION", "ACA_STACK_NAME", "ACA_AWS_EXPORTS_PATH")
_FINGERPRINT_FIELD = "_settings"


def _settings_fingerprint() -> dict[str, str | None]:
    return {k: _setting(k) for k in _FINGERPRINT_KEYS}


def _session() -> boto3.Session:
    profile = _setting("PROFILE")
    region = _setting("REGION")
    kwargs = {}
    if profile:
        kwargs["profile_name"] = profile
    if region:
        kwargs["region_name"] = region
    return boto3.Session(**kwargs)


def _find_repo_root() -> Path | None:
    """Walk up from this script looking for a directory that contains the
    React app's aws-exports.json (marks the accelerator repo root)."""
    for parent in _SCRIPT_DIR.parents:
        if (parent / _AWS_EXPORTS_RELATIVE).exists():
            return parent
    return None


def _from_cloudformation(stack_name: str | None) -> dict | None:
    session = _session()
    cfn = session.client("cloudformation")

    stacks: list[dict] = []
    try:
        if stack_name:
            stacks = cfn.describe_stacks(StackName=stack_name)["Stacks"]
        else:
            # Scan for a stack whose name ends in "-aca" (the AcaStack), skipping
            # the "-aca-builder" Phase-1 stack which has no API/auth outputs.
            paginator = cfn.get_paginator("describe_stacks")
            candidates = []
            for page in paginator.paginate():
                for st in page["Stacks"]:
                    name = st["StackName"]
                    if name.endswith("-aca") or name == "aca":
                        candidates.append(st)
            if not candidates:
                return None
            stacks = candidates
    except (ClientError, BotoCoreError) as exc:
        print(f"CloudFormation lookup failed: {exc}", file=sys.stderr)
        return None

    region = session.region_name
    for st in stacks:
        resolved = {"region": region}
        for out in st.get("Outputs", []):
            # Drop CDK's trailing uniqueness hash so the suffix match can land.
            key = _CDK_HASH_SUFFIX.sub("", out["OutputKey"])
            for suffix, target in _OUTPUT_SUFFIXES.items():
                if key.endswith(suffix):
                    resolved[target] = out["OutputValue"]
        if all(k in resolved for k in _OUTPUT_SUFFIXES.values()):
            return resolved
    return None


def _from_aws_exports(path: str | None) -> dict | None:
    candidate: Path | None = None
    if path:
        candidate = Path(path)
    else:
        env_path = _setting("ACA_AWS_EXPORTS_PATH")
        if env_path:
            candidate = Path(env_path)
        else:
            repo_root = _find_repo_root()
            if repo_root:
                candidate = repo_root / _AWS_EXPORTS_RELATIVE

    if not candidate or not candidate.exists():
        return None

    try:
        data = json.loads(candidate.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Could not read aws-exports.json at {candidate}: {exc}", file=sys.stderr)
        return None

    endpoint = data.get("aws_appsync_graphqlEndpoint")
    user_pool_id = data.get("aws_user_pools_id")
    client_id = data.get("aws_user_pools_web_client_id")
    region = data.get("aws_appsync_region") or data.get("aws_project_region")
    if endpoint and user_pool_id and client_id:
        return {
            "endpoint": endpoint,
            "region": region,
            "userPoolId": user_pool_id,
            "clientId": client_id,
        }
    return None


def discover_endpoint(
    refresh: bool = False,
    stack_name: str | None = None,
    aws_exports_path: str | None = None,
) -> dict:
    """Return {endpoint, region, userPoolId, clientId}.

    Raises RuntimeError with an actionable message if nothing resolves."""
    fingerprint = _settings_fingerprint()
    if not refresh and _CACHE_PATH.exists():
        try:
            cached = json.loads(_CACHE_PATH.read_text())
            has_values = all(
                k in cached for k in ("endpoint", "userPoolId", "clientId")
            )
            # Honour the cache only if it was produced under the SAME settings.
            # A mismatch (you switched profile/region/stack) means it's stale, so
            # we fall through and re-resolve instead of returning the old stack.
            if has_values and cached.get(_FINGERPRINT_FIELD) == fingerprint:
                return {k: v for k, v in cached.items() if k != _FINGERPRINT_FIELD}
        except (OSError, json.JSONDecodeError):
            pass  # corrupt cache — fall through to re-resolve

    stack_name = stack_name or _setting("ACA_STACK_NAME")
    resolved = _from_cloudformation(stack_name) or _from_aws_exports(aws_exports_path)

    if not resolved:
        raise RuntimeError(
            "Could not resolve the AppSync endpoint. Tried CloudFormation "
            "(set ACA_STACK_NAME or PROFILE/REGION if the stack isn't found) and "
            "the local aws-exports.json fallback "
            f"({_AWS_EXPORTS_RELATIVE}). Deploy the stack or pass --stack-name."
        )

    try:
        # Stamp the settings alongside the values so the next read can detect a
        # changed .env and self-invalidate.
        _CACHE_PATH.write_text(
            json.dumps({**resolved, _FINGERPRINT_FIELD: fingerprint}, indent=2)
        )
    except OSError:
        pass  # caching is best-effort; never fail the call over it

    return resolved


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="bypass the local cache")
    parser.add_argument("--stack-name", help="explicit CloudFormation stack name")
    parser.add_argument("--aws-exports-path", help="explicit aws-exports.json path")
    parser.add_argument(
        "--json", action="store_true", help="print the full dict as JSON (default)"
    )
    args = parser.parse_args()

    try:
        resolved = discover_endpoint(
            refresh=args.refresh,
            stack_name=args.stack_name,
            aws_exports_path=args.aws_exports_path,
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(resolved, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
