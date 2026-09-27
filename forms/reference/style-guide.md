# Style guide

Conventions that make forms easy for techs to fill in and easy for the office to report on. They
are recommendations, not import requirements. The hard requirements are in `import-and-verify.md`.

## Form names

Pattern: `[Trade] [Phase] - [Task]`

| Good | Avoid |
|---|---|
| `HVAC Install - Bill of Materials` | `*HVAC Install - Parts Used` |
| `HVAC Service - Cooling Inspection` | `BEST COOLING Inspection` |
| `Plumbing Service - Closeout` | `plumbing closeout form` |

- Title Case, a spaced hyphen between phase and task, no leading symbols or spaces.
- Be specific: `Cooling Inspection`, not `Inspection`.

## Section order

```
1. Job Information        always first; smart fields
2. Body                   checklists, readings, photos, materials
3. Acknowledgment         always last; disclosure + Signature
```

Techs read top to bottom: who and where, what was done, sign off. Never put a Signature in the
middle. A field after the Signature feels disconnected, because the app treats the form as done
once it is signed.

## Field labels

- Upper case for field `name` values: `OUTSIDE TEMPERATURE`. Labels double as report column names,
  so consistency matters.
- Short and complete. `PIPE SIZE`, not `Please select the pipe size from the dropdown below`.
- No trailing punctuation: `TEST CONDENSATE PUMP`, not `TEST CONDENSATE PUMP?`.
- Put instructions in `description`, not in the label.

## Answer values are permanent

Dropdown and Checkbox `values` are stored exactly as written and compared exactly by rules and
reports. Choose them before the first publish, then treat them as fixed.

- No leading or trailing spaces. `" Yes"` and `"Yes"` are different values.
- Reuse one answer set for items that share a decision:

| Answer set | Use for |
|---|---|
| `Passed Inspection` / `Failed Inspection - Attention Required` | plain pass/fail |
| the same plus `N/A` | items that may not apply |
| `Yes` / `No` / `N/A` | yes/no checks |
| state-based, such as `Clean - No Attention Required` / `Cleaned` / `N/A` | when you want the finding and the action |
| `Yes` alone | a toggle |

## Refusal reasons

Signature `refusalReasons` should be the same strings on every form in the account, so reports can
roll them up. Keep a short shared list, for example:

- `No one available to sign.`
- `I am not satisfied with the service and would like the office to contact me.`
- `Customer refused access`

## Required fields

- Make a field required only when the data must exist. Every required field slows the tech down.
- Smart fields are never required. They fill themselves in.
- To let a tech skip a required field for a reason, use the escape pattern in
  `conditional-logic.md`. It also records the reason.

## Owner type

Default to `["Job"]`. The four confirmed smart fields resolve on Job-owned forms. Use another owner
type only when the form truly belongs to a customer, location, or piece of equipment.

## Anti-patterns

| Instead of | Do |
|---|---|
| `fieldType: "Header"` or `header: true` | `StaticElement`, `header: false`, `<h3>` HTML |
| `fieldType: "Toggle"` | Checkbox with `values: ["Yes"]` |
| `fieldType: "Photo"` | `Picture` |
| `fieldType: "Number"` | `Text` |
| `{{customer.name}}` in HTML | Text field with `smartFieldTag: "CustomerName"` |
| `options: [{value, label}]` on a Dropdown | `values: ["A", "B"]` |
| `Show` / `Hide` rule actions | `Toggle` with `mode: "On"` / `"Off"` |
| A Section inside a Section | Sibling Sections at the root |
| One rule per target with the same condition | One rule with several actions |
| Hundreds of flat checkbox + quantity pairs | A gate per category that reveals fixed rows |
| Keeping `Active: false` triggers | Delete them |
