---
name: servicetitan-forms
description: >-
  Design, generate, check, and fix ServiceTitan native (Form 2.0) forms as import-ready JSON.
  Use when someone wants a new ServiceTitan form from a plain-English goal, wants a paper or PDF
  form turned into a native form, wants an existing form's JSON reviewed or repaired, or hits a
  Form 2.0 import, conditional-logic, trigger, or smart-field problem.
---

# ServiceTitan Forms (Form 2.0)

You are helping someone build a ServiceTitan native form. The deliverable is a JSON file in
ServiceTitan's **export format**, which they import on the Forms settings page. ServiceTitan's
public API has no endpoint that creates a form, so never promise an API call that does it.

This file is the instruction set. Read it fully before writing any JSON. The reference files hold
the details and are loaded only when a step points to them.

## Files in this kit

| Path | Read it when |
|---|---|
| `reference/schema.md` | Writing or reviewing any unit. Exact JSON for every field type. |
| `reference/conditional-logic.md` | The form shows or hides anything based on an answer. |
| `reference/triggers.md` | Choosing when ServiceTitan opens the form for the tech. |
| `reference/import-and-verify.md` | Before handing over JSON, and when an import or open fails. |
| `reference/style-guide.md` | Naming fields, sections, answer values, and the form itself. |
| `reference/prompts.md` | Ready-made prompts for outlining, forking, and auditing forms. |
| `schema/form20.schema.json` | Machine check of the JSON structure (JSON Schema 2020-12). |
| `generator/` | Python builder and checker. Prefer it over hand-writing JSON. |
| `examples/*.json` | Three complete, import-ready forms to copy from. |

## Hard rules

These come from real imports. Breaking any of them produces a form that imports but will not open,
or rules that misfire. The checker (`generator/generate.py --check`) enforces all of them.

1. `FormData.definition.published` is `true`. A draft import has no published snapshot and the
   editor cannot open it. Control who sees the form with **triggers**, not with this flag.
2. `FormData.createdOn` and `FormData.modifiedOn` are non-empty ISO timestamps.
3. `FormData.id` and `FormData.definition.id` are integers. ServiceTitan replaces both. Use
   non-zero values such as `9001` and `9002`.
4. The root section holds **only Sections**. Every field sits inside a Section.
5. **Never put a Section inside a Section.** It imports, then the editor fails to open it.
6. Every Section sets `canBeDuplicated: true` (the root section itself uses `false`).
7. Headings are `StaticElement` with `header: false` and `<h3>…</h3>` HTML. Not `header: true`.
8. Field types are `Text`, `Dropdown`, `Checkbox`, `Date`, `Picture`, `Signature`, `Stoplight`.
   There is no `Photo` (use `Picture`), `Toggle` (use a Checkbox with `["Yes"]`), `Radio`,
   `Header`, or `Paragraph`. Capture numbers and readings in `Text`; `Number` is not import-safe.
9. Unit ids are unique, lowercase hex UUIDs.
10. A `Stoplight` always has `defaultValue` of `"Green"`, `"Yellow"`, or `"Red"`.
11. A `Signature` always has a `refusalReasons` list.
12. Smart fields use the `smartFieldTag` property on a field. `{{customer.name}}` style tokens do
    not exist and print as literal text.
13. `hasConditionalLogic` is `true` exactly when `rules` is non-empty.
14. Rules use `Toggle` actions and `InitialLoad` or `Compare`/`Equals` conditions. Those are the
    only shapes confirmed in real exports. Anything else is unverified: say so if you use it.
15. When two rules touch the same unit, the **lower rule in the list wins**. Put baseline
    (`InitialLoad`) rules first and overrides after.
16. Actions that share one condition and one mode go in **one** rule. Split rules with the same
    condition send the rules engine into a loop.

## Workflow

Follow these steps in order. Do not skip the outline.

1. **Capture intent.** Ask for anything you cannot infer: what the form is for, who fills it out
   (tech, office, customer), when it should appear (arrival, job completion), what data must reach
   reporting, and whether an answer should reveal or hide other questions.
2. **Outline first. No JSON yet.** List the sections in order, the fields in each (label, type,
   required, answer values), every show/hide condition, and the trigger. Get approval. Changing an
   outline is cheap; changing 500 lines of JSON is not.
3. **Build.** If Python 3.10+ is available, write a config module and run the generator (see
   `generator/README.md`). Otherwise, copy the closest file in `examples/` and edit it, following
   `reference/schema.md` exactly. Reuse existing shapes. Never invent keys.
4. **Check.** Run `python3 generator/generate.py --check form.json` and fix every error. If you
   cannot run code, walk the checklist in `reference/import-and-verify.md` by hand and say that
   you did.
5. **Hand over** the JSON with these instructions for the user:
   - Import it with `FormTriggers: []` (no trigger), so no tech sees it yet.
   - Open the imported form in the editor. A new form id alone does not prove success.
   - Preview it and walk every answer path, especially anything that shows or hides fields.
   - Add the trigger last, in the ServiceTitan UI.

## Standard form shape

```
Section: Job Information     smart fields (customer, location, technician, date)
Section(s): body             checklists, readings, photos, materials
Section: Acknowledgment      StaticElement disclosure + Signature, always last
FormTriggers                 [] on first import
```

Four archetypes in `generator/archetypes.py` cover most forms:

| Archetype | Use it for | Rules |
|---|---|---|
| `inspection_checklist` | Pass/fail/N/A items plus text readings | none |
| `gated_block` | A "Yes" checkbox that reveals a block of sections | InitialLoad-Off + Compare-On |
| `escape_block` | Required photos or fields, with a "not present" checkbox that releases them | Compare-Off |
| `tech_acknowledgment` | Closing signature with refusal reasons | none |

Start flat. Add conditional logic only when the form needs it. Flat forms are the most reliable.

## When reviewing or fixing an existing form

1. Run the checker, or walk `reference/import-and-verify.md` by hand.
2. Match the symptom to the failure table in `reference/import-and-verify.md`.
3. Change the smallest thing that fixes it. Keep existing answer strings: they are stored values,
   and renaming one after publish breaks reporting and any rule that compares against it.

## Things you do not know

Be honest about these. Do not fill the gap with a guess.

- **Tenant names.** Business unit names, job type names, and tag names in triggers must match the
  user's ServiceTitan account exactly, including case and spaces. Ask for them, or leave the
  trigger out.
- **Tag ids.** Applying tags from a form uses tenant-specific numeric ids. Set tags up in the
  ServiceTitan form builder UI rather than in JSON.
- **Unconfirmed shapes.** Operators other than `Equals`, actions other than `Toggle`, `JobEvent`
  values other than `AfterArrival` and `OnCompletionAfterInvoice`, and smart-field tags beyond the
  four listed in `reference/schema.md` may exist, but no real export here confirms their JSON.
  Label anything you use from that list as unverified and tell the user to test it in Preview.
