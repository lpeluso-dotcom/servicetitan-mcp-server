"""
Tests for the Form 2.0 generator and checker.

    python3 -m unittest discover -s tests        (run from forms/generator)
"""

import copy
import json
import sys
import unittest
from pathlib import Path

GEN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(GEN))

import archetypes as a  # noqa: E402
from audit import audit_form  # noqa: E402
from generate import build_form, generate  # noqa: E402
from rules import build_rules  # noqa: E402

EXAMPLES = GEN.parent / "examples"
CONFIGS = GEN / "configs"
# Committed examples are built with these values so the test can rebuild them exactly.
# Seed 2 is chosen so no id starts with a long run of digits, which a leak scanner
# would read as a record number.
EXAMPLE_SEED = 2
EXAMPLE_TIMESTAMP = "2026-01-01T00:00:00.000Z"
EXAMPLE_FILES = {
    "inspection_checklist.py": "inspection-checklist.json",
    "equipment_photo_capture.py": "equipment-photo-capture.json",
    "job_materials.py": "job-materials.json",
}

S, U1, U2, S2 = (f"aaaaaaaa-0000-4000-8000-00000000000{i}" for i in range(1, 5))


def walk(units):
    for u in units:
        yield u
        yield from walk(u.get("units") or [])


def all_units(form):
    return list(walk(form["FormData"]["definition"]["definition"]["rootSection"]["units"]))


def errors(form):
    return [str(f) for f in audit_form(form) if f.level == "error"]


def small_form(**overrides):
    a.set_seed(1)
    cfg = {
        "name": "Test Form",
        "sections": [
            a.job_context(),
            a.escape_block("Panel", [a.picture_field("PANEL PHOTO", required=True)], "NO PANEL"),
            a.tech_acknowledgment(prompt="I confirm", refusal_reasons=["Declined"]),
        ],
    }
    cfg.update(overrides)
    form = build_form(cfg, timestamp=EXAMPLE_TIMESTAMP)
    a.set_seed(None)
    return form


class RuleGraph(unittest.TestCase):
    def test_initial_load_rules_come_before_compare_rules(self):
        rules = build_rules([
            {"kind": "compare_equals_off", "source_id": S, "match_value": "Yes", "unit_ids": [U1]},
            {"kind": "initial_load_on", "unit_ids": [U1]},
        ])
        self.assertEqual([r["conditions"][0]["type"] for r in rules], ["InitialLoad", "Compare"])

    def test_same_condition_and_mode_merge_into_one_rule(self):
        rules = build_rules([
            {"kind": "compare_equals_on", "source_id": S, "match_value": "Yes", "unit_ids": [U1]},
            {"kind": "compare_equals_on", "source_id": S, "match_value": "Yes", "unit_ids": [U2]},
        ])
        self.assertEqual(len(rules), 1)
        self.assertEqual([x["unit"] for x in rules[0]["actions"]], [U1, U2])

    def test_on_and_off_never_merge(self):
        rules = build_rules([
            {"kind": "compare_equals_on", "source_id": S, "match_value": "Yes", "unit_ids": [U1]},
            {"kind": "compare_equals_off", "source_id": S, "match_value": "Yes", "unit_ids": [U2]},
        ])
        self.assertEqual(len(rules), 2)
        for r in rules:
            self.assertEqual(len({x["mode"] for x in r["actions"]}), 1)

    def test_distinct_sources_stay_separate(self):
        rules = build_rules([
            {"kind": "compare_equals_on", "source_id": S, "match_value": "Yes", "unit_ids": [U1]},
            {"kind": "compare_equals_on", "source_id": S2, "match_value": "Yes", "unit_ids": [U2]},
        ])
        self.assertEqual({r["conditions"][0]["left"] for r in rules}, {S, S2})

    def test_rule_shape(self):
        (rule,) = build_rules([{"kind": "compare_equals_on", "source_id": S, "match_value": "Yes", "unit_ids": [U1]}])
        self.assertEqual(rule, {
            "whenMatch": "All",
            "actions": [{"type": "Toggle", "unit": U1, "mode": "On", "isMet": False}],
            "conditions": [{"type": "Compare", "operator": "Equals", "left": S, "right": "Yes"}],
        })

    def test_unknown_kind_raises(self):
        with self.assertRaises(ValueError):
            build_rules([{"kind": "show", "unit_ids": [U1]}])


