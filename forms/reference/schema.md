# Form 2.0 JSON reference

Every shape on this page was taken from real ServiceTitan Form 2.0 exports and, where noted,
confirmed by importing a generated form and opening it. Nothing here is inferred from prose
documentation. If you need a key that is not on this page, treat it as unverified.

## Document envelope

An export-format form is one JSON object with four top-level keys:

```json
{
  "FormData": { ... },
  "FormTriggers": [],
  "IsForm20": true,
  "IsLocked": false
}
```

| Key | Type | Notes |
|---|---|---|
| `FormData` | object | The form itself. See below. |
| `FormTriggers` | array | When ServiceTitan opens the form. Use `[]` on first import. See `triggers.md`. |
| `IsForm20` | `true` | Required. Marks the native Form 2.0 format. |
| `IsLocked` | `false` | |

## FormData

```json
{
  "id": 9001,
  "name": "HVAC Service - Cooling Inspection",
  "active": true,
  "locked": false,
  "hide": false,
  "ownerTypes": ["Job"],
  "applyTagsTargets": [],
  "showOnMobile": true,
  "allowEmptyToPresent": false,
  "canDelete": false,
  "sendOnEvents": ["JobCompletion"],
  "dwyerBigBoardReport": false,
  "createdOn": "2026-01-01T00:00:00.000Z",
  "modifiedOn": "2026-01-01T00:00:00.000Z",
  "definition": {
    "id": 9002,
    "version": 1,
    "published": true,
    "definition": {
      "rootSection": { "unitType": "Section", "canBeDuplicated": false, "name": "Root", "id": "<uuid>", "units": [] },
      "rules": [],
      "hasConditionalLogic": false
    },
    "printOptions": ["ShowBusinessUnitLogoOnPrintView"]
  },
  "BusinessUnits": null,
  "ApplyTagTypes": null
}
```

| Key | Required value | Why |
|---|---|---|
| `id`, `definition.id` | non-zero integers | ServiceTitan replaces them. `9001`/`9002` are known to work. |
| `createdOn`, `modifiedOn` | non-empty ISO strings | Missing values make the imported form open empty. |
| `definition.published` | `true` | A draft import has no published snapshot, so the editor cannot open it. |
| `ownerTypes` | usually `["Job"]` | What the form attaches to. Other values seen: `Customer`, `Location`, `Call`, `Equipment`. |
| `sendOnEvents` | `[]` or `["JobCompletion"]` | Post-submit routing (email/print). Leave empty if nothing consumes it. |
| `printOptions` | list | Seen: `ShowBusinessUnitLogoOnPrintView`, `SplitViewOnTwoColumns`. |
| `BusinessUnits` | `null` or list of names | `null` means all business units. |
| `hasConditionalLogic` | `true` only when `rules` is non-empty | It turns the rules engine on or off. |

## Units

Everything inside `rootSection.units` is a **unit**. There are three unit types.

| `unitType` | What it is | Holds data |
|---|---|---|
| `Section` | A group of units | no |
| `Field` | An input (`fieldType` says which) | yes |
| `StaticElement` | Display-only HTML | no |

Layout rules:

- `rootSection.units` contains **only Sections**.
- A Section contains Fields and StaticElements, **never another Section**.
- Every Section except the root sets `canBeDuplicated: true`.
- Every unit has a unique lowercase hex UUID `id`. Rules point at units by this id.

### Section

```json
{
  "unitType": "Section",
  "canBeDuplicated": true,
  "name": "Electrical",
  "id": "<uuid>",
  "units": [ ... ]
}
```

### StaticElement

```json
{
  "unitType": "StaticElement",
  "htmlContent": "<h3>Electrical</h3>",
  "header": false,
  "isPrintViewOnly": false,
  "id": "<uuid>"
}
```

