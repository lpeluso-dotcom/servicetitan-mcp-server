# Prompts

Ready-to-use prompts for working with an AI assistant on ServiceTitan forms. Replace the
`{placeholders}`. Each authoring prompt stops at an outline on purpose: approve the outline, then
ask for JSON.

## Authoring

### Start a session

> Read `SKILL.md` in this forms kit, then `reference/schema.md`. Look at `examples/` to see
> complete forms. Do not write any JSON yet.

### New form from a goal

> Outline a ServiceTitan form for {goal}. Say who fills it in, when it should appear, and what data
> must reach reporting. List the sections in order with a one-line purpose each, then the fields in
> each section (label, type, required, answer values), then every show/hide condition, then the
> trigger. Stop after the outline. Do not write JSON.

Examples of `{goal}`:

- a residential cooling tune-up checklist that records refrigerant readings and flags systems over
  ten years old
- a plumbing closeout with a photo of the repair, the customer's signature, and a water heater age
  question

### Digitize a paper or PDF form

> Here is a paper form: {text or image}. Outline it as a ServiceTitan native form. Turn each
> checkbox row into a Checkbox field with the same answer set, each blank into a Text field, and each
> signature line into a Signature. Flag anything that should become a photo. Stop after the outline.

### Fork a form for another trade

> Here is a working form: {JSON}. Outline a version for {trade}. Keep its structure, answer sets,
> and rule patterns. List only what changes: sections removed, sections added, fields renamed.

### Merge several forms into one

> Here are {n} forms: {JSON or outlines}. Outline one form that replaces them. Put the shared
> questions in sections that always show. Put each trade-specific block behind a gate checkbox at
> the root, using the gated-block pattern. Stop after the outline.

### Generate after approval

> The outline is approved. Build it. If you can run Python, write a config for
> `generator/generate.py` using the archetypes and run it. Otherwise copy the closest file in
> `examples/` and follow `reference/schema.md` exactly. Then run the checker, or walk the checklist
> in `reference/import-and-verify.md`, and report the result.

## Auditing

Run these on any form before it is imported.

### Structure check

> Check this form against `reference/import-and-verify.md`, item by item: {JSON}. For each failed
> item, give the JSON path and the fix. Do not rewrite the whole form.

### Logic check

> Walk every rule in this form: {JSON}. For each rule, list its source field, its condition, and
> the units it shows or hides. Then report: rules that share a condition and mode (merge them),
> rules that mix On and Off, rules that toggle their own source, `right` strings that do not match
> an option exactly, and baseline rules that sit below the overrides they should lose to.

### Design review

> Review this form outline for a tech in the field: {outline}. Is the order natural? Are any
> required fields unnecessary? Are the answer values consistent and final? Would any section work
> better behind a gate? Give the three most important changes.

### Improve the prompt

> Here is the prompt I used and the result I got: {prompt} / {result}. What was ambiguous or
> missing in the prompt that led to the parts I did not want?
