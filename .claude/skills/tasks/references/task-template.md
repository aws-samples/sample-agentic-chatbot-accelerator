# T<N> — <task title>

| | |
|---|---|
| **Status** | not-started |
| **Depends on** | <T? or —> |

**Satisfies (story Definition of Done):**
- "<the story Definition-of-Done checkbox this task satisfies — one bullet per checkbox, quoted verbatim>"

## Objective

<1–3 sentences: what this unit delivers and where it stops. State what is explicitly NOT in this task if a reader might assume otherwise.>

## Files

- `<path/to/file>` <(new / modified — one line on what changes)>

## API surface

<The **interface** to implement, NOT the implementation. Specify the public shapes — functions, classes, Pydantic/dataclass models, enums, protocols, key type signatures (TS: functions, interfaces, types) — each with a docstring describing intent, invariants, and error conditions. Bodies stay as `...`/`raise NotImplementedError`/prose so the building-phase agent has clear guidance on *what* to build without copy-pasting a *how*. Include only what pins down the contract: signatures, field/variant meanings, and error conditions.>

```python
def <name>(<params>: <Type>) -> <ReturnType>:
    """<what this function is for; invariants; when it raises.>"""
    ...


class <Name>(BaseModel):
    """<what this model represents.>"""

    <field>: <Type>  # <field meaning>


class <Enum>(str, Enum):
    <VARIANT> = "<value>"  # <meaning>
```

<For TypeScript units (React/CDK), use a `ts` block instead — exported function signatures, `interface`/`type` shapes, and enums, with bodies left as `throw new Error("todo")` or JSDoc prose.>

## Notes / gotchas

<API points likely to differ across versions, subtle ordering constraints, decisions the builder must honor. Point to the SDK example or docs to confirm exact signatures at build time. Omit if none.>

## Acceptance

- [ ] Lint/type checks pass (Python: `ruff`/`black`/`pytest`; TS: `tsc`/`eslint`).
- [ ] <task-specific observable check tied to the DoD mapping.>

## Decisions

<Task-local decisions with rationale, marked ✅ once decided. Omit if none.>
