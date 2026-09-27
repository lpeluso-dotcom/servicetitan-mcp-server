"""
Builders for ServiceTitan Form 2.0 units.

Every builder returns plain dicts in the exact shape found in real Form 2.0
exports. Nothing here is inferred from prose documentation. See
../reference/schema.md for the evidence behind each shape.

Two kinds of builder:

  Primitives   return one unit dict (a Field, a StaticElement, or a Section).
  Archetypes   return (sections, rule_specs). `sections` is a list of Section
               units for the form root. `rule_specs` is a list of small dicts
               that rules.py turns into the Form 2.0 `rules[]` array.

A rule spec looks like one of these:

  {"kind": "initial_load_off", "unit_ids": [...]}           hide on form load
  {"kind": "initial_load_on",  "unit_ids": [...]}           show on form load
  {"kind": "compare_equals_on",  "source_id": id, "match_value": "Yes", "unit_ids": [...]}
  {"kind": "compare_equals_off", "source_id": id, "match_value": "Yes", "unit_ids": [...]}

Import-safety rules the builders follow (reference/import-and-verify.md):

  - Sections sit directly under the form root. Never put a Section inside a
    Section: it imports, then the form editor fails to open it.
  - Every Section sets canBeDuplicated: true.
  - Headings are StaticElement with header: false and <h3> HTML.
  - Numbers are captured with Text fields. There is no Number builder.
  - Unit ids are lowercase hex UUIDs.
"""

import random
import uuid
from typing import Iterable

# Unit ids come from this generator. Call set_seed() for reproducible output.
_rng = random.Random()


def set_seed(seed: int | None) -> None:
    """Make unit ids reproducible. Pass None to go back to random ids."""
    _rng.seed(seed)


def new_id() -> str:
    """A lowercase hex UUID (version 4 layout)."""
    return str(uuid.UUID(int=_rng.getrandbits(128), version=4))


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

def static_element(html_content: str, *, print_view_only: bool = False) -> dict:
    """Display-only HTML block. Always header: false (see heading())."""
    return {
        "unitType": "StaticElement",
        "htmlContent": html_content,
        "header": False,
        "isPrintViewOnly": print_view_only,
        "id": new_id(),
    }


def heading(text: str) -> dict:
    """A section heading: StaticElement, header: false, wrapped in <h3>."""
    return static_element(f"<h3>{text}</h3>")


def _field(field_type: str, name: str, *, required: bool, description: str) -> dict:
    return {
        "fieldType": field_type,
        "unitType": "Field",
        "isRequired": required,
        "name": name,
        "description": description,
        "id": new_id(),
    }


def text_field(name: str, *, smart_field_tag: str | None = None, required: bool = False,
               description: str = "") -> dict:
    """Free text. Also the import-safe way to capture numbers and readings."""
    unit = _field("Text", name, required=required, description=description)
    if smart_field_tag:
        unit["smartFieldTag"] = smart_field_tag
    return unit


def date_field(name: str, *, smart_field_tag: str | None = None, required: bool = False,
               description: str = "") -> dict:
    """Date picker. Use smart_field_tag="TodayDate" to prefill today."""
    unit = _field("Date", name, required=required, description=description)
    if smart_field_tag:
        unit["smartFieldTag"] = smart_field_tag
    return unit


def dropdown_field(name: str, values: list[str], *, required: bool = False,
                   description: str = "") -> dict:
    """Single select. `values` is a flat list of strings; each string is its own stored value."""
    unit = _field("Dropdown", name, required=required, description=description)
    unit["values"] = list(values)
    return unit


def checkbox_field(name: str, values: list[str], *, required: bool = False,
                   description: str = "") -> dict:
    """One or more options the tech can tick. horizontalLayout is always false."""
    unit = _field("Checkbox", name, required=required, description=description)
    unit["values"] = list(values)
    unit["horizontalLayout"] = False
    return unit


