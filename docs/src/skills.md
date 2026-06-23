# Agent Skills

> [← Documentation index](./index.md)

Skills give agents on-demand access to specialized instructions without bloating the system prompt. Instead of front-loading every possible instruction into a single prompt, you define modular skill packages that the agent discovers and activates only when relevant.

This feature implements the [Agent Skills specification](https://agentskills.io/specification) via the Strands SDK `AgentSkills` plugin.

## Overview

### What Are Skills?

A skill is a self-contained instruction package stored as a markdown file with YAML frontmatter. Skills follow the **progressive disclosure** pattern:

1. **Discovery** — On initialization, skill metadata (name + description) is injected into the agent's system prompt as an XML block
2. **Activation** — When the agent determines it needs a skill, it calls the `skills` tool → full instructions are loaded on-demand
3. **Execution** — The agent follows the loaded instructions for the duration of the conversation

This keeps the context window lean while giving the agent access to deep, specialized knowledge.

### When to Use Skills

| Approach | Best for | Trade-off |
|----------|----------|-----------|
| **System prompt** | Small, always-relevant instructions | Grows unwieldy with many capabilities |
| **Skills** | Modular, domain-specific instruction sets | Requires a tool call to activate |
| **Multi-agent** | Fundamentally different roles or models | Higher complexity and latency |

Use skills when you want a single agent that can handle a wide range of tasks by loading the right instructions at the right time, without the overhead of a multi-agent architecture.

---

## Creating a Skill

### Via the UI

1. Navigate to **AgentCore Manager** → click **Manage Skills** in the toolbar
2. Click **Create Skill**
3. Fill in the form:
   - **Skill Name** — Unique identifier (letters, digits, hyphens, underscores, max 64 chars). Examples: `pdf-processing`, `analog-alarms`, `code-review`
   - **Description** — Short summary that appears in the agent's system prompt. Keep it concise — this is what the agent reads to decide whether to activate the skill.
   - **Instructions (Markdown)** — The full skill body loaded on-demand when activated. Use markdown formatting with headers, lists, code blocks.
4. Click **Create**

### Adding Resource Files

After creating a skill, re-open it for editing and switch to the **Resources** tab:

1. Select the target directory (`scripts/`, `references/`, or `assets/`)
2. Enter the filename (e.g., `extract.py`)
3. Paste the file content
4. Click **Upload**

> **Note:** The Resources tab is disabled during creation — you must save the skill first, then re-open it to manage resources.

---

## SKILL.md Format

Skills follow the [Agent Skills specification](https://agentskills.io/specification). Each skill is stored as a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: pdf-processing
description: Extract text and tables from PDF files. Use when handling PDFs.
allowed-tools: file_read shell
---

# PDF Processing

You are a PDF processing expert. When asked to extract content from a PDF:

1. Use `shell` to run the extraction script at `scripts/extract.py`
2. Use `file_read` to review the output
3. Summarize the extracted content for the user

## Supported Formats
- Standard PDF documents
- Scanned PDFs (via OCR)
- PDF forms
```

### Frontmatter Fields

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase letters, numbers, hyphens. Must not start/end with hyphen. Must match the directory name. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. This text appears in the agent's system prompt. |
| `allowed-tools` | No | Space-separated list of tool names this skill uses (informational — not enforced at runtime). |
| `license` | No | License name or reference to bundled license file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping for custom data. |

---

## Resource Files

Skills can include resource files organized in three standard subdirectories:

```
my-skill/
├── SKILL.md           # Required: metadata + instructions
├── scripts/           # Optional: executable scripts the agent can run
│   └── extract.py
├── references/        # Optional: reference documents and guides
│   └── API-reference.md
└── assets/            # Optional: static files (templates, configs, data)
    └── mapping-template.json
```

### Supported File Types

Resource files uploaded via the UI are **text-only** (content is pasted into a textarea). Supported file extensions include:

| Directory | Typical Files | Purpose |
|-----------|---------------|---------|
| `scripts/` | `.py`, `.sh`, `.js`, `.ts` | Executable scripts the agent can run via `shell` or `file_read` |
| `references/` | `.md`, `.txt`, `.json`, `.yaml`, `.csv` | Reference documents the agent can read for additional context |
| `assets/` | `.json`, `.yaml`, `.xml`, `.csv`, `.txt`, `.html` | Templates, configuration files, static data |

### Limits

- **Maximum 20 resource files** per skill (matches the SDK's `max_resource_files` default)
- **Maximum 1 MB** per individual resource file
- **Text content only** — binary files (images, compiled scripts) are not supported via the UI

### How the Agent Accesses Resources

When a skill is activated via the `skills` tool, the SDK returns:
- The full SKILL.md instructions
- A listing of all available resource files with their absolute local paths

The agent can then use tools like `file_read` to access these files. For example:

```
Available resources:
  scripts/extract.py (at /tmp/agent_skills_xyz/pdf-processing/scripts/extract.py)
  references/API-reference.md (at /tmp/agent_skills_xyz/pdf-processing/references/API-reference.md)
```

> **Note:** Scripts are not automatically executed — the agent must explicitly call a tool (like `shell`) to run them.

---

## Attaching Skills to Agents

Skills are attached to agents during configuration in the **Agent Factory Wizard**:

1. Create or edit an agent in the Agent Factory
2. Navigate to the **Tools & Skills** step
3. In the **Skills** section at the bottom, select skills from the dropdown
4. Attached skills appear as dismissible tokens — click × to detach

Skills are stored in the agent configuration as a list of skill names:

```json
{
  "skills": ["pdf-processing", "code-review", "data-analysis"]
}
```

---

## How Skills Work at Runtime

When an agent starts:

1. The runtime reads the `skills` list from the agent configuration
2. For each skill name, downloads the entire skill directory from S3 (`skills/{name}/SKILL.md` + resources)
3. Writes to a local temp directory with the standard Agent Skills layout
4. Passes the temp directory to `AgentSkills(skills=temp_dir)` plugin
5. The plugin injects skill metadata into the system prompt and registers the `skills` tool

During conversation:

```
System prompt includes:
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extract text and tables from PDF files.</description>
  </skill>
  <skill>
    <name>code-review</name>
    <description>Review code for best practices and bugs.</description>
  </skill>
</available_skills>

User: "Can you extract the tables from this PDF?"

Agent thinks: "This is about PDF processing → I should activate that skill"
Agent calls: skills(skill_name="pdf-processing")
Agent receives: Full instructions + resource listing
Agent follows: The step-by-step instructions from the skill
```

---

## Best Practices

### Writing Good Descriptions

The description is what appears in the system prompt — it's the agent's only information to decide whether to activate a skill. Make it:

- **Action-oriented**: "Extract text and tables from PDF files" ✅ vs. "PDF processing capabilities" ❌
- **Contextual**: "Use when handling PDFs" tells the agent WHEN to activate
- **Concise**: Keep under 100 characters if possible — it's injected into every request

### Writing Good Instructions

The instruction body is loaded on-demand. It can be as long and detailed as needed:

- Use markdown headers to organize sections
- Include step-by-step procedures
- Reference resource files with relative paths (e.g., "run `scripts/extract.py`")
- Include examples and edge cases
- Use the `allowed-tools` frontmatter to document which tools the skill expects

### Skill Naming Conventions

- Use lowercase with hyphens: `pdf-processing`, `code-review`, `data-analysis`
- Be specific: `s3-bucket-security` > `security`
- Match the directory name exactly (enforced by the spec)

### When NOT to Use Skills

- If the instruction is always needed → put it in the **system prompt**
- If the skill would never be skipped → it's not saving context window space
- If the agent needs different tools/models → use a **multi-agent** architecture instead

---

## Limitations

- **Voice mode (BidiAgent)**: Skills are not currently supported in voice-to-voice mode. The `BidiAgent` class does not yet support the `plugins` parameter. This will be added when the Strands SDK adds plugin support to BidiAgent.
- **Binary resources**: Only text files can be uploaded via the UI. Binary files (images, compiled scripts) require direct S3 upload.
- **No inter-skill dependencies**: Skills are independent — there is no built-in mechanism for one skill to depend on another.

---

## Related Resources

- [Agent Skills Specification](https://agentskills.io/specification)
- [Strands Agents Skills Documentation](https://strandsagents.com/docs/user-guide/concepts/plugins/skills/)
- [Expanding AI Tools](./expanding-ai-tools.md)
- [Agent Factory Operations](./agent-factory.md)
