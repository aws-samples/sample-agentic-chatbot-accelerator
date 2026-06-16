#!/usr/bin/env python3
"""Author skills in the deployed accelerator's live skill registry.

Skills are markdown instruction packages stored in the skills S3 bucket at
`skills/{name}/SKILL.md`. Any SINGLE agent references them by name in its
`skills[]` field, and the factory loads them at agent-construction time straight
from S3 — so a new or updated skill is live with **no redeploy**; an existing
agent picks it up at its next start (re-submit the agent config to force a fresh
version, see the SKILL.md skill-authoring path).

This is the write side of the `skills` registry; `list_building_blocks.py
--filter skills` is the read side and shows new skills immediately.

Two backend rules drive this script (verified against
`src/api/functions/http-api-handler/routes/skills.py`):

  1. **The resolver owns frontmatter.** `createSkill` builds the `---name/
     description---` block itself from the `name`/`description` args; `content`
     is the markdown **body only**. This script strips an accidental leading
     frontmatter block (and warns) so a body never reintroduces a conflicting
     name and breaks the SDK's dir-name==frontmatter-name check.
  2. **`updateSkill` MERGES, it does not replace.** Omitted args are preserved
     server-side (omit `--description` → existing description kept; omit
     `--body-file` → existing body kept). This is the OPPOSITE of the agent
     full-config-replace rule — see references/skill-authoring.md. Don't carry
     agent muscle-memory here.

Mutating subcommands (create/update/delete/put-resource) require `--yes` or an
interactive confirm. Read-only subcommands (list/get/resources) never confirm.

Usage:
  manage_skill.py list
  manage_skill.py get   --name X
  manage_skill.py create --name X --description "…" --body-file body.md [--yes]
  manage_skill.py update --name X [--description …] [--body-file …] [--yes]
  manage_skill.py delete --name X [--yes]
  manage_skill.py resources    --name X
  manage_skill.py put-resource --name X --path scripts/foo.py --file foo.py [--yes]
"""

from __future__ import annotations

import argparse
import difflib
import re
import sys
from pathlib import Path

try:
    from fetch_agent_config import fetch_agent_config
    from gql import post
    from list_building_blocks import list_building_blocks
except ImportError:  # allow running as a module from elsewhere
    from .fetch_agent_config import fetch_agent_config
    from .gql import post
    from .list_building_blocks import list_building_blocks

# Mirror of the resolver's regex (skills.py:_validate_skill_name) so a bad name
# fails fast locally with the same message instead of a server round-trip.
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
_NAME_RULE = (
    "Skill name must start with a letter/digit and contain only letters, "
    "digits, hyphens, and underscores (max 64 chars)"
)

# Mirror of the resolver's frontmatter matcher (skills.py:_FRONTMATTER_RE) — used
# only to DETECT and strip an accidental leading frontmatter block from a body.
_FRONTMATTER_RE = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)

# ── GraphQL documents (canonical form + traps: references/queries.md) ──
_LIST_SKILLS = """
query ListSkills {
  listSkills { name description s3Key lastModified }
}
"""

_GET_SKILL_CONTENT = """
query GetSkillContent($name: String!) {
  getSkillContent(name: $name)
}
"""

_LIST_SKILL_RESOURCES = """
query ListSkillResources($name: String!) {
  listSkillResources(name: $name) { path size lastModified }
}
"""

_CREATE_SKILL = """
mutation CreateSkill($name: String!, $description: String!, $content: String!) {
  createSkill(name: $name, description: $description, content: $content) {
    name description s3Key lastModified
  }
}
"""

_UPDATE_SKILL = """
mutation UpdateSkill($name: String!, $description: String, $content: String) {
  updateSkill(name: $name, description: $description, content: $content) {
    name description s3Key lastModified
  }
}
"""

_DELETE_SKILL = """
mutation DeleteSkill($name: String!) {
  deleteSkill(name: $name)
}
"""

_UPLOAD_SKILL_RESOURCE = """
mutation UploadSkillResource($name: String!, $path: String!, $content: String!) {
  uploadSkillResource(name: $name, path: $path, content: $content) {
    path size lastModified
  }
}
"""


# ── helpers ────────────────────────────────────────────────────────────
def _validate_name(name: str) -> None:
    """Raise RuntimeError with the resolver's exact message if name is invalid."""
    if not _NAME_RE.match(name):
        raise RuntimeError(_NAME_RULE)