- Use `header: false` always. Make a heading with `<h3>` inside `htmlContent`.
- `isPrintViewOnly: true` hides it in the mobile app and shows it on the printed copy. Good for
  legal text and disclosures.
- Keep HTML simple: `<h3>`, `<p>`, `<strong>`, `<em>`, `<br>`. Scripts and external CSS are
  stripped. Escape `&` as `&amp;`.
- No `name`, `description`, or `isRequired`. It holds no data, so rules cannot read it.

### Field skeleton

Every field has these keys, in any order:

```json
{
  "fieldType": "Text",
  "unitType": "Field",
  "isRequired": false,
  "name": "OUTSIDE TEMPERATURE",
  "description": "",
  "id": "<uuid>"
}
```

- `name` is the label the tech reads.
- `description` is help text under the label. Use `""` when empty.
- `isRequired: true` blocks submission until the field has a value. A **hidden** field never
  blocks submission.

### Field types

| `fieldType` | Extra keys | Stored value |
|---|---|---|
| `Text` | optional `smartFieldTag` | string |
| `Date` | optional `smartFieldTag` | date |
| `Dropdown` | `values` | one of `values` |
| `Checkbox` | `values`, `horizontalLayout` | the list of ticked `values` (empty list when none) |
| `Picture` | none | photo attachments |
| `Signature` | `refusalReasons` | a signature image, or the refusal reason picked |
| `Stoplight` | `defaultValue` | `"Green"`, `"Yellow"`, or `"Red"` |

#### Text

```json
{ "fieldType": "Text", "unitType": "Field", "isRequired": true,
  "name": "MEASURE & RECORD LINE VOLTAGE", "description": "", "id": "<uuid>" }
```

Use Text for readings and numbers too. `fieldType: "Number"` appears in some older exports, but no
generated form that uses it is known to open, and it correlates with open failures.

#### Dropdown

```json
{ "fieldType": "Dropdown", "values": ["Split AC", "Heat Pump", "Packaged Unit"],
  "unitType": "Field", "isRequired": true, "name": "SYSTEM TYPE", "description": "", "id": "<uuid>" }
```

`values` is a flat list of strings. There is no separate label and value: the string shown is the
string stored. Spelling, case, and spaces all matter. Need an "Other"? Add `"Other"` to `values`
and put a Text field after it.

#### Checkbox

```json
{ "fieldType": "Checkbox",
  "values": ["Passed Inspection", "Failed Inspection - Attention Required", "N/A"],
  "horizontalLayout": false,
  "unitType": "Field", "isRequired": true, "name": "INSPECT ELECTRICAL CONNECTIONS",
  "description": "", "id": "<uuid>" }
```

- A **toggle** is a Checkbox with one value: `"values": ["Yes"]`. There is no Toggle field type.
- Pass/fail items are Checkboxes with the answer set as `values`.
- Keep `horizontalLayout: false`.

#### Date

```json
{ "fieldType": "Date", "smartFieldTag": "TodayDate", "unitType": "Field", "isRequired": false,
  "name": "DATE", "description": "", "id": "<uuid>" }
```

#### Picture

```json
{ "fieldType": "Picture", "unitType": "Field", "isRequired": true,
  "name": "WATER HEATER DATA PLATE - CLOSE-UP",
  "description": "Photograph the data plate directly. Model and serial must be readable.",
  "id": "<uuid>" }
```

Spelled `Picture`, never `Photo`. No photo-count keys have been seen in real exports; do not add
them. Put photo instructions in `description`.

#### Signature

```json
{ "fieldType": "Signature",
  "refusalReasons": ["No one available to sign.",
                     "I am not satisfied with the service and would like the office to contact me."],
  "unitType": "Field", "isRequired": true,
  "name": "Your technician has completed the tasks above. Please sign to confirm.",
  "description": "", "id": "<uuid>" }
```

- `name` is the statement the signer reads. Long sentences are normal.
- `refusalReasons` lists the reasons a signer can pick instead of signing. The list may be empty
  but the key must exist.
