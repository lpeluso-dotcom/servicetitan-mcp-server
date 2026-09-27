"""
Turns rule specs from archetypes.py into the Form 2.0 `rules[]` array.

Rule shape, as found in real exports:

    {
      "whenMatch": "All",
      "actions": [{"type": "Toggle", "unit": "<uuid>", "mode": "On" | "Off", "isMet": false}, ...],
      "conditions": [{"type": "InitialLoad"}]
                 or [{"type": "Compare", "operator": "Equals", "left": "<source uuid>", "right": "<value>"}]
    }

Two rules this module enforces:

  1. Order. When two rules touch the same unit, the LOWER rule in the list wins.
     InitialLoad rules set the baseline, so they are emitted first. Compare
     rules override the baseline, so they come after.

  2. Merging. Actions that share a condition (same source, same value, same
     mode) go into ONE rule. Emitting them as separate rules sent the form's
     rules engine into a re-evaluation loop at scale (cascade-loop warnings on
     load, gated fields showing when they should be hidden). One rule with
     several actions is the fix. An On and an Off never merge, so a rule
     never contradicts itself.
"""

from typing import Iterable

INITIAL_KINDS = {"initial_load_off": "Off", "initial_load_on": "On"}
COMPARE_KINDS = {"compare_equals_off": "Off", "compare_equals_on": "On"}


def _toggles(unit_ids: list[str], mode: str) -> list[dict]:
    return [{"type": "Toggle", "unit": uid, "mode": mode, "isMet": False} for uid in unit_ids]


def build_rules(rule_specs: Iterable[dict]) -> list[dict]:
    """Merge specs by condition and emit them in precedence order."""
    initial: dict[str, list[str]] = {}
    compare: dict[tuple[str, str, str], list[str]] = {}

    for spec in rule_specs:
        kind = spec.get("kind")
        if kind in INITIAL_KINDS:
            initial.setdefault(INITIAL_KINDS[kind], []).extend(spec["unit_ids"])
        elif kind in COMPARE_KINDS:
            key = (spec["source_id"], spec["match_value"], COMPARE_KINDS[kind])
            compare.setdefault(key, []).extend(spec["unit_ids"])
        else:
            raise ValueError(f"unknown rule spec kind: {kind!r}")

    rules = [
        {"whenMatch": "All", "actions": _toggles(ids, mode), "conditions": [{"type": "InitialLoad"}]}
        for mode, ids in initial.items()
    ]
    rules += [
        {
            "whenMatch": "All",
            "actions": _toggles(ids, mode),
            "conditions": [{"type": "Compare", "operator": "Equals", "left": source, "right": value}],
        }
        for (source, value, mode), ids in compare.items()
    ]
    return rules