def _strip_frontmatter(body: str) -> str:
    """Strip a leading `---…---` frontmatter block from a body, warning if found.

    The resolver builds frontmatter from --name/--description; a body that also
    carries a name would clash with the SDK's dir-name==frontmatter-name check.
    """
    if _FRONTMATTER_RE.match(body):
        print(
            "Warning: --body-file starts with a '---…---' frontmatter block. The "
            "registry builds frontmatter from --name/--description itself, so this "
            "script is stripping the block and sending body-only content.",
            file=sys.stderr,
        )
        return _FRONTMATTER_RE.sub("", body, count=1).lstrip()
    return body


def _split_frontmatter(content: str) -> tuple[str, str]:
    """Split full SKILL.md into (frontmatter-block, body) — '' frontmatter if none."""
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return "", content.strip()
    return match.group(0), content[match.end() :].strip()


def _list_skills() -> list[dict]:
    return post(_LIST_SKILLS).get("listSkills") or []


def _find_skill(name: str, skills: list[dict] | None = None) -> dict | None:
    for skill in skills if skills is not None else _list_skills():
        if skill.get("name") == name:
            return skill
    return None


def _confirm(prompt: str, assume_yes: bool) -> bool:
    """Return True if the user approved. --yes skips; non-tty without --yes refuses."""
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        print(
            "Refusing a mutating operation without confirmation. Re-run with --yes "
            "(no interactive prompt is available — stdin is not a TTY).",
            file=sys.stderr,
        )
        return False
    answer = input(f"{prompt} [y/N] ").strip().lower()
    return answer in ("y", "yes")


def _agents_referencing(skill_name: str) -> tuple[list[str], list[str]]:
    """Return (agents_referencing_skill, agents_we_could_not_check).

    Cross-checks every runtime agent's DEFAULT config `skills[]`. An agent whose
    config can't be fetched is reported separately so the user knows the
    reference check was incomplete rather than silently clean.
    """
    referencing: list[str] = []
    unchecked: list[str] = []
    agents = list_building_blocks("agents").get("agents") or []
    for agent in agents:
        agent_name = agent.get("agentName")
        if not agent_name:
            continue
        try:
            cfg = fetch_agent_config(agent_name).get("config") or {}
        except RuntimeError:
            unchecked.append(agent_name)
            continue
        if skill_name in (cfg.get("skills") or []):
            referencing.append(agent_name)
    return referencing, unchecked


# ── subcommands ──────────────────────────────────────────────────────────
def _cmd_list(_args: argparse.Namespace) -> int:
    skills = _list_skills()
    if not skills:
        print("No skills in the registry.")
        return 0
    name_w = max(len("NAME"), *(len(s.get("name", "")) for s in skills))
    mod_w = max(
        len("LAST MODIFIED"), *(len(s.get("lastModified") or "") for s in skills)
    )
    print(f"{'NAME':<{name_w}}  {'LAST MODIFIED':<{mod_w}}  DESCRIPTION")
    for s in sorted(skills, key=lambda x: x.get("name", "")):
        print(
            f"{s.get('name', ''):<{name_w}}  "
            f"{(s.get('lastModified') or ''):<{mod_w}}  "
            f"{s.get('description', '')}"
        )
    return 0


def _cmd_get(args: argparse.Namespace) -> int:
    content = post(_GET_SKILL_CONTENT, {"name": args.name}).get("getSkillContent")
    if content is None:
        print(
            f"Skill '{args.name}' not found. Run `manage_skill.py list` to see "
            f"existing skills.",
            file=sys.stderr,
        )
        return 1
    print(content)
    return 0


def _cmd_resources(args: argparse.Namespace) -> int:
    print(
        "Note: skill resources (scripts/, references/, assets/) are lightly "
        "exercised — see references/skill-authoring.md. The live factory loader "
        "DOES download the full skill directory, but a self-contained SKILL.md "
        "body is the most reliable artifact.",
        file=sys.stderr,
    )
    resources = post(_LIST_SKILL_RESOURCES, {"name": args.name}).get(
        "listSkillResources"
    )
    if not resources:
        print(f"No resources for skill '{args.name}'.")
        return 0
    path_w = max(len("PATH"), *(len(r.get("path", "")) for r in resources))
    print(f"{'PATH':<{path_w}}  {'SIZE':>8}  LAST MODIFIED")
    for r in sorted(resources, key=lambda x: x.get("path", "")):
        print(
            f"{r.get('path', ''):<{path_w}}  {r.get('size', 0):>8}  "
            f"{r.get('lastModified') or ''}"
        )
    return 0


