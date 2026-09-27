"""
ServiceTitan Form 2.0 generator and checker. Python 3.10+, standard library only.

Build a form from a config module:
    python3 generate.py configs/inspection_checklist.py
    python3 generate.py configs/inspection_checklist.py --output my-form.json --seed 7

Check any form JSON (generated, hand-written, or written by an LLM):
    python3 generate.py --check my-form.json

A config module defines a top-level `form` dict:

    form = {
        "name": "HVAC Service - Cooling Inspection",   # required
        "sections": [job_context(), ...],               # required: archetype results
        "owner_types": ["Job"],
        "send_on_events": [],                           # e.g. ["JobCompletion"]
        "apply_tags_targets": [],
        "business_units": None,                         # None = all business units
        "print_options": ["ShowBusinessUnitLogoOnPrintView"],
        "form_triggers": [],                            # import with none; add in the UI last
    }
    output_path = "out/my-form.json"                    # optional

Each entry in "sections" is what an archetype returns: (list_of_sections, rule_specs).
"""

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import archetypes  # noqa: E402
from audit import audit_form  # noqa: E402
from rules import build_rules  # noqa: E402

# ServiceTitan assigns real ids on import. Any non-zero integers work; these
# match forms that are known to import and open.
FORM_ID = 9001
DEFINITION_ID = 9002


def build_form(config: dict, *, timestamp: str | None = None) -> dict:
    """Turn a config dict into an export-format Form 2.0 document, then audit it."""
    root_units: list[dict] = []
    specs: list[dict] = []
    for entry in config["sections"]:
        sections, entry_specs = entry
        root_units.extend(sections if isinstance(sections, list) else [sections])
        specs.extend(entry_specs)

    rules = build_rules(specs)
    stamp = timestamp or config.get("timestamp") or datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z")

    form = {
        "FormData": {
            "id": FORM_ID,
            "name": config["name"],
            "active": True,
            "locked": False,
            "hide": False,
            "ownerTypes": list(config.get("owner_types", ["Job"])),
            "applyTagsTargets": list(config.get("apply_tags_targets", [])),
            "showOnMobile": True,
            "allowEmptyToPresent": False,
            "canDelete": False,
            "sendOnEvents": list(config.get("send_on_events", [])),
            "dwyerBigBoardReport": False,
            "createdOn": stamp,
            "modifiedOn": stamp,
            "definition": {
                "id": DEFINITION_ID,
                "version": 1,
                # Must be true. A draft import has no published snapshot, and the
                # editor cannot open the form. Control exposure with triggers.
                "published": True,
                "definition": {
                    "rootSection": {
                        "unitType": "Section",
                        "canBeDuplicated": False,
                        "units": root_units,
                        "name": "Root",
                        "id": archetypes.new_id(),
                    },
                    "rules": rules,
                    "hasConditionalLogic": bool(rules),
                },
                "printOptions": list(config.get("print_options", [])),
            },
            "BusinessUnits": list(config["business_units"]) if config.get("business_units") else None,
            "ApplyTagTypes": None,
        },
        "FormTriggers": list(config.get("form_triggers", [])),
        "IsForm20": True,
        "IsLocked": False,
    }

    errors = [f for f in audit_form(form) if f.level == "error"]
    if errors:
        raise ValueError("generated form failed the audit:\n  " + "\n  ".join(map(str, errors)))
    return form


def load_config(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load config {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def generate(config_path: Path, *, seed: int | None = None, timestamp: str | None = None) -> dict:
    """Load a config module and build its form. A seed makes unit ids reproducible."""
    archetypes.set_seed(seed)
    try:
        module = load_config(config_path)
        if not hasattr(module, "form"):
            raise ValueError(f"{config_path} does not define a top-level `form` dict")
        return build_form(module.form, timestamp=timestamp)
    finally:
        archetypes.set_seed(None)


def summarize(form: dict) -> str:
    counts = {"Section": 0, "Field": 0, "StaticElement": 0}

    def walk(units):
        for u in units:
            counts[u.get("unitType")] = counts.get(u.get("unitType"), 0) + 1
            walk(u.get("units") or [])

    inner = form["FormData"]["definition"]["definition"]
    walk(inner["rootSection"]["units"])
    return (f"{form['FormData']['name']!r}: {counts['Section']} sections, {counts['Field']} fields, "
            f"{counts['StaticElement']} static elements, {len(inner['rules'])} rules, "
            f"{len(form['FormTriggers'])} triggers")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Generate or check ServiceTitan Form 2.0 JSON.")
    p.add_argument("config", nargs="?", help="config module to build (a .py file)")
    p.add_argument("--output", help="where to write the JSON (overrides output_path in the config)")
    p.add_argument("--seed", type=int, help="seed for reproducible unit ids")
    p.add_argument("--timestamp", help="fixed createdOn/modifiedOn value, for reproducible output")
    p.add_argument("--check", metavar="FORM_JSON", help="audit an existing form JSON file and exit")
    args = p.parse_args(argv)

    if args.check:
        form = json.loads(Path(args.check).read_text())
        findings = audit_form(form)
        for f in findings:
            print(f)
        errors = sum(1 for f in findings if f.level == "error")
        warnings = len(findings) - errors
        print(f"{args.check}: {errors} error(s), {warnings} warning(s)")
        return 1 if errors else 0

    if not args.config:
        p.error("give a config module to build, or --check a form JSON file")
    config_path = Path(args.config).resolve()
    form = generate(config_path, seed=args.seed, timestamp=args.timestamp)
    if args.output:
        out = Path(args.output)
    elif getattr(load_config(config_path), "output_path", None):
        # A config's output_path is relative to the config file, not the shell.
        out = config_path.parent / load_config(config_path).output_path
    else:
        print(json.dumps(form, indent=2))
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(form, indent=2) + "\n")
    print(f"wrote {out}")
    print(summarize(form))
    return 0


if __name__ == "__main__":
    sys.exit(main())
