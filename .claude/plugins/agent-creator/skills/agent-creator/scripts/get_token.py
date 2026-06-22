#!/usr/bin/env python3
"""Mint a Cognito ID token for the deployed accelerator's AppSync API.

AppSync's createAgentCoreRuntime (and every other agent mutation) is
@aws_cognito_user_pools only — SigV4/IAM is rejected. We must send a Cognito
*ID token* (not the access token) as the raw JWT in the Authorization header,
with NO "Bearer" prefix.

Auth flow (USER_PASSWORD_AUTH — the app client has userPassword:true,
generateSecret:false, so there is no SRP and no SECRET_HASH):

  1. Load creds:
       - if .env exists -> ACA_COGNITO_USERNAME / ACA_COGNITO_PASSWORD
       - else -> prompt (password via getpass, never echoed), then write .env
         0600 after ensuring .env is gitignored.
  2. clientId from discover_endpoint.
  3. cognito-idp InitiateAuth(USER_PASSWORD_AUTH).
  4. return AuthenticationResult["IdToken"].

Tokens are minted fresh every run (they expire ~1h; with .env creds re-minting
is free) — the JWT is never cached.

Usage:
  python get_token.py            # prints the ID token to stdout
  import: from get_token import get_token; token = get_token()
"""
from __future__ import annotations

import getpass
import os
import stat
import sys
from pathlib import Path

from botocore.exceptions import BotoCoreError, ClientError

try:
    from discover_endpoint import (
        _find_repo_root,
        _session,
        discover_endpoint,
        load_env_file,
    )
except ImportError:  # allow running as a module from elsewhere
    from .discover_endpoint import (
        _find_repo_root,
        _session,
        discover_endpoint,
        load_env_file,
    )

_SCRIPT_DIR = Path(__file__).resolve().parent
_ENV_PATH = _SCRIPT_DIR / ".env"

_ENV_USERNAME = "ACA_COGNITO_USERNAME"
_ENV_PASSWORD = "ACA_COGNITO_PASSWORD"  # pragma: allowlist secret # nosec B105 - env var name, not a credential


def _ensure_env_gitignored() -> None:
    """Make sure `.env` is gitignored before we ever write secrets to it.

    Checks the repo root .gitignore first (the accelerator already lists `.env`
    there); if no root .gitignore is found, drops a local .gitignore next to the
    script. This is a production-safety must — creds must never be committable."""
    repo_root = _find_repo_root()
    gitignore = (repo_root / ".gitignore") if repo_root else None
    if gitignore and gitignore.exists():
        existing = gitignore.read_text().splitlines()
        if any(line.strip() in (".env", "*.env", "**/.env") for line in existing):
            return
        with gitignore.open("a") as fh:
            fh.write("\n# agent-creator plugin credentials\n.env\n")
        return

    # No repo-root .gitignore — guard the script directory locally.
    local = _SCRIPT_DIR / ".gitignore"
    line = ".env\n"
    if local.exists() and ".env" in local.read_text():
        return
    with local.open("a") as fh:
        fh.write(line)


def _prompt_and_store_creds() -> tuple[str, str]:
    username = input("Cognito username (email): ").strip()
    password = getpass.getpass("Cognito password: ")  # MASKED — no echo

    _ensure_env_gitignored()
    contents = f'{_ENV_USERNAME}="{username}"\n{_ENV_PASSWORD}="{password}"\n'
    # Create with 0600 from the start: open with restrictive mode, then write.
    fd = os.open(_ENV_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(contents)
    # Belt-and-braces in case the file pre-existed with looser perms.
    os.chmod(_ENV_PATH, stat.S_IRUSR | stat.S_IWUSR)
    print(f"Saved credentials to {_ENV_PATH} (0600, gitignored).", file=sys.stderr)
    return username, password


def _resolve_creds() -> tuple[str, str]:
    env = load_env_file()
    username = env.get(_ENV_USERNAME) or os.environ.get(_ENV_USERNAME)
    password = env.get(_ENV_PASSWORD) or os.environ.get(_ENV_PASSWORD)
    if username and password:
        return username, password
    return _prompt_and_store_creds()


def get_token(client_id: str | None = None) -> str:
    """Return a fresh Cognito ID token (JWT). Raises RuntimeError on auth failure
    with an actionable message rather than a raw boto3 traceback."""
    if client_id is None:
        client_id = discover_endpoint()["clientId"]

    username, password = _resolve_creds()
    cognito = _session().client("cognito-idp")

    try:
        resp = cognito.initiate_auth(
            AuthFlow="USER_PASSWORD_AUTH",
            ClientId=client_id,
            AuthParameters={"USERNAME": username, "PASSWORD": password},
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "NotAuthorizedException":
            raise RuntimeError(
                "Authentication failed: wrong username/password, or the user is "
                "disabled — check the user in the Cognito user pool. Delete "
                f"{_ENV_PATH} to re-enter credentials."
            ) from exc
        if code == "UserNotFoundException":
            raise RuntimeError(
                "Authentication failed: no such user in the pool — create/confirm "
                "a user first, then delete the cached .env to re-enter credentials."
            ) from exc
        raise RuntimeError(f"Cognito InitiateAuth failed ({code}): {exc}") from exc
    except BotoCoreError as exc:
        raise RuntimeError(f"Cognito InitiateAuth transport error: {exc}") from exc

    # The plugin does not implement password-reset / MFA challenge flows.
    challenge = resp.get("ChallengeName")
    if challenge:
        raise RuntimeError(
            f"Cognito returned a '{challenge}' challenge, which this plugin does "
            "not handle. Resolve the user's status in the Cognito user pool "
            "(e.g. set a permanent password / complete MFA setup) and retry."
        )

    auth_result = resp.get("AuthenticationResult", {})
    id_token = auth_result.get("IdToken")  # ID token, NOT AccessToken
    if not id_token:
        raise RuntimeError(
            "Cognito InitiateAuth succeeded but returned no IdToken — unexpected "
            "response shape."
        )
    return id_token


def main() -> int:
    try:
        print(get_token())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