def _cmd_create(args: argparse.Namespace) -> int:
    _validate_name(args.name)

    # Pre-create uniqueness check: a clean "use update" beats the resolver's
    # raw ValueError on a duplicate name.
    if _find_skill(args.name) is not None:
        print(
            f"Skill '{args.name}' already exists. Use "
            f"`manage_skill.py update --name {args.name} …` to change it "
            f"(update MERGES — omitted fields are preserved).",
            file=sys.stderr,
        )
        return 1

    try:
        body = _strip_frontmatter(Path(args.body_file).read_text())
    except OSError as exc:
        print(f"Could not read --body-file: {exc}", file=sys.stderr)
        return 2

    print(f"About to CREATE skill '{args.name}':")
    print(f"  description: {args.description}")
    print(f"  body: {len(body)} chars from {args.body_file}")
    if not _confirm(f"Create skill '{args.name}'?", args.yes):
        print("Aborted.", file=sys.stderr)
        return 1

    skill = post(
        _CREATE_SKILL,
        {"name": args.name, "description": args.description, "content": body},
    ).get("createSkill")
    print(
        f"Created skill '{args.name}'. It is live in S3 now and appears in "
        f"`list_building_blocks.py --filter skills` immediately. Reference it in a "
        f"SINGLE agent's `skills[]` — an existing agent loads it only at its next "
        f"start (re-submit the agent config to force a fresh version)."
    )
    if skill:
        print(f"  s3Key: {skill.get('s3Key')}")
    return 0


def _cmd_update(args: argparse.Namespace) -> int:
    _validate_name(args.name)
    if args.description is None and args.body_file is None:
        print(
            "Nothing to update — pass --description and/or --body-file.",
            file=sys.stderr,
        )
        return 2

    current = post(_GET_SKILL_CONTENT, {"name": args.name}).get("getSkillContent")
    if current is None:
        print(
            f"Skill '{args.name}' not found — `update` cannot create. Use "
            f"`manage_skill.py create` instead.",
            file=sys.stderr,
        )
        return 1
    _, current_body = _split_frontmatter(current)

    new_body = None
    if args.body_file is not None:
        try:
            new_body = _strip_frontmatter(Path(args.body_file).read_text())
        except OSError as exc:
            print(f"Could not read --body-file: {exc}", file=sys.stderr)
            return 2

    # updateSkill MERGES (opposite of the agent full-config-replace rule): we
    # send ONLY the field(s) changing; omitted args are preserved server-side.
    print(
        f"About to UPDATE skill '{args.name}' (MERGE — fields you don't pass are "
        f"kept; this is the OPPOSITE of the agent full-config-replace rule):"
    )
    if args.description is not None:
        print(f"  description → {args.description}")
    else:
        print("  description: unchanged")
    if new_body is not None:
        diff = list(
            difflib.unified_diff(
                current_body.splitlines(),
                new_body.splitlines(),
                fromfile=f"{args.name}/SKILL.md (current body)",
                tofile=f"{args.name}/SKILL.md (new body)",
                lineterm="",
            )
        )
        if diff:
            print("  body diff:")
            for line in diff:
                print(f"    {line}")
        else:
            print("  body: identical (no change)")
    else:
        print("  body: unchanged")

    if not _confirm(f"Update skill '{args.name}'?", args.yes):
        print("Aborted.", file=sys.stderr)
        return 1

    variables: dict = {"name": args.name}
    if args.description is not None:
        variables["description"] = args.description
    if new_body is not None:
        variables["content"] = new_body
    post(_UPDATE_SKILL, variables)
    print(
        f"Updated skill '{args.name}'. Agents already referencing it pick up the "
        f"change at their next start — re-submit the agent config to force it."
    )
    return 0


