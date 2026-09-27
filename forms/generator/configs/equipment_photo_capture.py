"""
Example 2: required photos with an escape checkbox.

Each block has a required data-plate photo, so the tech cannot submit without
it. If the equipment is not there or not reachable, the tech checks the
escape box. That hides the block, and hidden fields do not block submission.
You also get a clean record of "not present" versus "skipped".

This shape (one Compare-Equals-Off rule per block, four Toggle actions each)
has been imported, opened, and read back unchanged.

    python3 generate.py configs/equipment_photo_capture.py
"""

from archetypes import (
    dropdown_field,
    escape_block,
    form_trigger,
    job_context,
    picture_field,
    tech_acknowledgment,
)

PLATE_HINT = "Photograph the data plate directly, not a phone screen. Model and serial must be readable."

panel = escape_block(
    "Electrical Panel",
    [
        picture_field("PANEL LABEL / RATING PLATE - CLOSE-UP", required=True, description=PLATE_HINT),
        picture_field("PANEL - FULL VIEW, DOOR OPEN"),
        dropdown_field("PANEL AMPERAGE", ["60", "100", "125", "150", "200", "400", "Other", "Unknown"]),
        dropdown_field("AVAILABLE BREAKER SPACE", ["Yes - 2 or more slots", "Yes - 1 slot", "No - full", "Unknown"]),
    ],
    "NO PANEL ACCESS / NOT PRESENT",
)

water_heater = escape_block(
    "Water Heater",
    [
        picture_field("WATER HEATER DATA PLATE - CLOSE-UP", required=True, description=PLATE_HINT),
        picture_field("WATER HEATER - FULL UNIT"),
        dropdown_field("WATER HEATER TYPE", ["Tank", "Tankless", "Hybrid", "Unknown"]),
        dropdown_field("WATER HEATER FUEL", ["Electric", "Natural Gas", "Propane", "Unknown"]),
    ],
    "NO WATER HEATER ON SITE / NO ACCESS",
)

form = {
    "name": "Equipment Photo Capture",
    "owner_types": ["Job"],
    "print_options": ["ShowBusinessUnitLogoOnPrintView"],
    "sections": [
        job_context(),
        panel,
        water_heater,
        tech_acknowledgment(
            prompt="I confirm the photos above are of this property's equipment",
            refusal_reasons=["Customer refused access", "Equipment not accessible", "Unsafe conditions"],
            print_view_disclaimer="Equipment details captured from manufacturer data plates for the service record.",
        ),
    ],
    # Shown here so you can see the shape. For a first import, set this to []
    # and add the trigger in the ServiceTitan UI after you have walked every path.
    "form_triggers": [
        form_trigger(job_event="OnCompletionAfterInvoice", required=False),
    ],
}

output_path = "../../examples/equipment-photo-capture.json"
