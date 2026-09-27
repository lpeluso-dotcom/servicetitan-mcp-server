# Form 2.0 generator and checker

Python 3.10 or newer. Standard library only.

| File | Purpose |
|---|---|
| `generate.py` | Builds a form from a config module, or checks a form JSON file (`--check`). |
| `archetypes.py` | Builders for every field type, plus reusable blocks (job context, checklist, gate, escape, acknowledgment, trigger). |
| `rules.py` | Turns rule specs into the `rules[]` array, in precedence order, with same-condition actions merged. |
| `audit.py` | The checker. Reports errors (import or open will fail) and warnings (unverified or risky). |
| `configs/` | One module per example form. |
| `tests/` | `python3 -m unittest discover -s tests` |

## Check a form

```bash
python3 generate.py --check ../examples/job-materials.json
```

Exit code 0 means no errors. Warnings still print. Use this on any form JSON, including one written
by hand or by an LLM.

## Build a form

```bash
python3 generate.py configs/inspection_checklist.py                 # writes to the config's output_path
python3 generate.py configs/inspection_checklist.py --output form.json
python3 generate.py configs/inspection_checklist.py --seed 5        # reproducible unit ids
```

A config is a Python module with a `form` dict:

```python
from archetypes import (checkbox_field, escape_block, form_trigger, inspection_checklist,
                        job_context, picture_field, tech_acknowledgment)

form = {
    "name": "Generator Service - Inspection",
    "owner_types": ["Job"],
    "sections": [
        job_context(),
        inspection_checklist("Engine", [
            "CHECK OIL LEVEL",
            "INSPECT BELTS & HOSES",
            "RECORD RUN HOURS [text]",                               # a Text field, not a checkbox
            ("BATTERY CONDITION", ["Good", "Weak - Replace Soon", "Replaced"]),
        ]),
        escape_block("Transfer Switch",
                     [picture_field("TRANSFER SWITCH LABEL", required=True)],
                     "NO TRANSFER SWITCH / NO ACCESS"),
        tech_acknowledgment(prompt="I confirm the work above was completed",
                            refusal_reasons=["No one available to sign."]),
    ],
    "form_triggers": [],       # add the trigger in the ServiceTitan UI after testing
}

output_path = "generator-inspection.json"   # relative to this config file
```

Every entry in `sections` is what an archetype returns: `(list_of_sections, rule_specs)`. To build
your own block, return the same pair. Wrap loose fields with `section(name, units)`.

## Archetypes

| Builder | Makes | Rules |
|---|---|---|
| `job_context()` | Heading plus the four smart fields; `extra_fields=[...]` adds more | none |
| `inspection_checklist(title, items, intro=, answers=, required=)` | A checklist section. Items are names, `(name, values)` tuples, or names ending in ` [text]` | none |
| `gated_block(title, gate_label, sections)` | A gate section with a "Yes" checkbox, then `sections` hidden until it is checked | InitialLoad-Off + Compare-On |
| `escape_block(title, units, escape_label)` | `units` visible and (if you set it) required; checking the escape hides them and releases the requirement | Compare-Off |
| `tech_acknowledgment(prompt=, refusal_reasons=)` | Heading, optional print-only disclaimer, Signature | none |
| `form_trigger(job_event=, ...)` | One `FormTriggers` entry | n/a |

Field builders: `text_field`, `date_field`, `dropdown_field`, `checkbox_field`, `binary_toggle`,
`picture_field`, `stoplight_field`, `signature_field`, `static_element`, `heading`, `section`.
There is deliberately no Number builder: use `text_field` for readings.

## What the generator guarantees

`build_form` runs the checker on its own output and raises if there is any error, so a config that
builds is structurally import-safe. It cannot know your account's business unit, job type, or tag
names. Check those yourself before adding a trigger.

## Rule specs

Archetypes return rule specs, and `rules.py` turns them into Form 2.0 rules:

```python
{"kind": "initial_load_off", "unit_ids": [...]}
{"kind": "initial_load_on",  "unit_ids": [...]}
{"kind": "compare_equals_on",  "source_id": "<checkbox id>", "match_value": "Yes", "unit_ids": [...]}
{"kind": "compare_equals_off", "source_id": "<checkbox id>", "match_value": "Yes", "unit_ids": [...]}
```

InitialLoad rules are emitted first and Compare rules after, because the lower rule wins. Specs
with the same source, value, and mode merge into one rule.
