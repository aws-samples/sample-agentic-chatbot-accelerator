# 0006 — Introduce a per-row `⋯` ButtonDropdown action-menu convention

- Status: Accepted
- Date: 2026-07-30
- Context: [refactor-runtime-manager-ui story](../../local/user-stories/refactor-runtime-manager-ui/story.md), [design doc](../../local/user-stories/refactor-runtime-manager-ui/design-doc.md)

## Context

The AgentCore Runtime Manager currently packs all selection-scoped actions (New version, Tag version, Set as Favorite, View, Delete) into the table **header toolbar** as `inline-link` buttons gated on `selectedItems.length === 1` (`agent-core-runtime-manager.tsx:560-647`). This story adds two more actions (Start a session, Update container), bringing the total to ~7 — the toolbar is already crowded.

Every existing admin table in the app renders per-row actions as an **inline-button "Actions" column** (`skill-manager.tsx:232`, `mcp-server-manager.tsx:244`, `run-history-modal.tsx:189`). The only `ButtonDropdown` in the codebase is the header profile menu (`global-header.tsx:65`) — there is **no** per-row dropdown pattern today. Seven inline buttons per row would be visually unmanageable.

## Decision

Introduce a per-row **three-dots (`⋯`) `ButtonDropdown`** as the "Actions" column for the Runtime Manager. Items are the selection-scoped actions; each item's `disabled` state reflects the row's status (e.g. transient-status rows disable Delete/Update). Delete additionally **remains in the header** for multi-select whole-agent deletion.

The `items` / `onItemClick` (`ButtonDropdownProps.ItemClickDetails`) shape follows the existing `global-header.tsx` usage. The dropdown lives in a small dedicated `row-actions.tsx` component so it can be reused and unit-reasoned in isolation.

## Consequences

- **Positive:** Scales cleanly to 7+ actions; declutters the header; per-item disabling gives clearer affordances than a greyed toolbar button.
- **Positive:** Establishes a reusable row-menu pattern other admin tables can adopt as their action lists grow.
- **Negative:** Diverges from the current inline-button-Actions-column convention, so the app now has two row-action idioms until others migrate. Acceptable: inline buttons remain fine for tables with ≤2 actions; the dropdown is the choice when the list is long.
- **Trade-off:** One extra click to reach an action versus a directly-visible button — accepted in exchange for a readable row at 7 actions.