- There is no `signerType` key.

#### Stoplight

```json
{ "fieldType": "Stoplight", "defaultValue": "Green", "unitType": "Field", "isRequired": false,
  "name": "OVERALL SYSTEM CONDITION", "description": "", "id": "<uuid>" }
```

`defaultValue` is required. Without it, the form fails to open with a server error.

## Smart fields

A smart field fills itself in when the form opens. Set `smartFieldTag` on a field. These four tags
are confirmed:

| `smartFieldTag` | Field type | Fills in |
|---|---|---|
| `CustomerName` | `Text` | the customer's name |
| `LocationAddress` | `Text` | the service address |
| `TechnicianName` | `Text` | the assigned technician |
| `TodayDate` | `Date` | today's date |

- They resolve for `Job`-owned forms. Other owner types are unconfirmed; test in Preview.
- Set `isRequired: false` on smart fields. They fill themselves in.
- Tags are case-sensitive: `CustomerName`, not `customerName`.
- They work only as a field property. Tokens in HTML such as `{{customer.name}}` do not resolve.

## Rules

Conditional logic lives in `FormData.definition.definition.rules`. See `conditional-logic.md` for
how to design it. The confirmed shape:

```json
{
  "whenMatch": "All",
  "actions": [
    { "type": "Toggle", "unit": "<uuid of the unit to show or hide>", "mode": "On", "isMet": false }
  ],
  "conditions": [
    { "type": "Compare", "operator": "Equals", "left": "<uuid of the source field>", "right": "Yes" }
  ]
}
```

| Part | Confirmed values |
|---|---|
| `whenMatch` | `"All"` (`"Any"` is accepted by the schema, unconfirmed in exports) |
| action `type` | `"Toggle"` with `mode` `"On"` (show) or `"Off"` (hide), `isMet: false` |
| condition `type` | `"InitialLoad"` (true when the form opens) or `"Compare"` |
| `Compare` `operator` | `"Equals"` |
| `Compare` `right` | the exact option string, for a toggle `"Yes"` |

The key is `conditions` (a list). A singular `condition` object does not work.

## A complete minimal form

```json
{
  "FormData": {
    "id": 9001, "name": "Minimal Example", "active": true, "locked": false, "hide": false,
    "ownerTypes": ["Job"], "applyTagsTargets": [], "showOnMobile": true,
    "allowEmptyToPresent": false, "canDelete": false, "sendOnEvents": [],
    "dwyerBigBoardReport": false,
    "createdOn": "2026-01-01T00:00:00.000Z", "modifiedOn": "2026-01-01T00:00:00.000Z",
    "definition": {
      "id": 9002, "version": 1, "published": true,
      "definition": {
        "rootSection": {
          "unitType": "Section", "canBeDuplicated": false, "name": "Root",
          "id": "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
          "units": [
            {
              "unitType": "Section", "canBeDuplicated": true, "name": "Job Information",
              "id": "1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d",
              "units": [
                { "unitType": "StaticElement", "htmlContent": "<h3>Job Information</h3>",
                  "header": false, "isPrintViewOnly": false,
                  "id": "2b3c4d5e-6f7a-4b1c-8d2e-3f4a5b6c7d8e" },
                { "fieldType": "Text", "smartFieldTag": "CustomerName", "unitType": "Field",
                  "isRequired": false, "name": "CUSTOMER NAME", "description": "",
                  "id": "3c4d5e6f-7a8b-4c2d-9e3f-4a5b6c7d8e9f" }
              ]
            }
          ]
        },
        "rules": [],
        "hasConditionalLogic": false
      },
      "printOptions": []
    },
    "BusinessUnits": null, "ApplyTagTypes": null
  },
  "FormTriggers": [],
  "IsForm20": true,
  "IsLocked": false
}
```

Larger, complete examples are in `../examples/`.