class Builders(unittest.TestCase):
    def test_nested_section_is_refused(self):
        inner = a.section("Inner", [a.text_field("X")])
        with self.assertRaises(ValueError):
            a.section("Outer", [inner])

    def test_stoplight_requires_a_real_default(self):
        self.assertEqual(a.stoplight_field("STATUS")["defaultValue"], "Green")
        with self.assertRaises(ValueError):
            a.stoplight_field("STATUS", default_value="")

    def test_unknown_smart_field_is_refused(self):
        with self.assertRaises(ValueError):
            a.job_context(smart_fields=["JobNumber"])

    def test_unconfirmed_job_event_is_refused(self):
        with self.assertRaises(ValueError):
            a.form_trigger(job_event="OnJobCreated")

    def test_seed_makes_ids_reproducible_and_lowercase(self):
        a.set_seed(3)
        first = [a.new_id() for _ in range(5)]
        a.set_seed(3)
        second = [a.new_id() for _ in range(5)]
        a.set_seed(None)
        self.assertEqual(first, second)
        self.assertTrue(all(i == i.lower() for i in first))

    def test_escape_block_hides_its_units_but_not_the_escape(self):
        sections, specs = a.escape_block("Panel", [a.picture_field("P", required=True)], "NO PANEL")
        (spec,) = specs
        escape = sections[0]["units"][-1]
        self.assertEqual(spec["kind"], "compare_equals_off")
        self.assertEqual(spec["source_id"], escape["id"])
        self.assertNotIn(escape["id"], spec["unit_ids"])

    def test_gated_block_keeps_gated_sections_at_the_root(self):
        rows = [a.section("Row 1", [a.text_field("A")])]
        sections, specs = a.gated_block("Block", "USED?", rows)
        self.assertEqual(len(sections), 2)
        self.assertEqual([s["kind"] for s in specs], ["initial_load_off", "compare_equals_on"])
        self.assertEqual(specs[1]["unit_ids"], [rows[0]["id"]])


class ImportSafety(unittest.TestCase):
    """The traits a generated form needs to import and then open in the editor."""

    def setUp(self):
        self.form = small_form()
        self.units = all_units(self.form)

    def test_published_with_timestamps_and_nonzero_ids(self):
        fd = self.form["FormData"]
        self.assertIs(fd["definition"]["published"], True)
        self.assertTrue(fd["createdOn"] and fd["modifiedOn"])
        self.assertNotEqual(fd["id"], 0)
        self.assertNotEqual(fd["definition"]["id"], 0)

    def test_sections_are_one_level_deep_and_duplicable(self):
        root = self.form["FormData"]["definition"]["definition"]["rootSection"]["units"]
        self.assertTrue(all(u["unitType"] == "Section" for u in root))
        for s in root:
            self.assertIs(s["canBeDuplicated"], True)
            self.assertFalse([u for u in s["units"] if u["unitType"] == "Section"])

    def test_headings_use_h3_not_the_header_flag(self):
        statics = [u for u in self.units if u["unitType"] == "StaticElement"]
        self.assertTrue(statics)
        self.assertFalse([s for s in statics if s["header"]])
        self.assertTrue(any("<h3>" in s["htmlContent"] for s in statics))

    def test_no_number_or_photo_field_types(self):
        types = {u.get("fieldType") for u in self.units}
        self.assertFalse(types & {"Number", "Photo"})

    def test_has_conditional_logic_matches_rules(self):
        inner = self.form["FormData"]["definition"]["definition"]
        self.assertIs(inner["hasConditionalLogic"], bool(inner["rules"]))
        flat = small_form(sections=[a.job_context()])
        self.assertIs(flat["FormData"]["definition"]["definition"]["hasConditionalLogic"], False)

    def test_clean_form_has_no_findings(self):
        self.assertEqual([str(f) for f in audit_form(self.form)], [])