def binary_toggle(name: str, *, required: bool = False, description: str = "") -> dict:
    """A yes/no toggle: a Checkbox with the single value "Yes". Form 2.0 has no Toggle field."""
    return checkbox_field(name, ["Yes"], required=required, description=description)


def picture_field(name: str, *, required: bool = False, description: str = "") -> dict:
    """Photo upload. The fieldType is "Picture", never "Photo"."""
    return _field("Picture", name, required=required, description=description)


def stoplight_field(name: str, *, required: bool = False, description: str = "",
                    default_value: str = "Green") -> dict:
    """Green / Yellow / Red status. defaultValue is required: without it the form fails to open."""
    if default_value not in ("Green", "Yellow", "Red"):
        raise ValueError(f"stoplight default_value must be Green, Yellow or Red, got {default_value!r}")
    unit = _field("Stoplight", name, required=required, description=description)
    unit["defaultValue"] = default_value
    return unit


def signature_field(prompt: str, refusal_reasons: list[str], *, required: bool = True,
                    description: str = "") -> dict:
    """Signature pad. `prompt` is the text the signer reads. `refusal_reasons` lets them decline."""
    unit = _field("Signature", prompt, required=required, description=description)
    unit["refusalReasons"] = list(refusal_reasons)
    return unit


def section(name: str, units: list[dict]) -> dict:
    """A Section of fields. Must not contain another Section."""
    for u in units:
        if u.get("unitType") == "Section":
            raise ValueError(
                f"section {name!r} contains section {u.get('name')!r}; "
                "nested sections import but the form editor cannot open them"
            )
    return {
        "unitType": "Section",
        "canBeDuplicated": True,
        "units": list(units),
        "name": name,
        "id": new_id(),
    }


# ---------------------------------------------------------------------------
# Archetypes
# ---------------------------------------------------------------------------

# The four smart-field tags confirmed in real exports, with the field type each one needs.
SMART_FIELDS = {
    "CustomerName": ("Text", "CUSTOMER NAME"),
    "LocationAddress": ("Text", "LOCATION"),
    "TechnicianName": ("Text", "TECHNICIAN"),
    "TodayDate": ("Date", "DATE"),
}

# Answer sets seen on real inspection forms.
PASS_FAIL = ["Passed Inspection", "Failed Inspection - Attention Required"]
PASS_FAIL_NA = ["Passed Inspection", "Failed Inspection - Attention Required", "N/A"]
YES_NO_NA = ["Yes", "No", "N/A"]


def job_context(*, title: str = "Job Information",
                smart_fields: Iterable[str] = ("CustomerName", "LocationAddress",
                                               "TechnicianName", "TodayDate"),
                extra_fields: list[dict] | None = None) -> tuple[list[dict], list[dict]]:
    """Top-of-form block that fills itself in from the job. No rules."""
    units: list[dict] = [heading(title)]
    for tag in smart_fields:
        if tag not in SMART_FIELDS:
            raise ValueError(f"unknown smartFieldTag {tag!r}; confirmed tags: {sorted(SMART_FIELDS)}")
        kind, label = SMART_FIELDS[tag]
        builder = text_field if kind == "Text" else date_field
        # Smart fields fill themselves in, so they never gate submission.
        units.append(builder(label, smart_field_tag=tag, required=False))
    units.extend(extra_fields or [])
    return [section(title, units)], []


def inspection_checklist(title: str, items: list[tuple[str, list[str]] | str], *,
                         intro: str | None = None, required: bool = True,
                         answers: list[str] = PASS_FAIL_NA) -> tuple[list[dict], list[dict]]:
    """
    A flat checklist section. Each item is either a name (uses `answers`) or a
    (name, answer_values) tuple. A name ending in " [text]" becomes a Text field
    for a reading or measurement instead of a Checkbox.
    """
    units: list[dict] = [heading(title)]
    if intro:
        units.append(static_element(f"<p>{intro}</p>"))
    for item in items:
        if isinstance(item, tuple):
            name, values = item
            units.append(checkbox_field(name, values, required=required))
        elif item.endswith(" [text]"):
            units.append(text_field(item[: -len(" [text]")], required=required))
        else:
            units.append(checkbox_field(item, answers, required=required))
    return [section(title, units)], []


