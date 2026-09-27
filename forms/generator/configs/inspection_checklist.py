"""
Example 1: a flat inspection checklist. No conditional logic.

This is the safest shape to start from: job context at the top, checklist
sections in the middle, a signature at the end. Readings are Text fields.

    python3 generate.py configs/inspection_checklist.py
"""

from archetypes import (
    PASS_FAIL_NA,
    dropdown_field,
    inspection_checklist,
    job_context,
    tech_acknowledgment,
    text_field,
)

INTRO = ("Mark each task PASS or FAIL. For a FAIL, note what failed and what action is required. "
         "Record readings where asked.")

form = {
    "name": "HVAC Service - Cooling Inspection",
    "owner_types": ["Job"],
    "send_on_events": ["JobCompletion"],
    "print_options": ["ShowBusinessUnitLogoOnPrintView"],
    "sections": [
        job_context(extra_fields=[
            dropdown_field("SYSTEM TYPE", ["Split AC", "Heat Pump", "Packaged Unit", "Mini Split"], required=True),
            text_field("MODEL / SERIAL #", required=True, description="Model and serial for each unit, or attach a photo."),
            text_field("OUTSIDE TEMPERATURE", required=True),
        ]),
        inspection_checklist("Electrical", [
            "INSPECT ELECTRICAL DISCONNECT",
            "CHECK EQUIPMENT GROUNDING",
            "MEASURE & RECORD LINE VOLTAGE [text]",
            "INSPECT & TEST CONTACTORS & RELAYS",
            "INSPECT & TEST CAPACITORS",
            ("CLEAN & TIGHTEN ELECTRICAL CONNECTIONS", ["No Adjustment Needed", "Cleaned and Tightened", "N/A"]),
        ], intro=INTRO),
        inspection_checklist("Condensate", [
            ("INSPECT & CLEAN CONDENSATE DRAIN", ["Clear - No Action Needed", "Cleaned", "N/A"]),
            "TEST DRAIN PAN SAFETY SWITCH",
            ("TEST CONDENSATE PUMP", ["Passed Inspection", "Failed Inspection - Attention Required",
                                      "No Condensate Pump"]),
        ]),
        inspection_checklist("Refrigeration", [
            "RECORD SUCTION & DISCHARGE PRESSURE [text]",
            "RECORD SUPERHEAT [text]",
            "RECORD SUBCOOLING [text]",
            "RECORD TEMPERATURE DROP ACROSS EVAPORATOR COIL [text]",
            ("INSPECT OUTDOOR COIL", ["Clean - No Attention Required", "Cleaned", "N/A"]),
            "INSPECT REFRIGERANT LINE INSULATION",
        ], answers=PASS_FAIL_NA),
        inspection_checklist("Wrap-Up", [
            ("ALL BREAKERS AND DISCONNECTS BACK ON", ["Yes"]),
            "ADDITIONAL NOTES [text]",
        ], required=False),
        tech_acknowledgment(
            title="Customer Acknowledgment",
            prompt=("Your technician has completed the tasks above. Please sign to confirm the "
                    "maintenance was completed to your satisfaction."),
            refusal_reasons=[
                "No one available to sign.",
                "I am not satisfied with the service and would like the office to contact me.",
            ],
        ),
    ],
    "form_triggers": [],
}

output_path = "../../examples/inspection-checklist.json"
