"""
Checks a Form 2.0 export-format JSON document against every import-safety
rule in ../reference/import-and-verify.md. Works on any form JSON, not just
generator output, so it is also the check to run on hand-written or
LLM-written forms.

    findings = audit_form(form_json)
    errors = [f for f in findings if f.level == "error"]

An "error" breaks the import, stops the form from opening, or makes the rules
engine misbehave. A "warning" is legal but unverified or likely to hurt
reporting.
"""

import re
from dataclasses import dataclass

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

FIELD_TYPES = {"Text", "Dropdown", "Checkbox", "Date", "Picture", "Signature", "Stoplight"}
WRONG_FIELD_TYPES = {
    "Photo": 'use "Picture"',
    "Toggle": 'use a Checkbox with values ["Yes"]',
    "Radio": "use a Dropdown or a Checkbox",
    "Header": 'use unitType "StaticElement" with <h3> HTML',
    "Paragraph": 'use unitType "StaticElement"',
    "Number": 'capture numbers in a "Text" field; Number is not import-safe',
}
SMART_FIELD_TYPES = {"CustomerName": "Text", "LocationAddress": "Text",
                     "TechnicianName": "Text", "TodayDate": "Date"}
JOB_EVENTS = {"AfterArrival", "OnCompletionAfterInvoice"}


@dataclass(frozen=True)
class Finding:
    level: str  # "error" | "warning"
    path: str
    message: str

    def __str__(self) -> str:
        return f"{self.level.upper():7} {self.path}: {self.message}"