def _cmd_delete(args: argparse.Namespace) -> int:
    skill = _find_skill(args.name)
    if skill is None:
        print(f"Skill '{args.name}' not found — nothing to delete.", file=sys.stderr)
        return 1

    referencing, unchecked = _agents_referencing(args.name)
    print(f"About to DELETE skill '{args.name}'.")
    print(f"  description: {skill.get('description', '')}")
    if referencing:
        print(
            "  ⚠️  These agents currently reference this skill and will silently "
            "degrade (the factory logs a skip and the agent still starts, minus "
            "this skill) at their next start:"
        )
        for agent_name in referencing:
            print(f"      - {agent_name}")
    else:
        print("  No agents reference this skill.")
    if unchecked:
        print(
            "  Note: could not read the config of these agents, so the reference "
            f"check is incomplete: {', '.join(unchecked)}"
        )

    if not _confirm(f"Permanently delete skill '{args.name}'?", args.yes):
        print("Aborted.", file=sys.stderr)
        return 1

    post(_DELETE_SKILL, {"name": args.name})
    print(f"Deleted skill '{args.name}' (SKILL.md and all resources).")
    return 0


def _cmd_put_resource(args: argparse.Namespace) -> int:
    print(
        "Note: skill resources are EXPERIMENTAL in this plugin. The live factory "
        "loader downloads the full skill directory (resources included), but this "
        "path is lightly exercised — prefer a self-contained SKILL.md body when you "
        "can. See references/skill-authoring.md.",
        file=sys.stderr,
    )
    if _find_skill(args.name) is None:
        print(
            f"Skill '{args.name}' not found — create the skill first "
            f"(`manage_skill.py create`).",
            file=sys.stderr,
        )
        return 1
    try:
        content = Path(args.file).read_text()
    except OSError as exc:
        print(f"Could not read --file: {exc}", file=sys.stderr)
        return 2

    print(f"About to UPLOAD resource to skill '{args.name}':")
    print(f"  path: {args.path}")
    print(f"  content: {len(content)} chars from {args.file}")
    if not _confirm(f"Upload resource '{args.path}' to '{args.name}'?", args.yes):
        print("Aborted.", file=sys.stderr)
        return 1

    resource = post(
        _UPLOAD_SKILL_RESOURCE,
        {"name": args.name, "path": args.path, "content": content},
    ).get("uploadSkillResource")
    print(f"Uploaded resource '{args.path}' to skill '{args.name}'.")
    if resource:
        print(f"  size: {resource.get('size')} bytes")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="table of name/description/lastModified")
    p_list.set_defaults(func=_cmd_list)

    p_get = sub.add_parser("get", help="full markdown (frontmatter + body)")
    p_get.add_argument("--name", required=True)
    p_get.set_defaults(func=_cmd_get)

    p_create = sub.add_parser("create", help="create a new skill (body-only content)")
    p_create.add_argument("--name", required=True)
    p_create.add_argument("--description", required=True)
    p_create.add_argument(
        "--body-file",
        required=True,
        help="markdown body (frontmatter stripped if present)",
    )
    p_create.add_argument("--yes", action="store_true", help="skip confirmation")
    p_create.set_defaults(func=_cmd_create)

    p_update = sub.add_parser("update", help="MERGE-update (omitted fields preserved)")
    p_update.add_argument("--name", required=True)
    p_update.add_argument(
        "--description", help="new description (omit to keep current)"
    )
    p_update.add_argument(
        "--body-file",
        help="new markdown body (omit to keep current; frontmatter stripped)",
    )
    p_update.add_argument("--yes", action="store_true", help="skip confirmation")
    p_update.set_defaults(func=_cmd_update)

    p_delete = sub.add_parser(
        "delete", help="delete a skill (warns on referencing agents)"
    )
    p_delete.add_argument("--name", required=True)
    p_delete.add_argument("--yes", action="store_true", help="skip confirmation")
    p_delete.set_defaults(func=_cmd_delete)

    p_res = sub.add_parser("resources", help="list a skill's resources (experimental)")
    p_res.add_argument("--name", required=True)
    p_res.set_defaults(func=_cmd_resources)

    p_put = sub.add_parser(
        "put-resource", help="upload a resource to a skill (experimental)"
    )
    p_put.add_argument("--name", required=True)
    p_put.add_argument(
        "--path", required=True, help="relative path, e.g. scripts/foo.py"
    )
    p_put.add_argument("--file", required=True, help="local file to upload as content")
    p_put.add_argument("--yes", action="store_true", help="skip confirmation")
    p_put.set_defaults(func=_cmd_put_resource)

    return parser


def main() -> int:
    args = _build_parser().parse_args()
    try:
        return args.func(args)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
