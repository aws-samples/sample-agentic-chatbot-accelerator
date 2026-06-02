# Gitmoji + Conventional Commits Cheatsheet

Subject line follows the **gitmoji** specification (https://gitmoji.dev/specification).
Body and footers follow **Conventional Commits** (https://www.conventionalcommits.org/) — gitmoji does not define them.

## Format

```
<emoji> [(scope)][:?] <message>

[optional body — explains *why*, not what]

[optional footer(s) — BREAKING CHANGE, Refs, Closes, etc.]
```

- Use the **unicode emoji**, not the `:shortcode:` form. It matches the existing `git log` in this repo and renders in terminals, GitHub, and IDE blame views.
- Subject is imperative mood, under ~72 chars total (including the emoji).
- Pick **one** emoji that captures the dominant intent. If a change feels like two emojis, it's probably two commits.

## Picking the right emoji

The full official catalog. Pick by *primary intent* — what would someone scanning the log most want to know about this commit?

### Most-used (start here)

| Emoji | Use when |
|-------|----------|
| ✨ | Introduce a new feature |
| 🐛 | Fix a bug |
| ♻️ | Refactor code (no behavior change) |
| 📝 | Add or update documentation |
| ⚡️ | Improve performance |
| 🚑 | Critical hotfix |
| ✅ | Add, update, or pass tests |
| ⬆️ | Upgrade dependencies |
| ⬇️ | Downgrade dependencies |
| 🔧 | Add or update configuration files |
| 👷 | Add or update CI build system |
| 💚 | Fix CI build |
| 🎨 | Improve structure / format of the code (not refactor) |
| 🔥 | Remove code or files |

### Full catalog

| Emoji | Shortcode | Description |
|-------|-----------|-------------|
| 🎨 | `:art:` | Improve structure / format of the code |
| ⚡️ | `:zap:` | Improve performance |
| 🔥 | `:fire:` | Remove code or files |
| 🐛 | `:bug:` | Fix a bug |
| 🚑 | `:ambulance:` | Critical hotfix |
| ✨ | `:sparkles:` | Introduce new features |
| 📝 | `:memo:` | Add or update documentation |
| 🚀 | `:rocket:` | Deploy stuff |
| 💄 | `:lipstick:` | Add or update the UI and style files |
| 🎉 | `:tada:` | Begin a project |
| ✅ | `:white_check_mark:` | Add, update, or pass tests |
| 🔒 | `:lock:` | Fix security or privacy issues |
| 🔐 | `:closed_lock_with_key:` | Add or update secrets |
| 🔖 | `:bookmark:` | Release / version tags |
| 🚨 | `:rotating_light:` | Fix compiler / linter warnings |
| 🚧 | `:construction:` | Work in progress |
| 💚 | `:green_heart:` | Fix CI build |
| ⬇️ | `:arrow_down:` | Downgrade dependencies |
| ⬆️ | `:arrow_up:` | Upgrade dependencies |
| 📌 | `:pushpin:` | Pin dependencies to specific versions |
| 👷 | `:construction_worker:` | Add or update CI build system |
| 📈 | `:chart_with_upwards_trend:` | Add or update analytics or tracking code |
| ♻️ | `:recycle:` | Refactor code |
| ➕ | `:heavy_plus_sign:` | Add a dependency |
| ➖ | `:heavy_minus_sign:` | Remove a dependency |
| 🔧 | `:wrench:` | Add or update configuration files |
| 🔨 | `:hammer:` | Add or update development scripts |
| 🌐 | `:globe_with_meridians:` | Internationalization and localization |
| ✏️ | `:pencil2:` | Fix typos |
| 💩 | `:poop:` | Write bad code that needs to be improved |
| ⏪ | `:rewind:` | Revert changes |
| 🔀 | `:twisted_rightwards_arrows:` | Merge branches |
| 📦 | `:package:` | Add or update compiled files or packages |
| 👽 | `:alien:` | Update code due to external API changes |
| 🚚 | `:truck:` | Move or rename resources (files, paths, routes) |
| 📄 | `:page_facing_up:` | Add or update license |
| 💥 | `:boom:` | Introduce breaking changes |
| 🍱 | `:bento:` | Add or update assets |
| ♿️ | `:wheelchair:` | Improve accessibility |
| 💡 | `:bulb:` | Add or update comments in source code |
| 🍻 | `:beers:` | Write code drunkenly |
| 💬 | `:speech_balloon:` | Add or update text and literals |
| 🗃️ | `:card_file_box:` | Perform database related changes |
| 🔊 | `:loud_sound:` | Add or update logs |
| 🔇 | `:mute:` | Remove logs |
| 👥 | `:busts_in_silhouette:` | Add or update contributor(s) |
| 🚸 | `:children_crossing:` | Improve user experience / usability |
| 🏗️ | `:building_construction:` | Make architectural changes |
| 📱 | `:iphone:` | Work on responsive design |
| 🤡 | `:clown_face:` | Mock things |
| 🥚 | `:egg:` | Add or update an easter egg |
| 🙈 | `:see_no_evil:` | Add or update a .gitignore file |
| 📸 | `:camera_flash:` | Add or update snapshots |
| ⚗️ | `:alembic:` | Perform experiments |
| 🔍 | `:mag:` | Improve SEO |
| 🏷️ | `:label:` | Add or update types |
| 🌱 | `:seedling:` | Add or update seed files |
| 🚩 | `:triangular_flag_on_post:` | Add, update, or remove feature flags |
| 🥅 | `:goal_net:` | Catch errors |
| 💫 | `:dizzy:` | Add or update animations and transitions |
| 🗑️ | `:wastebasket:` | Deprecate code that needs to be cleaned up |
| 🛂 | `:passport_control:` | Work on authorization, roles and permissions |
| 🩹 | `:adhesive_bandage:` | Simple fix for a non-critical issue |
| 🧐 | `:monocle_face:` | Data exploration / inspection |
| ⚰️ | `:coffin:` | Remove dead code |
| 🧪 | `:test_tube:` | Add a failing test |
| 👔 | `:necktie:` | Add or update business logic |
| 🩺 | `:stethoscope:` | Add or update healthcheck |
| 🧱 | `:bricks:` | Infrastructure related changes |
| 🧑‍💻 | `:technologist:` | Improve developer experience |
| 💸 | `:money_with_wings:` | Add sponsorships or money related infrastructure |
| 🧵 | `:thread:` | Add or update multithreading / concurrency code |
| 🦺 | `:safety_vest:` | Add or update validation code |
| ✈️ | `:airplane:` | Improve offline support |
| 🦖 | `:t-rex:` | Code that adds backwards compatibility |

### Disambiguation tips

- **🐛 vs 🚑** — `🚑` is for *critical* hotfixes that get cherry-picked or shipped urgently. Routine bug fixes are `🐛`.
- **🐛 vs 🩹** — `🩹` is for small fixes to non-critical issues. Both are valid; `🐛` if in doubt.
- **♻️ vs 🎨** — `♻️` is structural refactor (extract function, rename, restructure). `🎨` is cosmetic (formatting, whitespace, import order).
- **♻️ vs ⚡️** — `⚡️` only when the change measurably improves performance. A refactor that *might* be faster is still `♻️`.
- **🔥 vs ⚰️** — `⚰️` specifically for removing dead/unreachable code. `🔥` for any other code/file removal.
- **✨ vs 👔** — `✨` for user-facing new features. `👔` for internal business-logic additions/changes.
- **⬆️ / ⬇️ / ➕ / ➖ / 📌** — upgrade / downgrade / add / remove / pin dependencies. Pick the most specific.
- **🔧 vs 🔨 vs 👷** — `🔧` config files (eslint, tsconfig, app config), `🔨` dev scripts (Makefile, shell scripts), `👷` CI/CD pipelines.
- **💥** — only when the change is a breaking change *itself*. Most breaking changes pair `💥` with another emoji on the same commit by convention; if forced to pick one, use `💥` and put the feature/fix detail in the body.

## Breaking changes

Gitmoji has `💥` as a marker, but downstream tooling (semantic-release, changelog generators) reads the **Conventional Commits** footer. Always include both for breaking changes:

```
💥 ✨ replace REST chat endpoint with WebSocket

The browser now talks to AgentCore directly over WebSocket using a
SigV4-presigned URL. AppSync is no longer in the chat data path.

BREAKING CHANGE: clients on the old `/chat` REST endpoint will need to
migrate to the WebSocket flow described in `docs/runtime-data-plane.md`.
```

## Examples

```
🐛 fix race condition in parallel CodeBuild trigger
✨ (agent-core) add Nova Sonic voice mode to BidiAgent
♻️ (cdk) collapse builder + aca stacks into a single deploy
📝 update CONTRIBUTING with ASH scan requirement
⬆️ bump aws-cdk-lib from 2.150 to 2.165
🚑 enable zero-setup deploy on fresh clone
🔧 (eslint) tighten unused-vars rule
👷 add cdk-nag step to PR pipeline
🔥 remove legacy local Docker fallback
```

## Footer references

| Footer | Use |
|--------|-----|
| `BREAKING CHANGE: <description>` | Mark a breaking change for changelog tooling |
| `Refs: <ID>` | Reference a SIM/Taskei/Jira ticket without closing it |
| `Closes: #<num>` | Close a GitHub issue when the commit lands on main |
| `Co-authored-by: Name <email>` | Credit pair-programming partners |
| `Reviewed-by: Name <email>` | Credit code reviewer (rare in this repo) |