def audit_form(form: dict) -> list[Finding]:
    out: list[Finding] = []

    def err(path, msg):
        out.append(Finding("error", path, msg))

    def warn(path, msg):
        out.append(Finding("warning", path, msg))

    # --- Envelope --------------------------------------------------------
    if not isinstance(form, dict):
        return [Finding("error", "$", "top level must be an object")]
    for key in ("FormData", "FormTriggers", "IsForm20"):
        if key not in form:
            err("$", f"missing {key}")
    if form.get("IsForm20") is not True:
        err("$.IsForm20", "must be true")
    fd = form.get("FormData")
    if not isinstance(fd, dict):
        return out
    defn = fd.get("definition") or {}
    inner = defn.get("definition") or {}

    for key in ("id",):
        if not isinstance(fd.get(key), int) or isinstance(fd.get(key), bool):
            err(f"$.FormData.{key}", "must be an integer (ServiceTitan replaces it on import)")
    if not isinstance(defn.get("id"), int) or isinstance(defn.get("id"), bool):
        err("$.FormData.definition.id", "must be an integer (ServiceTitan replaces it on import)")
    elif defn.get("id") == 0 or fd.get("id") == 0:
        warn("$.FormData", "an id of 0 has never been tested; any other integer is known to work")
    for key in ("createdOn", "modifiedOn"):
        if not isinstance(fd.get(key), str) or not fd.get(key):
            err(f"$.FormData.{key}", "must be a non-empty ISO timestamp, or the form opens empty")
    if defn.get("published") is not True:
        err("$.FormData.definition.published",
            "must be true; a draft import has no published snapshot and the editor cannot open it")
    if not fd.get("name"):
        err("$.FormData.name", "must be a non-empty string")
    if not isinstance(fd.get("ownerTypes"), list) or not fd.get("ownerTypes"):
        err("$.FormData.ownerTypes", 'must be a non-empty list, usually ["Job"]')

    root = inner.get("rootSection")
    if not isinstance(root, dict) or root.get("unitType") != "Section":
        err("$.FormData.definition.definition.rootSection", "must be a Section")
        return out

    # --- Units -----------------------------------------------------------
    units_by_id: dict[str, dict] = {}
    seen_ids: set[str] = set()

    def check_id(path, unit):
        uid = unit.get("id")
        if not isinstance(uid, str) or not UUID_RE.match(uid):
            err(path, f"id {uid!r} must be a lowercase hex UUID")
        elif uid in seen_ids:
            err(path, f"duplicate id {uid}")
        else:
            seen_ids.add(uid)
            units_by_id[uid] = unit

    def check_strings(path, label, values):
        for v in values:
            if isinstance(v, str) and v != v.strip():
                warn(path, f"{label} {v!r} has leading or trailing spaces; values are matched exactly")

    def walk(unit, path, depth):
        check_id(path, unit)
        ut = unit.get("unitType")
        if ut == "Section":
            if depth >= 2:
                err(path, "a Section inside a Section imports, but the form editor cannot open it")
            if depth >= 1 and unit.get("canBeDuplicated") is not True:
                err(path, "Sections must set canBeDuplicated: true")
            if depth >= 1 and not unit.get("name"):
                warn(path, "Section has no name")
            for i, child in enumerate(unit.get("units") or []):
                walk(child, f"{path}.units[{i}]", depth + 1)
        elif ut == "Field":
            if depth == 1:
                err(path, "fields must sit inside a Section, not directly under the root")
            ft = unit.get("fieldType")
            if ft in WRONG_FIELD_TYPES:
                err(path, f'fieldType "{ft}" is wrong: {WRONG_FIELD_TYPES[ft]}')
            elif ft not in FIELD_TYPES:
                err(path, f"unknown fieldType {ft!r}")
            if not isinstance(unit.get("isRequired"), bool):
                err(path, "isRequired must be true or false")
            if not unit.get("name"):
                err(path, "name (the label the tech sees) must be set")
            elif unit["name"] != unit["name"].strip():
                warn(path, "name has leading or trailing spaces")
            if ft in ("Dropdown", "Checkbox"):
                vals = unit.get("values")
                if not isinstance(vals, list) or not vals or not all(isinstance(v, str) for v in vals):
                    err(path, "values must be a non-empty list of strings")
                else:
                    check_strings(path, "value", vals)
            if ft == "Checkbox" and "horizontalLayout" not in unit:
                warn(path, "Checkbox should carry horizontalLayout: false")
            if ft == "Signature" and not isinstance(unit.get("refusalReasons"), list):
                err(path, "Signature needs a refusalReasons list (it may be empty)")
            if ft == "Stoplight" and unit.get("defaultValue") not in ("Green", "Yellow", "Red"):
                err(path, 'Stoplight needs defaultValue "Green", "Yellow" or "Red", or the form fails to open')
            tag = unit.get("smartFieldTag")
            if tag is not None:
                if tag not in SMART_FIELD_TYPES:
                    warn(path, f"smartFieldTag {tag!r} is not one of the confirmed tags {sorted(SMART_FIELD_TYPES)}")
                elif SMART_FIELD_TYPES[tag] != ft:
                    err(path, f"smartFieldTag {tag} goes on a {SMART_FIELD_TYPES[tag]} field, not {ft}")
                if unit.get("isRequired") is True:
                    warn(path, "smart fields fill themselves in; set isRequired: false")
        elif ut == "StaticElement":
            if unit.get("header") is True:
                err(path, "use header: false with <h3> HTML; header: true fails on fresh imports")
            html = unit.get("htmlContent") or ""
            if "{{" in html:
                err(path, "{{...}} tokens do not resolve in htmlContent; use a field with smartFieldTag")
            if "<script" in html.lower():
                err(path, "script tags are stripped from htmlContent")
        else:
            err(path, f"unknown unitType {ut!r}")

    root_path = "$.FormData.definition.definition.rootSection"
    walk(root, root_path, 0)

    # --- Rules -----------------------------------------------------------
    rules = inner.get("rules") or []
    has_logic = inner.get("hasConditionalLogic")
    if has_logic is not bool(rules):
        err("$.FormData.definition.definition.hasConditionalLogic",
            f"must be {str(bool(rules)).lower()} because the form has {len(rules)} rule(s)")

    condition_keys: dict[tuple, int] = {}
    for i, rule in enumerate(rules):
        rp = f"$.FormData.definition.definition.rules[{i}]"
        if "condition" in rule:
            err(rp, 'use "conditions" (a list), not "condition"')
        if rule.get("whenMatch") not in ("All", "Any"):
            err(rp, 'whenMatch must be "All" or "Any"')
        actions = rule.get("actions")
        conditions = rule.get("conditions")
        if not isinstance(actions, list) or not actions:
            err(rp, "actions must be a non-empty list")
            actions = []
        if not isinstance(conditions, list) or not conditions:
            err(rp, "conditions must be a non-empty list")
            conditions = []

        sources: set[str] = set()
        for j, cond in enumerate(conditions):
            cp = f"{rp}.conditions[{j}]"
            ctype = cond.get("type")
            if ctype == "InitialLoad":
                continue
            if ctype == "Compare":
                if cond.get("operator") != "Equals":
                    warn(cp, f"operator {cond.get('operator')!r} is not confirmed in exports; only Equals is")
                left = cond.get("left")
                if left not in units_by_id:
                    err(cp, f"left {left!r} is not a unit in this form")
                elif units_by_id[left].get("unitType") != "Field":
                    err(cp, "left must point at a Field; only fields hold values")
                else:
                    sources.add(left)
                if not isinstance(cond.get("right"), str):
                    err(cp, "right must be the exact option string, for example \"Yes\"")
            else:
                warn(cp, f"condition type {ctype!r} is not confirmed in exports")

        modes = set()
        for j, act in enumerate(actions):
            ap = f"{rp}.actions[{j}]"
            if act.get("type") != "Toggle":
                warn(ap, f"action type {act.get('type')!r} is not confirmed in exports; only Toggle is")
                continue
            if act.get("mode") not in ("On", "Off"):
                err(ap, 'Toggle mode must be "On" or "Off"')
            modes.add(act.get("mode"))
            target = act.get("unit")
            if target not in units_by_id:
                err(ap, f"unit {target!r} is not a unit in this form")
            elif target in sources:
                err(ap, "a rule must not hide or show its own source field (the form can freeze)")
        if len(modes) > 1:
            err(rp, "one rule mixes On and Off actions; split it into one rule per mode")

        if len(conditions) == 1 and len(modes) == 1:
            c = conditions[0]
            key = (c.get("type"), c.get("left"), c.get("right"), next(iter(modes)))
            if key in condition_keys:
                err(rp, f"same condition and mode as rules[{condition_keys[key]}]; merge their actions "
                        "into one rule (split rules cause cascade loops)")
            else:
                condition_keys[key] = i

    # --- Triggers ----------------------------------------------------------
    triggers = form.get("FormTriggers")
    if not isinstance(triggers, list):
        err("$.FormTriggers", "must be a list (use [] to import with no trigger)")
        triggers = []
    for i, trig in enumerate(triggers):
        tp = f"$.FormTriggers[{i}]"
        if trig.get("JobEvent") not in JOB_EVENTS:
            warn(tp, f"JobEvent {trig.get('JobEvent')!r} is not one of the confirmed values {sorted(JOB_EVENTS)}")
        if trig.get("Active") is False:
            warn(tp, "inactive trigger; delete it instead of leaving it in the form")
        for key in ("JobTypeNames", "BusinessUnitNames", "Tags"):
            if trig.get(key):
                check_strings(tp, key, trig[key])
    if sum(1 for t in triggers if t.get("Active")) > 1:
        warn("$.FormTriggers", "more than one active trigger; a job that matches two gets two copies of the form")

    return out
