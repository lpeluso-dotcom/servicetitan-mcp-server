# Import and verify

A form that imports is not necessarily a form that works. The import can return a new form id and
still leave a record the editor cannot open. This page is the checklist that prevents that, and
the table for diagnosing it when it happens anyway.

## Before import: the checklist

`python3 generator/generate.py --check form.json` runs every item below. If you cannot run it,
check by hand.

**Envelope**

- [ ] Top level has `FormData`, `FormTriggers`, `IsForm20: true`, `IsLocked: false`.
- [ ] `FormData.id` and `FormData.definition.id` are non-zero integers.
- [ ] `FormData.createdOn` and `FormData.modifiedOn` are non-empty ISO timestamps.
- [ ] `FormData.definition.published` is `true`.
- [ ] `FormTriggers` is `[]` for the first import.

**Layout**

- [ ] `rootSection.units` contains only Sections.
- [ ] No Section contains another Section.
- [ ] Every Section except the root has `canBeDuplicated: true`.
- [ ] Headings are `StaticElement` with `header: false` and `<h3>` HTML.
- [ ] Every unit id is a unique, lowercase hex UUID.

**Fields**

- [ ] `fieldType` is one of `Text`, `Dropdown`, `Checkbox`, `Date`, `Picture`, `Signature`, `Stoplight`.
- [ ] No `Number`, `Photo`, `Toggle`, `Radio`, `Header`, or `Paragraph` field types.
- [ ] Dropdown and Checkbox `values` are non-empty lists of strings with no leading or trailing spaces.
- [ ] Checkboxes carry `horizontalLayout: false`.
- [ ] Every Signature has a `refusalReasons` list.
- [ ] Every Stoplight has `defaultValue` of `Green`, `Yellow`, or `Red`.
- [ ] Smart fields use `smartFieldTag` on the right field type; no `{{...}}` tokens anywhere.

**Rules** (see `conditional-logic.md`)

- [ ] `hasConditionalLogic` is `true` exactly when `rules` is non-empty.
- [ ] Every rule uses `conditions` (plural list), not `condition`.
- [ ] Every referenced id exists; every condition source is a Field.
- [ ] No two rules share a condition and mode; no rule mixes `On` and `Off`.
- [ ] No rule toggles its own source.

## Import

1. In ServiceTitan, go to **Settings → Forms** and use the import option to upload the `.json`
   file. The file is uploaded as-is; do not paste it into a field.
2. ServiceTitan assigns new ids to the form and its definition.

## After import: prove it works

1. **Open the form in the editor.** A new id from the import proves nothing. Opening it is the
   real test.
2. **Preview it and walk every path.** Check and uncheck every gate and escape. Confirm required
   fields block submission when visible and release when hidden.
3. **Add the trigger last**, in the UI, once every path works.

## When it fails

| Symptom | Likely cause | Fix |
|---|---|---|
| Import returns an id, but opening the form shows a blank screen, then a server error; the browser console shows `Cannot read properties of undefined (reading 'definition')` | `published: false` | Set `definition.published: true` and re-import. |
| Same blank screen or null-reference error | `createdOn` / `modifiedOn` missing | Add both timestamps. |
| Same blank screen or null-reference error | Fields directly under the root, or `header: true` headings | Wrap fields in Sections with `canBeDuplicated: true`; use `header: false` + `<h3>`. |
| Imports, then the editor fails with a type-mapping error mentioning `Units` | A Section nested inside a Section | Move inner sections up to the root as siblings. |
| Opening the form returns a null-reference server error | A Stoplight without `defaultValue` | Add `"defaultValue": "Green"`. |
| Import rejected: `Unit has invalid or empty Id` | An id with non-hex characters (such as `g`, `h`, `n`, `p`) or uppercase | Use lowercase hex UUIDs. |
| Preview console floods with `Cascade loop detected on unit ...`; gated fields show when they should be hidden | Several rules with the same condition | Merge their actions into one rule. |
| Rules never fire | `hasConditionalLogic: false`, or `IsForm20` missing, or `condition` (singular) | Set `hasConditionalLogic: true`, `IsForm20: true`, use `conditions: [...]`. |
| A rule never fires even though the answer looks right | The `right` string differs from the option by case or a space | Copy the option string exactly. |
| `{{customer.name}}` shows as literal text | Tokens are not a Form 2.0 feature | Use a Text field with `smartFieldTag: "CustomerName"`. |
| The form never appears for techs | No trigger, `Active: false`, or a trigger name that does not match the account exactly | Add or fix the trigger in the UI. |
| The tech gets the form twice | Two active triggers match the same job | Keep one. |

## Two JSON formats: do not mix them

ServiceTitan uses two different JSON shapes for forms. This kit uses only the first.

| | Export format (this kit) | Internal editor format |
|---|---|---|
| Top level | `FormData`, `FormTriggers`, `IsForm20` | `FormItems`, `FormSections`, `Name` |
| Units | `rootSection.units[]` with `unitType` | `FormItems[]` / `FormSections[]` with `ItemType` |
| Field keys | `fieldType`, `name`, `isRequired`, `values` | `ItemType`, `Header`, `Required`, `Options` |

JSON in one format pasted where the other is expected fails. If a form you are given has
`FormItems`, it is not export format. Export the form from the ServiceTitan UI instead.

## Old exports are not templates

Forms built by hand years ago may use shapes that still render in production but do **not**
survive a fresh import: fields at the root, `header: true` headings, `Number` fields. When you copy
from an existing export, copy its questions and answer sets, then rebuild the structure with this
kit.
