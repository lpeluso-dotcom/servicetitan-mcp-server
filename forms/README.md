# ServiceTitan Forms Kit

Build ServiceTitan native forms (Form 2.0) as import-ready JSON, by hand, with a small Python
generator, or with an AI assistant.

The kit is independent of the MCP server in this repository. It needs no ServiceTitan credentials
and makes no API calls. ServiceTitan's public API cannot create forms, so the output is a JSON file
that you import on the Forms settings page.

## What is in it

| Path | What it is |
|---|---|
| [`SKILL.md`](SKILL.md) | Instructions for an AI assistant. Start here if an LLM is doing the work. |
| [`AGENTS.md`](AGENTS.md) | Pointer for coding agents that look for this file name. |
| [`reference/`](reference/) | The Form 2.0 JSON format, conditional logic, triggers, import checklist, style guide, prompts. |
| [`schema/form20.schema.json`](schema/form20.schema.json) | JSON Schema (2020-12) for the import-safe structure. |
| [`generator/`](generator/) | Python 3.10+ builder and checker. Standard library only. |
| [`examples/`](examples/) | Three complete forms, ready to import. |

## Quick start

Check a form you already have:

```bash
python3 generator/generate.py --check my-form.json
```

Build one of the examples, or your own config:

```bash
cd generator
python3 generate.py configs/inspection_checklist.py --output ../my-form.json
```

Then import it:

1. In ServiceTitan, go to **Settings → Forms** and import the `.json` file.
2. Open the new form in the editor. The form opening is the real test, not the import succeeding.
3. Preview it and walk every answer path.
4. Add the trigger (when the form appears for techs) last, in the UI.

The full checklist and a table of failure symptoms are in
[`reference/import-and-verify.md`](reference/import-and-verify.md).

## Using it with an AI assistant

Point the assistant at [`SKILL.md`](SKILL.md). It works as:

- a Claude Code / Claude Agent Skill: copy this folder into a skills directory (for example
  `.claude/skills/servicetitan-forms/`);
- plain instructions for any other model: paste `SKILL.md` into the conversation or system prompt,
  then attach the reference file each step asks for.

The assistant outlines the form first, builds it after you approve the outline, and runs the
checker before handing it back. Ready-made prompts are in
[`reference/prompts.md`](reference/prompts.md).

## The examples

| File | Shows | Rules |
|---|---|---|
| [`inspection-checklist.json`](examples/inspection-checklist.json) | Job context, pass/fail checklists, text readings, customer signature | none |
| [`equipment-photo-capture.json`](examples/equipment-photo-capture.json) | Required photos with a "not present" escape checkbox | 2 |
| [`job-materials.json`](examples/job-materials.json) | "Yes" gates that reveal blocks of fixed rows | 4 |

Each one is built from the config of the same name in `generator/configs/`.

## How the rules were learned

Every shape in this kit comes from real ServiceTitan exports, and the import rules come from
imports that failed and the changes that fixed them. Where something is not confirmed, the
reference says so. If you confirm a new shape (another operator, trigger event, or smart-field tag),
export the form from ServiceTitan and add the exact JSON to the reference.

## Limits

- Only these rule shapes are confirmed: `Toggle` actions with `InitialLoad` or `Compare`/`Equals`
  conditions. The UI's other operators work in the UI; their JSON is not documented here.
- Trigger filters use your account's business unit, job type, and tag names. They must match
  exactly, and the kit cannot look them up.
- Applying tags from a form needs tenant-specific tag ids. Set that up in the form builder UI.
- ServiceTitan can change its form format. If an import that used to work starts failing, compare
  a fresh export from your account against `reference/schema.md`.
