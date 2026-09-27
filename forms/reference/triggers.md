# Triggers

A form can be wired to ServiceTitan in two separate places. They do different jobs.

| Where | What it does |
|---|---|
| `FormData.sendOnEvents` | What happens **after** the form is submitted, such as email or print routing. Confirmed value: `"JobCompletion"`. |
| `FormTriggers[]` (top level, next to `FormData`) | **When** ServiceTitan opens the form for the tech. |

## Import with no trigger

A form with `FormTriggers: []` is inert: nothing attaches it to a job, so no tech sees it. That is
the safe way to import. Walk every path in Preview, then add the trigger in the ServiceTitan UI.
This matters most when the form has required fields: a live trigger on a broken form can block job
completion for every tech at once.

## FormTriggers entry

```json
{
  "Active": true,
  "Required": false,
  "MustCompleteFormWhenTriggered": false,
  "RequireEachTechToCompleteForm": false,
  "OwnerTypes": ["Job"],
  "JobEvent": "OnCompletionAfterInvoice",
  "CustomerTypes": null,
  "BusinessUnitNames": null,
  "JobTypeNames": ["Water Heater Install"],
  "EquipmentTypeNames": null,
  "ServiceNames": null,
  "OnAllAppointments": false,
  "Tags": null
}
```

### JobEvent

Confirmed values:

| `JobEvent` | Fires when |
|---|---|
| `AfterArrival` | The tech taps Arrive on the appointment. Good for safety checks and pre-work photos. |
| `OnCompletionAfterInvoice` | The job is completed and the invoice exists. Good for closeout, materials, and signatures. |

Other values may exist. They are not confirmed from an export here. The strings are case-sensitive.

### Filters

Every non-null filter narrows the trigger. `null` means "no filter".

| Filter | Fires only when |
|---|---|
| `JobTypeNames` | the job's type is in the list |
| `BusinessUnitNames` | the job's business unit is in the list |
| `Tags` | the job carries one of the tags |
| `OnAllAppointments: true` | on every appointment of the job, not just the first |
| `EquipmentTypeNames`, `ServiceNames`, `CustomerTypes` | seen as `null` in every export reviewed |

Names must match the account's names **exactly**: case, spaces, and any prefix characters. A typo
does not raise an error. The trigger just never fires. Ask the user for the exact names, or set the
filters in the UI.

### Flags

| Flag | Meaning |
|---|---|
| `Active` | `false` makes the trigger inert. Delete inactive triggers rather than keeping them around. |
| `Required` | `true` blocks the tech from finishing until the form is filled. Use it for safety- and revenue-critical forms only. |
| `MustCompleteFormWhenTriggered`, `RequireEachTechToCompleteForm` | `false` in every export reviewed. Semantics unconfirmed. Leave `false`. |

## Picking a trigger

| Form purpose | JobEvent | Filter by |
|---|---|---|
| Safety check or pre-work photos | `AfterArrival` | job type or tag |
| Closeout, materials, signature | `OnCompletionAfterInvoice` | job type or business unit |
| Only on some jobs | `AfterArrival` | `Tags` |
| Multi-day jobs, every visit | either | `OnAllAppointments: true` |

## Gotchas

- **Two matching triggers mean two copies.** If an arrival trigger and a completion trigger both
  match a job, the tech fills the form twice. Keep one active trigger per form unless you want that.
- **Filtering on tags that change.** If the tag is added after arrival, an `AfterArrival` trigger
  has already missed it.