class Checker(unittest.TestCase):
    """Each import-breaking mistake is reported as an error."""

    def setUp(self):
        self.good = small_form()

    def mutate(self, fn):
        form = copy.deepcopy(self.good)
        fn(form)
        return errors(form)

    def first(self, form, pred):
        return next(u for u in all_units(form) if pred(u))

    def assertCaught(self, fn, needle):
        found = self.mutate(fn)
        self.assertTrue(any(needle in e for e in found), f"expected {needle!r} in {found}")

    def test_draft_definition(self):
        self.assertCaught(lambda f: f["FormData"]["definition"].update(published=False), "published")

    def test_missing_timestamp(self):
        self.assertCaught(lambda f: f["FormData"].pop("modifiedOn"), "modifiedOn")

    def test_nested_section(self):
        def nest(f):
            root = f["FormData"]["definition"]["definition"]["rootSection"]["units"]
            root[0]["units"].append(root.pop())
        self.assertCaught(nest, "Section inside a Section")

    def test_bare_field_at_root(self):
        def bare(f):
            root = f["FormData"]["definition"]["definition"]["rootSection"]["units"]
            root.append(a.text_field("LOOSE"))
        self.assertCaught(bare, "inside a Section")

    def test_header_flag(self):
        self.assertCaught(lambda f: self.first(f, lambda u: u["unitType"] == "StaticElement").update(header=True),
                          "header: false")

    def test_wrong_field_types(self):
        for wrong in ("Photo", "Toggle", "Number", "Radio"):
            self.assertCaught(lambda f: self.first(f, lambda u: u.get("fieldType") == "Picture").update(fieldType=wrong),
                              f'"{wrong}"')

    def test_uppercase_or_duplicate_id(self):
        self.assertCaught(lambda f: self.first(f, lambda u: u["unitType"] == "Field").update(id="ABC"), "lowercase")
        def dup(f):
            fields = [u for u in all_units(f) if u["unitType"] == "Field"]
            fields[1]["id"] = fields[0]["id"]
        self.assertCaught(dup, "duplicate id")

    def test_stoplight_without_default(self):
        def add(f):
            f["FormData"]["definition"]["definition"]["rootSection"]["units"][0]["units"].append(
                {**a.stoplight_field("S"), "defaultValue": None})
        self.assertCaught(add, "Stoplight")

    def test_signature_without_refusal_reasons(self):
        self.assertCaught(lambda f: self.first(f, lambda u: u.get("fieldType") == "Signature").pop("refusalReasons"),
                          "refusalReasons")

    def test_smart_field_on_wrong_type(self):
        self.assertCaught(lambda f: self.first(f, lambda u: u.get("smartFieldTag") == "TodayDate").update(fieldType="Text"),
                          "goes on a Date field")

    def test_mustache_in_html(self):
        self.assertCaught(lambda f: self.first(f, lambda u: u["unitType"] == "StaticElement").update(
            htmlContent="Hi {{customer.name}}"), "{{")

    def test_rule_pointing_at_missing_unit(self):
        self.assertCaught(lambda f: f["FormData"]["definition"]["definition"]["rules"][0]["actions"][0].update(unit=U1),
                          "not a unit in this form")

    def test_split_same_condition_rules(self):
        def split(f):
            rules = f["FormData"]["definition"]["definition"]["rules"]
            rules.append(copy.deepcopy(rules[0]))
        self.assertCaught(split, "merge their actions")

    def test_rule_hiding_its_own_source(self):
        def self_hide(f):
            rule = f["FormData"]["definition"]["definition"]["rules"][0]
            rule["actions"][0]["unit"] = rule["conditions"][0]["left"]
        self.assertCaught(self_hide, "its own source")

    def test_singular_condition_key(self):
        self.assertCaught(lambda f: f["FormData"]["definition"]["definition"]["rules"][0].update(condition={}),
                          '"conditions"')

    def test_has_conditional_logic_mismatch(self):
        self.assertCaught(lambda f: f["FormData"]["definition"]["definition"].update(hasConditionalLogic=False),
                          "hasConditionalLogic")

    def test_unverified_shapes_are_warnings_not_errors(self):
        form = copy.deepcopy(self.good)
        form["FormData"]["definition"]["definition"]["rules"][0]["conditions"][0]["operator"] = "NotEquals"
        levels = {f.level for f in audit_form(form) if "operator" in f.message}
        self.assertEqual(levels, {"warning"})


class Examples(unittest.TestCase):
    """The committed example JSON files are exactly what the configs build."""

    def test_examples_match_their_configs(self):
        for config, example in EXAMPLE_FILES.items():
            with self.subTest(example=example):
                built = generate(CONFIGS / config, seed=EXAMPLE_SEED, timestamp=EXAMPLE_TIMESTAMP)
                committed = json.loads((EXAMPLES / example).read_text())
                self.assertEqual(built, committed,
                                 f"regenerate with: python3 generate.py configs/{config} "
                                 f"--seed {EXAMPLE_SEED} --timestamp {EXAMPLE_TIMESTAMP}")

    def test_examples_pass_the_checker_cleanly(self):
        for example in EXAMPLE_FILES.values():
            with self.subTest(example=example):
                form = json.loads((EXAMPLES / example).read_text())
                self.assertEqual([str(f) for f in audit_form(form)], [])

    def test_minimal_form_in_the_reference_passes_the_checker(self):
        md = (GEN.parent / "reference" / "schema.md").read_text()
        block = md.split("## A complete minimal form")[1].split("```json")[1].split("```")[0]
        self.assertEqual([str(f) for f in audit_form(json.loads(block))], [])

    def test_examples_match_the_json_schema(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("pip install jsonschema to run the JSON Schema check")
        schema = json.loads((GEN.parent / "schema" / "form20.schema.json").read_text())
        validator = jsonschema.Draft202012Validator(schema)
        for example in EXAMPLE_FILES.values():
            with self.subTest(example=example):
                form = json.loads((EXAMPLES / example).read_text())
                self.assertEqual([e.message for e in validator.iter_errors(form)], [])


if __name__ == "__main__":
    unittest.main()
