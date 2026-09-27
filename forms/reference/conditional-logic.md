# Conditional logic

Conditional logic shows or hides units based on the tech's answers. It is the most useful part of
Form 2.0 and the easiest part to get wrong. Start with a flat form. Add rules only when a real
question depends on an earlier answer.

## How the engine behaves

- A rule has a list of `conditions` and a list of `actions`. When the conditions match
  (`whenMatch: "All"`), every action runs.
- The only confirmed action is `Toggle`: `mode: "On"` shows a unit, `mode: "Off"` hides it.
  Toggling a Section shows or hides everything in it.
- The confirmed conditions are `InitialLoad` (true when the form opens) and `Compare` with
  operator `Equals` (a field's value equals an exact string).
- **The lower rule wins.** When two rules set the same unit, the one further down the `rules` list
  decides. Use this on purpose: put a baseline first and put overrides after it.
- A hidden field does not block submission, even when `isRequired` is `true`.

## Pattern 1: reveal on "Yes" (progressive disclosure)

Hide a block when the form opens, and show it when a toggle is checked.

```json
[
  { "whenMatch": "All",
    "conditions": [ { "type": "InitialLoad" } ],
    "actions": [
      { "type": "Toggle", "unit": "<block section 1>", "mode": "Off", "isMet": false },
      { "type": "Toggle", "unit": "<block section 2>", "mode": "Off", "isMet": false } ] },
  { "whenMatch": "All",
    "conditions": [ { "type": "Compare", "operator": "Equals", "left": "<gate checkbox>", "right": "Yes" } ],
    "actions": [
      { "type": "Toggle", "unit": "<block section 1>", "mode": "On", "isMet": false },
      { "type": "Toggle", "unit": "<block section 2>", "mode": "On", "isMet": false } ] }
]
```

The gate is a Checkbox with `"values": ["Yes"]`. The InitialLoad rule comes first, so the
Compare rule below it wins once the box is checked. Generator archetype: `gated_block`.

Put the revealed sections **next to** the gate's section at the root. Do not nest them inside it.

## Pattern 2: required, with an escape (release a requirement)

Form 2.0 has no "make not required" action. To let a tech skip a required field for a good
reason, hide it: a hidden field does not block submission.

```json
{ "whenMatch": "All",
  "conditions": [ { "type": "Compare", "operator": "Equals", "left": "<NO ACCESS checkbox>", "right": "Yes" } ],
  "actions": [
    { "type": "Toggle", "unit": "<required photo>", "mode": "Off", "isMet": false },
    { "type": "Toggle", "unit": "<optional photo>", "mode": "Off", "isMet": false },
    { "type": "Toggle", "unit": "<dropdown 1>", "mode": "Off", "isMet": false },
    { "type": "Toggle", "unit": "<dropdown 2>", "mode": "Off", "isMet": false } ] }
```

The fields are visible by default because nothing hides them on load. This exact shape (one rule,
four `Off` actions, one per block) has been imported, opened, and read back unchanged. It also
gives you honest data: "not present" is recorded, not confused with "skipped". Generator archetype:
`escape_block`.

In Preview, check the escape box and then uncheck it, and confirm the fields come back. If they
stay hidden, add an `InitialLoad` rule with `mode: "On"` for the same units **above** the escape
rule.

## Rules that prevent real failures

### Merge actions that share a condition

If several units change on the same condition and mode, put all their actions in **one** rule.
Separate rules with the same condition caused runaway re-evaluation at scale: cascade-loop
warnings on load and gated fields showing when they should be hidden. Merging fixed it. A rule with four actions is
confirmed to import, open, and run. Larger merged rules are built the same way but are not
separately confirmed; walk them in Preview.

Never merge an `On` with an `Off` into one rule. Keep one mode per rule.

### Never let a rule toggle its own source

If field X hides X, or X hides Y while Y hides X, the form can freeze. The source field of a
`Compare` must never be one of the units that rule toggles.

### Do not let two rules fight over a Section and its children

Hide or show a Section as a whole, or hide its fields individually, but avoid two rules fighting
over a Section and its children at the same time.

### Keep answer strings stable

`right` must equal the option string exactly, including case and spaces. `"Yes "` is not `"Yes"`.
Renaming an option after publishing silently breaks every rule that compares against it.

### Duplicable sections get new ids

When a tech duplicates a section, the copy gets new unit ids that no rule points to. For repeated
rows that need rules, build fixed rows (Row 1, Row 2, Row 3) instead of relying on duplication.

## Operators beyond Equals

The ServiceTitan form builder UI offers more operators (not equal, greater than, less than, is
filled, is empty). Their JSON has not been confirmed from a real export. If you need one:

- Build it in the ServiceTitan UI, export the form, and copy the exact JSON it produces, or
- Label it unverified in your output and tell the user to test every path in Preview.

Two traps apply to those operators whatever their JSON looks like:

- **Blank values.** An empty field is "not equal" to every value. A "not equal" rule fires on a
  blank field before the tech has answered. Pair it with an "is filled" condition.
- **Numbers in Text fields.** Readings stored in Text fields may not compare as numbers. Do not
  build numeric thresholds on them without testing.

## Audit checklist

Run `python3 generator/generate.py --check form.json`, or check by hand:

1. `hasConditionalLogic` is `true` exactly when `rules` is non-empty.
2. Every action `unit` and every condition `left` is an id that exists in the form.
3. Every `left` points at a Field, not a Section or StaticElement.
4. Baseline `InitialLoad` rules come before the `Compare` rules that override them.
5. No two rules share the same condition and mode.
6. No rule mixes `On` and `Off`.
7. No rule toggles its own source field.
8. Every `right` string matches an option in the source field's `values` exactly.
9. In Preview, every path was walked: each gate on and off, each escape on and off.