def gated_block(title: str, gate_label: str, gated_sections: list[dict], *,
                gate_hint: str = "") -> tuple[list[dict], list[dict]]:
    """
    Progressive disclosure. A header section holds a "Yes" gate checkbox. The
    `gated_sections` sit next to it at the form root (siblings, never nested)
    and stay hidden until the gate is checked.

    Emits one InitialLoad-off rule and one Compare-Equals-On rule.
    """
    gate = binary_toggle(gate_label, description=gate_hint)
    ids = [s["id"] for s in gated_sections]
    specs = [
        {"kind": "initial_load_off", "unit_ids": ids},
        {"kind": "compare_equals_on", "source_id": gate["id"], "match_value": "Yes", "unit_ids": ids},
    ]
    header = section(title, [heading(title), gate])
    return [header, *gated_sections], specs


def escape_block(title: str, units: list[dict], escape_label: str, *,
                 escape_hint: str = "Check only if this is not present or not reachable. "
                                    "This releases the required fields and records why."
                 ) -> tuple[list[dict], list[dict]]:
    """
    Required fields with a way out. `units` are visible by default (mark the
    ones that matter required=True). Checking the escape checkbox hides them,
    and a hidden field does not block submission. Form 2.0 has no
    "make not required" action, so hiding is the only release.

    Emits one Compare-Equals-Off rule carrying one action per unit.
    """
    escape = checkbox_field(escape_label, ["Yes"], description=escape_hint)
    ids = [u["id"] for u in units]
    specs = [{"kind": "compare_equals_off", "source_id": escape["id"], "match_value": "Yes", "unit_ids": ids}]
    return [section(title, [heading(title), *units, escape])], specs


def tech_acknowledgment(*, prompt: str, refusal_reasons: list[str], title: str = "Acknowledgment",
                        required: bool = True,
                        print_view_disclaimer: str | None = None) -> tuple[list[dict], list[dict]]:
    """Closing signature section. Put it last."""
    units: list[dict] = [heading(title)]
    if print_view_disclaimer:
        units.append(static_element(f"<p>{print_view_disclaimer}</p>", print_view_only=True))
    units.append(signature_field(prompt, refusal_reasons, required=required))
    return [section(title, units)], []


# ---------------------------------------------------------------------------
# Triggers
# ---------------------------------------------------------------------------

JOB_EVENTS = ("AfterArrival", "OnCompletionAfterInvoice")


def form_trigger(*, job_event: str, active: bool = True, required: bool = False,
                 owner_types: list[str] | None = None,
                 business_unit_names: list[str] | None = None,
                 job_type_names: list[str] | None = None,
                 tags: list[str] | None = None,
                 on_all_appointments: bool = False) -> dict:
    """
    One FormTriggers[] entry: when ServiceTitan opens the form for the tech.
    Name filters must match your tenant's names exactly, including case.
    """
    if job_event not in JOB_EVENTS:
        raise ValueError(f"job_event must be one of {JOB_EVENTS} (the confirmed values), got {job_event!r}")
    return {
        "Active": active,
        "Required": required,
        "MustCompleteFormWhenTriggered": False,
        "RequireEachTechToCompleteForm": False,
        "OwnerTypes": list(owner_types) if owner_types else ["Job"],
        "JobEvent": job_event,
        "CustomerTypes": None,
        "BusinessUnitNames": list(business_unit_names) if business_unit_names else None,
        "JobTypeNames": list(job_type_names) if job_type_names else None,
        "EquipmentTypeNames": None,
        "ServiceNames": None,
        "OnAllAppointments": on_all_appointments,
        "Tags": list(tags) if tags else None,
    }
