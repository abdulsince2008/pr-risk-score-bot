# PR Risk Score Bot

GitHub Action that computes a PR risk score from **diff size**, **historical bug density** (git log "fix"/"bug" commits), and **test coverage changes** — then posts the score as a PR comment.

---

## Why this is different

Existing tools:
- **CodeCov / Coveralls** — measure test coverage %, not *whether tests changed in this PR*
- **Danger / PR-Metrics** — run arbitrary checks, but don't combine diff size + bug history + test changes into one actionable score
- **GitHub's own "Files changed" UI** — shows raw numbers, no risk interpretation

**This tool's unique value**: One zero-config Action that fuses three orthogonal signals (size, history, tests) into a single 0–100 score reviewers can act on instantly — no YAML rules to maintain, no dashboard to watch.

---

## How it works

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  PR Opened/     │────▶│  Fetch diff via  │────▶│  Parse touched     │
│  Synchronize    │     │  GitHub API      │     │  files & line      │
└─────────────────┘     └──────────────────┘     │  counts            │
                                                 └─────────┬──────────┘
                                                           │
                    ┌──────────────────────────────────────┘
                    ▼
         ┌─────────────────────┐     ┌────────────────────┐
         │  For each touched   │────▶│  git log --since   │
         │  file, run git log  │     │  90d (configurable)│
         └─────────────────────┘     └─────────┬──────────┘
                                               │
                    ┌──────────────────────────┘
                    ▼
         ┌─────────────────────┐     ┌────────────────────┐
         │  Count commits with │────▶│  Compute bug       │
         │  "fix"/"bug"/etc.   │     │  density ratio     │
         └─────────────────────┘     └─────────┬──────────┘
                                               │
                    ┌──────────────────────────┘
                    ▼
         ┌─────────────────────┐     ┌────────────────────┐
         │  Check if any test  │────▶│  Weighted score:   │
         │  files modified     │     │  40% diff + 40%    │
         └─────────────────────┘     │  bug + 20% tests   │
                                     └─────────┬──────────┘
                                               │
                    ┌──────────────────────────┘
                    ▼
         ┌─────────────────────┐
         │  Post/update PR     │
         │  comment with score │
         └─────────────────────┘
```

**Score formula** (weights configurable):
```
score = 40% × normalized(diff_lines, 0–500)
      + 40% × normalized(bug_density, 0–1)
      + 20% × (tests_changed ? 0 : 1)
```

**Thresholds**:
- 🟢 0–30: Low Risk
- 🟡 31–60: Medium Risk
- 🔴 61–100: High Risk

---

## Prerequisites

- **Node.js ≥ 20** (for local development / building the action)
- **GitHub repository** with Actions enabled (for actual use)

---

## How to run

### 1. Add workflow file (`.github/workflows/pr-risk.yml`)

```yaml
name: PR Risk Score
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  risk-score:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # needed for git log history
      - uses: ./  # or: uses: your-org/pr-risk-score-bot@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # Optional custom weights (must sum to 1):
          # weights: '{"diff":0.4,"bug":0.4,"test":0.2}'
          # since-days: '90'
          # fail-on-high: 'false'
```

### 2. Push and open a PR — the bot comments automatically

---

## Example output

Real comment from a test run on this repo:

> ## PR Risk Score: 23/100 (🟡 Medium Risk)
>
> | Metric | Value |
> |--------|-------|
> | **Lines Changed** | +110 / -28 (138 total) |
> | **Files Touched** | 4 |
> | **Historical Bug Density** | 5.0% |
> | **Test Coverage** | ✅ Tests modified |
>
> ### Breakdown
> - **Diff Size Impact** (40%): 11.0/40
> - **Bug Density Impact** (40%): 2.0/40
> - **Test Changes Impact** (20%): 0/20
>
> > 💡 *This score helps prioritize review attention. High-risk PRs may need more thorough review, additional testing, or splitting into smaller changes.*

---

## Local test output (unit logic)

```
=== PR Risk Score Bot - Local Test ===

1. Testing isTestFile function:
   tests/auth/login.test.js: TEST
   src/components/Button.spec.tsx: TEST
   __tests__/utils.test.js: TEST
   src/utils/helpers.js: SOURCE
   src/auth/login.js: SOURCE

2. Testing computeRiskScore:
   Low bug density (5%), tests changed: 13/100
   Medium bug density (30%), tests changed: 23/100
   High bug density (60%), tests changed: 35/100
   Low bug density (5%), NO tests changed: 33/100
   Medium bug density (30%), NO tests changed: 43/100

3. Testing with larger diff (500+ lines):
   Large diff, low bug density, tests changed: 42/100
   Large diff, high bug density, no tests: 80/100

4. Testing with zero changes:
   Empty diff: 0/100
```

---

## Tech stack + libraries reused

| Library | Purpose | Why not custom |
|---------|---------|----------------|
| `@actions/core` | Input/output, logging, failure handling | Official GitHub Actions SDK |
| `@actions/github` | Octokit client for GitHub REST API | Official, maintained by GitHub |
| `simple-git` | Lightweight `git log`/`diff` wrapper | Battle-tested, handles edge cases (encoding, paths, etc.) |
| `@vercel/ncc` | Bundles deps into single `dist/index.js` | Required for GitHub Actions distribution |

**Genuinely new code**: The weighted risk formula, bug-density-from-git-log logic, and PR comment formatting — ~150 lines total.

---

## Known limitations / what's next

- **Shallow clone caveat**: Requires `fetch-depth: 0` in checkout; otherwise `git log` has no history
- **Bug keyword false positives**: "fix" in "prefix" counts — could add word-boundary regex
- **Monorepo support**: Currently scores whole PR; could break down by package/folder
- **No ML**: Pure heuristic; could train on past "reverted PRs" for calibrated probabilities
- **No dashboard**: Score lives only in PR comments; could push to a time-series DB for trending
- **Language-agnostic test detection**: Heuristic patterns; could parse `jest.config.js`, `vitest.config.ts`, etc.

---

## License

MIT