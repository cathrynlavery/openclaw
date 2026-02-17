---
name: pr-dedup
description: Detect likely duplicate GitHub pull requests and rank competing PRs by quality signals (CI, approvals, scope, tests, freshness, and bot reviews) using only the `gh` CLI. Use when asked to scan one or more repos for duplicate PR work, choose a preferred PR, label/comment/close weaker duplicates, or produce a daily duplicate-and-quality leaderboard report.
metadata:
  {
    "openclaw":
      {
        "emoji": "🧹",
        "requires": { "bins": ["gh"] },
      },
  }
---

# PR Dedup + Quality Rank (GitHub)

Use this skill to find duplicate open PRs, pick the strongest candidate in each duplicate cluster, and optionally take action (comment, label, close, and publish a leaderboard summary).

## Core operating rules

- Use only `gh` commands for GitHub interaction (`gh pr list`, `gh pr view`, `gh pr diff`, `gh api`, `gh pr comment`, `gh pr edit`, `gh pr close`, `gh issue create`, `gh issue comment`).
- Prefer `--json` / `--jq` outputs over parsing raw text.
- Default to **analysis + report first**. Ask for confirmation before state-changing actions (label/comment/close/create issue) unless the user explicitly requested auto-apply.
- Always pass `--repo owner/repo` unless already in the target repository.
- For multi-repo runs, iterate repos and produce a per-repo section plus a global summary.

## 1) Authenticate and collect targets

Check auth once:

```bash
gh auth status
```

Target repos can come from user text (e.g. `owner/repo owner2/repo2`) or current git remote.

For each repo, collect open PR basics:

```bash
gh pr list \
  --repo owner/repo \
  --state open \
  --limit 200 \
  --json number,title,headRefName,author,body,createdAt,updatedAt,isDraft,additions,deletions,changedFiles,url
```

If fewer than 2 open PRs, report and skip dedup logic for that repo.

## 2) Pull enrichment for each PR

For each PR number `N` in each repo, gather:

### Files changed

```bash
gh pr diff N --repo owner/repo --name-only
```

### Reviews/approvals

```bash
gh pr view N --repo owner/repo --json reviews
```

Count approvals and change requests from `reviews[].state`.

### CI/check status

```bash
gh pr checks N --repo owner/repo
```

Use this to classify: passing / failing / pending / no-checks.

### Linked issues / references (body + commits)

Use PR body and title references (`#123`, `owner/repo#123`, `fixes #123`, etc.) from `gh pr list --json body,title`.
Optionally inspect timeline cross-references:

```bash
gh api repos/owner/repo/issues/N/timeline
```

(Use only when needed; timeline can be noisy.)

### Bot review signals

From reviews data, detect bot actors (`login` ending in `[bot]`) and classify:
- bot requested changes
- bot warning/nit style comments
- bot approval/neutral

## 3) Duplicate detection heuristics

Build pairwise comparisons of open PRs in the same repo. Create a duplicate confidence bucket: **high**, **medium**, **low**, **none**.

### Signal A: file overlap (strongest)

Compute overlap from `gh pr diff --name-only` file sets.
- High overlap: substantial intersection (especially same core files)
- Medium overlap: partial overlap with same feature area
- Low overlap: little overlap

### Signal B: issue-reference overlap

If two PRs reference same issue(s), increase duplicate confidence.

### Signal C: title/body semantic similarity

Use native model reasoning over title/body intent:
- same bug/feature phrasing
- same acceptance criteria or scope
- same error strings/feature names

### Signal D: branch name similarity

Compare `headRefName` patterns (e.g., `fix/login-timeout`, `bugfix/login-timeout-v2`).

### Signal E: author/context

Different authors tackling same issue concurrently can still be duplicates; do not down-rank solely by author.

### Decision rule

Mark as likely duplicate cluster when:
- Signal A is high, or
- Signal B matches and either Signal C or D is medium/high, or
- Signal C + D are both high even with partial file overlap.

Provide a short rationale per cluster (2-4 bullets).

## 4) Quality scoring for ranked winner selection

Within each duplicate cluster, score each PR 0-100 and choose a preferred PR.

Suggested rubric (tune per repo norms):

- **CI health (0-25):** passing full checks highest; failing checks penalized heavily.
- **Review quality (0-20):** approvals and constructive review outcomes.
- **Scope efficiency (0-15):** fewer, focused changes favored over excessively broad diffs.
- **Test evidence (0-15):** test files added/updated (`test`, `spec`, `__tests__`, etc.) or explicit test notes.
- **Freshness (0-15):** recently updated PRs with active iteration favored over stale PRs.
- **Bot-review signal (0-10):** no unresolved bot-requested changes scores higher.

Use `additions`, `deletions`, `changedFiles`, checks status, review states, timestamps, changed filenames, and review authors to justify each score.

Output table per cluster:

- PR # / URL
- Duplicate confidence
- Quality score
- Key strengths
- Risks/blockers
- Recommended action (keep / label duplicate / close candidate)

## 5) Action mode (optional, explicit)

After reporting, if user requests action, apply in this order:

### A) Comment on weaker duplicates

```bash
gh pr comment <pr> --repo owner/repo --body "This PR appears to overlap with #<winner>.\n\nReasoning:\n- ...\n\nRecommended next step: merge work into #<winner> or close this PR if superseded."
```

### B) Add duplicate label(s)

```bash
gh pr edit <pr> --repo owner/repo --add-label duplicate
```

If team uses a stronger label, add both (e.g. `duplicate,candidate-close`).

### C) Optionally close weaker PR

Only when user explicitly asks to close:

```bash
gh pr close <pr> --repo owner/repo --comment "Closing as duplicate of #<winner>. Consolidating work there."
```

Never auto-close without explicit instruction.

### D) Leaderboard / summary issue

Create or update a daily summary issue with ranked clusters:

```bash
gh issue create \
  --repo owner/repo \
  --title "PR Dedup Report - YYYY-MM-DD" \
  --body "<markdown summary with clusters, winners, and actions>"
```

If an issue already exists for the day, append via:

```bash
gh issue comment <issue-number> --repo owner/repo --body "<updated summary>"
```

## 6) Daily summary mode (cron-friendly)

When prompted with: "Run PR dedup scan on these repos: ..."

1. Run read-only scan across all repos.
2. Produce:
   - repos scanned
   - total open PRs
   - duplicate clusters found
   - recommended winners
   - action plan (what would be labeled/commented/closed)
3. If prompt includes auto-apply, perform actions and include an execution log.
4. Optionally post a summary issue per repo.

Recommended summary sections:

- Executive summary
- Cluster leaderboard (highest-confidence duplicates first)
- Winner ranking by quality score
- Actions taken (or pending approval)
- Follow-ups for maintainers

## 7) Output contract

For every run, return:

- Inputs: repos scanned, PR count
- Duplicate clusters with confidence + rationale
- Ranked PRs with quality scoring details
- Clear winner per cluster
- Exact actions taken (or proposed)
- Any commands that failed + error text

Keep the report concise but decision-oriented so maintainers can act immediately.
