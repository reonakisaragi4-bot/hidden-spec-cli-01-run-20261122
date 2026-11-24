# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/reonakisaragi4-bot/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/reonakisaragi4-bot/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is a zero-dependency command-line tool (Node 22, standard library only) that applies
edits AI models write to a tree of text files. It reads all four formats to one written
contract (`SPEC.md`): unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and text-editor tool calls as JSON. It finds the lines an edit names at the
first of three matching tiers — exact, trailing whitespace off, both ends off — and changes
every file or none.

Built for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, or `-` / absent for standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto`
  (the default) detects it.
- `--check` does everything but write: the same output and exit code, no file changed.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 lists what changed (`A`/`D`/`M`, `R old -> new` for moves) and ends with
`ok: <n> files`. Exit 1 lists each failed edit (`error: <code> <path>`) and
`failed: <k> of <n> edits`, and writes nothing. Exit 2 is a usage, no-patch, format or
parse error (`error: parse <N>`).

## Practice score

The kit's 100 public practice checks: **100 of 100 passed, practice score 1000**
(`node check.ts <kit>/program/generator/practice.json`). The house strict applier —
exact matching only — scores 750 on the same set (75/100), so `mend` beats it by 250
points on practice: unified 30/30 (strict 24/30), SEARCH/REPLACE 20/20 (strict 11/20),
V4A 20/20 (strict 11/20), JSON 15/15, CLI 15/15.

## Layout

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (kept as shipped).
- `check.ts` — runs the practice set on this machine.
- `SPEC.md` — the specification this tool implements.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cdrpe06y&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
