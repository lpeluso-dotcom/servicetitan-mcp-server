# Agent instructions: ServiceTitan Forms Kit

If you are an AI agent working in this folder, read [`SKILL.md`](SKILL.md) first and follow its
workflow. It lists the hard rules and tells you which file in `reference/` to read at each step.

Before you finish any task that changes a form or the generator:

```bash
cd generator
python3 -m unittest discover -s tests
python3 generate.py --check <path to each form you changed>
```

If you change a config in `generator/configs/`, rebuild its example so the tests keep passing:

```bash
python3 generate.py configs/<name>.py --seed 2 --timestamp 2026-01-01T00:00:00.000Z
```

Do not add a JSON key, field type, operator, or trigger value that is not already in
`reference/schema.md` unless you copy it from a real ServiceTitan export and document where it came
from.
