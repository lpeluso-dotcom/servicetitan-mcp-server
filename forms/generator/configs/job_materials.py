"""
Example 3: progressive disclosure with gate checkboxes.

After the job, the tech reports materials that were invoiced but not used,
parts pulled from truck stock, and any supply-house run. Each block stays
hidden until its "Yes" gate is checked. The gated row sections sit next to
the gate section at the form root. They are never nested inside it.

    python3 generate.py configs/job_materials.py
"""

from archetypes import (
    checkbox_field,
    gated_block,
    heading,
    job_context,
    picture_field,
    section,
    tech_acknowledgment,
    text_field,
)

ROWS = 3


def rows(prefix: str, extra=None) -> list[dict]:
    """Fixed item rows. Fixed rows, not a duplicated section: a duplicate gets new ids the rules do not know."""
    out = []
    for i in range(1, ROWS + 1):
        units = [text_field(f"{prefix} {i} - MATERIAL / PART"), text_field(f"{prefix} {i} - QTY")]
        if extra:
            units.append(extra(i))
        out.append(section(f"{prefix} {i}", units))
    return out


not_used = gated_block(
    "Invoiced Materials Not Used",
    "ANY INVOICED MATERIALS NOT USED?",
    rows("NOT USED", extra=lambda i: checkbox_field(
        f"NOT USED {i} - WHERE DID IT GO?", ["Returned to truck", "Returned to supplier", "Other"])),
    gate_hint="Check if anything billed on the invoice was not installed.",
)

truck_stock = gated_block(
    "Truck Stock Used",
    "USED MATERIALS FROM TRUCK STOCK?",
    rows("TRUCK", extra=lambda i: checkbox_field(f"TRUCK {i} - ON THE INVOICE?", ["Yes", "No"])),
    gate_hint="Check if you pulled parts off your truck for this job.",
)

supply_run = gated_block(
    "Supply House Run",
    "WENT TO A SUPPLY HOUSE FOR THIS JOB?",
    [
        section("Supply House", [text_field("SUPPLY HOUSE NAME")]),
        *rows("BOUGHT"),
        section("Receipt", [
            picture_field("RECEIPT PHOTO", description="The whole receipt. Total and items must be readable."),
            text_field("RECEIPT TOTAL $"),
        ]),
    ],
    gate_hint="Check if you bought materials for this job.",
)

form = {
    "name": "Plumbing Service - Job Materials",
    "owner_types": ["Job"],
    "print_options": ["ShowBusinessUnitLogoOnPrintView"],
    "sections": [
        job_context(),
        not_used,
        truck_stock,
        supply_run,
        ([section("Comments", [heading("Comments"), text_field("COMMENTS")])], []),
        tech_acknowledgment(
            prompt="I confirm the materials reported above are accurate for this job",
            refusal_reasons=["Not the technician who did the work", "Other - see comments"],
        ),
    ],
    "form_triggers": [],
}

output_path = "../../examples/job-materials.json"
