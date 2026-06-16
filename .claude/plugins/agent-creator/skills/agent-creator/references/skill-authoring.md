# Skill authoring — the live skill registry

A **skill** is a markdown instruction package an agent loads at construction time. It
encodes reusable *expertise* — a procedure, a domain rubric, search heuristics — that is
too long to live inline in one agent's `instructions` and is worth sharing across agents.
It lives in the skills S3 bucket at `skills/{name}/SKILL.md`; a SINGLE agent references it
by name in its `skills[]` field. Authoring or editing a skill is **live, no redeploy** —
this is the *one* missing-building-block case that stays inside the plugin's live-runtime
contract (every other missing block — tool / state class / deterministic node — is code
in the container image and needs a redeploy: see [custom-code.md](custom-code.md)).

All operations go through `scripts/manage_skill.py`, which reuses `gql.py`/auth like every
other script (no new auth code). It is the **write** side of the `skills` registry that
[registries.md](registries.md) documents the read side of; `list_building_blocks.py
--filter skills` and `manage_skill.py list` both show new skills immediately.

## Skill vs. prompt vs. tool — decide first

| The need | It's a… | Where it goes | Redeploy? |
|---|---|---|---|
| Reusable expertise/procedure, used across agents or turns, too long for one prompt | **Skill** | `createSkill` → skills S3 bucket | **No** — `manage_skill.py` |
| One agent's one-off behavior, short | **Prompt** | that agent's `instructions` (modify path) | No |
| Something that must *execute code* (call an API, compute, transform) | **Tool** | `src/agent-core/` + `config.yaml` | **Yes** ([custom-code.md](custom-code.md)) |

A skill is *loadable text*, not executable code. If the capability needs to run logic →
it's a tool, not a skill. If the guidance only matters to one agent and fits in a prompt →
just edit that agent's `instructions`.

## The two backend rules (verified against `routes/skills.py`)

### 1. The resolver owns the frontmatter — send the BODY ONLY

`createSkill(name, description, content)` builds the `---name/description---` block itself
from the `name` and `description` args. `content` is the markdown **body only**. The
factory's SDK loader validates that the skill directory name matches the frontmatter
`name`, so a body that *also* carries a `name:` would clash and break loading.

`manage_skill.py` enforces this: `--body-file` is the body; if it starts with a
`---…---` block the script **strips it and warns** before sending. Never hand-craft
frontmatter into a body.

### 2. `updateSkill` MERGES — it is the OPPOSITE of the agent rule

> The agent modify path's dominating rule is **fetch the full config, change one thing,
> re-submit the WHOLE config** — any omitted field is wiped. **Skills are the exact
> reverse.** `updateSkill(name, description?, content?)` is a read-modify-write *merge*:
> omit `--description` and the existing description is preserved; omit `--body-file` and
> the existing body is preserved. Send only the field(s) that change.

`manage_skill.py update` shows a before/after body diff for the field(s) changing and
leaves the rest untouched. Stating this contrast out loud avoids carrying agent
muscle-memory into a skill update (which would otherwise lead you to re-send the whole
body every time "to be safe" — unnecessary, and it defeats the diff).

## `manage_skill.py` subcommands

```
manage_skill.py list                              → table of name/description/lastModified
manage_skill.py get   --name X                    → full markdown (frontmatter + body)
manage_skill.py create --name X --description "…" --body-file body.md [--yes]
manage_skill.py update --name X [--description …] [--body-file …] [--yes]   (MERGE)
manage_skill.py delete --name X [--yes]
manage_skill.py resources    --name X                          (experimental)
manage_skill.py put-resource --name X --path scripts/f.py --file f.py [--yes]
```

- **Read-only** (`list`/`get`/`resources`) never confirm. **Mutating**
  (`create`/`update`/`delete`/`put-resource`) require `--yes` or an interactive confirm
  (same posture as `submit_runtime.py`); a non-TTY without `--yes` refuses.
- **Name validation** mirrors the resolver's `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$` locally,
  failing fast with the resolver's exact message — no round-trip for a bad name.
- **`create` pre-checks uniqueness** via `listSkills` and points you at `update` instead
  of letting the resolver throw a raw "already exists" `ValueError`.
- **`delete` cross-checks `skills[]`** across every runtime agent's DEFAULT config and
  warns which agents currently reference the skill (they degrade silently — the factory
  logs a skip and the agent still starts, minus this skill — at their next start). It also
  reports any agent whose config it could not read, so the check is never silently
  incomplete. This is the one genuinely destructive op; treat it with production-safety
  care.

## Resources are supported — but lightly exercised

`uploadSkillResource(name, path, content)` adds an auxiliary file (`scripts/`,
`references/`, `assets/`) to a skill directory, and the live factory loader
(`src/agent-core/docker/src/factory.py:_download_skill_directory`) **does** download the
full skill directory — resources included — into the agent's temp dir. So resources reach
the running agent today; this is *not* a known loader gap.

The caveat is maturity, not mechanics: this path is **lightly exercised** end-to-end.
Prefer a single self-contained `SKILL.md` body whenever the guidance fits — it's the most
reliable artifact and the one the worked examples use. If you do upload resources, verify
with a live UI run that the agent picks them up before relying on them. `manage_skill.py
resources` / `put-resource` print this caveat. (Extending or hardening the loader is a
*backend* change in `src/agent-core/` and out of scope for this plugin — it stays a pure
API client.)

## Live, but behaviorally unverified

A created/updated skill is in S3 the instant the mutation returns and is referenceable by
name immediately. But:

- An **existing** agent only loads it at its **next start**. Re-submit the agent config
  (modify path → `submit_runtime.py`) to mint a fresh version that loads the new skill.
- This plugin confirms **registration**, not **behavior** — it does not run the agent to
  prove the skill helps. Tell the user it's live but unverified and suggest a UI run.

## GraphQL doc set

Source of truth: [`src/api/schema/schema.graphql`](../../../../../../src/api/schema/schema.graphql)
(types `Skill`, `SkillResource`). All ops are `@aws_cognito_user_pools`. The exact
documents `manage_skill.py` sends are mirrored in [queries.md](queries.md) under
"Skill registry"; keep all three in sync.

**Mutations:** `createSkill(name, description, content): Skill` ·
`updateSkill(name, description?, content?): Skill` (merge) · `deleteSkill(name): Boolean` ·
`uploadSkillResource(name, path, content): SkillResource` ·
`deleteSkillResource(name, path): Boolean`.

**Queries:** `listSkills: [Skill!]` · `getSkillContent(name): String` (full markdown incl.
frontmatter) · `listSkillResources(name): [SkillResource!]` · `getSkillResource(name,
path): String`.

`Skill` = `{ name, description, s3Key, lastModified }`. `SkillResource` = `{ path, size,
lastModified }`.
