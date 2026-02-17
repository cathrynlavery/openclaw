---
name: pr-dedup
description: Incremental GitHub PR+Issue dedup with quality ranking, vision alignment checks, deep diff review, and cache-backed cron operation using only `gh` + native agent reasoning.
metadata: { "openclaw": { "emoji": "🧹", "requires": { "bins": ["gh"] } } }
---

# PR + Issue Dedup (Incremental, Cache-Backed, Cron-First)

Use this skill when you need to continuously detect duplicate work across **pull requests and issues**, pick canonical threads, and keep repositories clean at scale.

This skill is designed for:

- high-volume repos
- autonomous agent + human overlap
- incremental cron runs (every ~15 minutes)
- maintainers who need decisions, not noise

No npm dependencies. Use `gh` CLI + native reasoning.

---

## Core Guarantees

- Detect duplicates across:
  - PR ↔ PR
  - Issue ↔ Issue
  - Issue ↔ PR
- Rank competing implementations with quality + risk scoring.
- Align work against repo direction docs (`VISION.md`, `ROADMAP.md`, `CONTRIBUTING.md`).
- Scale using batching, search pre-filters, and incremental cache updates.
- Persist state in local cache so unchanged items are not re-processed.

---

## Defaults (override when user specifies)

- `BATCH_SIZE=100`
- `LOOKBACK_DAYS=7` (for closed/merged historical window and bootstrap limits)
- `CRON_INTERVAL=15m`
- `MODE=incremental` (primary mode)
- `CACHE_DIR=~/.openclaw/pr-dedup-cache`
- `AUTO_APPLY=false` (manual mode)
- `AUTO_CLOSE_STALE_DUP_PR=true` in cron mode when confidence is high and canonical fix is merged

Always pass `--repo owner/repo` unless already in that repo.

---

## 0) Cache Design (Required)

### Cache path

For each repo:

```bash
~/.openclaw/pr-dedup-cache/{owner}-{repo}.json
```

Example:

```bash
~/.openclaw/pr-dedup-cache/openclaw-openclaw.json
```

### Minimum item fields (required by spec)

Store all scanned items with at least:

- `number`
- `title`
- `files` (empty array for issues unless inferred/linked)
- `status`
- `score`
- `last_checked`

Recommended extended schema:

```json
{
  "repo": "owner/repo",
  "last_full_scan": "2026-02-16T20:00:00Z",
  "last_incremental_scan": "2026-02-16T20:15:00Z",
  "config": {
    "batch_size": 100,
    "lookback_days": 7
  },
  "items": {
    "pr:18772": {
      "type": "pr",
      "number": 18772,
      "title": "...",
      "updated_at": "2026-02-16T19:58:00Z",
      "state": "OPEN",
      "merged": false,
      "files": ["skills/pr-dedup/SKILL.md"],
      "issue_refs": [1234],
      "labels": ["enhancement"],
      "status": "active",
      "score": {
        "quality": 84,
        "correctness_risk": 22,
        "test_adequacy": 70,
        "scope_creep": 18,
        "complexity": 31,
        "vision_alignment": 91
      },
      "cluster_id": "cluster-42",
      "canonical": true,
      "last_checked": "2026-02-16T20:15:00Z"
    },
    "issue:441": {
      "type": "issue",
      "number": 441,
      "title": "...",
      "updated_at": "2026-02-16T19:00:00Z",
      "state": "OPEN",
      "files": [],
      "linked_prs": [18772],
      "labels": ["bug"],
      "status": "duplicate-candidate",
      "score": {
        "quality": 62,
        "vision_alignment": 88
      },
      "cluster_id": "cluster-42",
      "canonical": false,
      "last_checked": "2026-02-16T20:15:00Z"
    }
  },
  "indexes": {
    "by_issue": {
      "441": ["issue:441", "pr:18772", "pr:18801"]
    }
  }
}
```

### Cache behavior rules

1. First run: build baseline cache.
2. Subsequent runs: fetch only items updated since `last_incremental_scan`.
3. Do not re-process unchanged items.
4. Update `last_checked` for touched items only.
5. Keep closed/merged items in cache for cleanup logic and history.

---

## 1) Bootstrap vs Incremental Mode

## A) First run (bootstrap)

Build initial cache in batches of 100.

Collect:

- all open PRs
- all open issues
- merged/closed PRs and issues updated in last `LOOKBACK_DAYS`

Use date pre-filtering where possible:

```bash
SINCE=$(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)

# Open PRs
 gh pr list --repo owner/repo --state open --limit 100 \
  --json number,title,body,author,headRefName,createdAt,updatedAt,isDraft,additions,deletions,changedFiles,labels,url

# Recently updated non-open PRs
 gh pr list --repo owner/repo --state closed --search "updated:>=${SINCE}" --limit 100 \
  --json number,title,body,author,headRefName,createdAt,updatedAt,mergedAt,mergeCommit,state,labels,url

# Open issues
 gh issue list --repo owner/repo --state open --limit 100 \
  --json number,title,body,author,createdAt,updatedAt,labels,state,url

# Recently updated non-open issues
 gh issue list --repo owner/repo --state closed --search "updated:>=${SINCE}" --limit 100 \
  --json number,title,body,author,createdAt,updatedAt,closedAt,labels,state,url
```

If result volumes exceed 100, process in additional 100-item batches (adjust search windows or pagination strategy via repeated `gh` queries).

## B) Incremental run (every ~15 min, primary)

Read cache and compute:

- `SINCE = last_incremental_scan`

Fetch only updates:

```bash
gh pr list --repo owner/repo --state all --search "updated:>=${SINCE}" --limit 100 \
  --json number,title,body,author,headRefName,createdAt,updatedAt,mergedAt,state,isDraft,additions,deletions,changedFiles,labels,url

gh issue list --repo owner/repo --state all --search "updated:>=${SINCE}" --limit 100 \
  --json number,title,body,author,createdAt,updatedAt,closedAt,state,labels,url
```

Then:

1. Upsert changed items into cache.
2. Recompute clusters only for touched items + related cached neighbors.
3. Skip untouched clusters.
4. Persist cache.

---

## 2) Enrichment (PRs and Issues)

For each **changed/new** PR:

### PR files

```bash
gh pr diff <N> --repo owner/repo --name-only
```

### PR deep diff text (for risk/quality review)

```bash
gh pr diff <N> --repo owner/repo
```

### PR reviews

```bash
gh pr view <N> --repo owner/repo --json reviews
```

### PR checks

```bash
gh pr checks <N> --repo owner/repo
```

### Linked/closing issues

```bash
gh pr view <N> --repo owner/repo --json closingIssuesReferences,mergedAt,state,title,body,labels
```

If `closingIssuesReferences` is unavailable/empty but body contains `fixes #X` patterns, infer refs from body text.

For each **changed/new** issue:

```bash
gh issue view <N> --repo owner/repo --json number,title,body,labels,state,createdAt,updatedAt,closedAt,url
```

Also infer linked PRs from:

- issue timeline (optional, when needed):
  ```bash
  gh api repos/owner/repo/issues/<N>/timeline
  ```
- references in body/comments

---

## 3) Duplicate Detection Across PRs + Issues

Cluster candidates using weighted signals:

1. **Title/body semantic similarity** (intent, acceptance criteria, error signatures)
2. **Labels overlap** (bug/feature/component tags)
3. **Referenced files/code**
   - PRs: changed files from diffs
   - Issues: files explicitly named in issue body, plus files from linked PRs
4. **Linked PR/issue graph overlap**
5. **Shared issue refs from PRs**
6. **Branch naming similarity** (PR-only)

Confidence buckets:

- `high`
- `medium`
- `low`
- `none`

Mark one canonical item per cluster (usually highest-quality, most complete, best-aligned, most actively maintained).

### Required issue behavior

- Detect duplicates for issue↔issue and issue↔PR.
- Comment on duplicate issues linking canonical item.
- Add `duplicate-candidate` label to weaker issues.

Example comment:

```text
This appears to overlap with #<canonical>.

Why:
- Similar problem statement/scope
- Shared referenced files/components
- Linked to the same implementation thread

If you agree, we should consolidate discussion there.
```

---

## 4) Vision / Roadmap Alignment

Try root docs in this order:

1. `VISION.md`
2. `ROADMAP.md`
3. `CONTRIBUTING.md`

Fetch with `gh api repos/{owner}/{repo}/contents/<file>`.

Examples:

```bash
gh api repos/owner/repo/contents/VISION.md --jq .content | base64 --decode
# fallback
gh api repos/owner/repo/contents/ROADMAP.md --jq .content | base64 --decode
# fallback
gh api repos/owner/repo/contents/CONTRIBUTING.md --jq .content | base64 --decode
```

If none exist, skip vision scoring and note it.

For each PR/issue, score `vision_alignment` (0-100):

- Does it support stated goals?
- Is it the right priority tier?
- Is scope consistent with roadmap constraints?

If clearly misaligned:

- add `out-of-scope` label
- leave explanation comment

Example:

```text
This appears misaligned with current project direction in <VISION/ROADMAP/CONTRIBUTING>:
- Goal mismatch: ...
- Priority mismatch: ...
- Scope tradeoff: ...

Recommend moving this to a separate proposal/discussion thread.
```

---

## 5) Deep Review Enhancement (Diff-Native)

Do not rely on metadata alone. For candidate PRs, analyze actual diff content (`gh pr diff`).

Evaluate and score:

- `correctness_risk` (0 low risk → 100 high risk)
- `test_adequacy` (0 poor → 100 strong)
- `scope_creep` (0 tight → 100 sprawling)
- `complexity` (0 simple → 100 complex)
- `quality` (overall 0-100)

Signals to inspect in diffs:

- architectural consistency
- error handling and edge cases
- API contract changes and migration risk
- test updates near changed logic
- unsafe shortcuts / TODO debt / commented-out code
- broad refactors hidden inside “small fixes”

Use native reasoning and explain scores briefly, with concrete evidence.

---

## 6) Ranking + Canonical Selection

Within each duplicate cluster, rank PRs/issues and select canonical thread.

Suggested weighted output:

- CI health
- review outcomes
- deep diff risk profile
- test adequacy
- scope discipline
- freshness/activity
- bot review outcomes
- vision alignment

Return concise per-item summary:

- strengths
- blockers
- why canonical or why duplicate-candidate

---

## 7) Merged Fix Cleanup (Required)

When a PR is merged and closes issue `#X`, find remaining open duplicate PRs linked to the same issue/cluster.

If duplicates are now stale (fix already landed), auto-close them in cron mode:

```bash
gh pr close <dup_pr> --repo owner/repo --comment "Closing as stale duplicate: issue #<X> was resolved by merged PR #<winner>."
```

Also update cache status to `stale-duplicate-closed`.

Safety rule:

- Auto-close only when confidence is high and merged canonical clearly resolves the same issue.
- Otherwise, comment + label and escalate for human confirmation.

---

## 8) Action Mode

If user asks for apply mode (or cron config enables it):

### PR actions

```bash
gh pr comment <pr> --repo owner/repo --body "This overlaps with #<winner>. Recommend consolidating there."
gh pr edit <pr> --repo owner/repo --add-label duplicate-candidate
```

Optional close (or required stale cleanup from merged fix logic):

```bash
gh pr close <pr> --repo owner/repo --comment "Closing as duplicate of #<winner>."
```

### Issue actions

```bash
gh issue comment <issue> --repo owner/repo --body "This overlaps with #<canonical>."
gh issue edit <issue> --repo owner/repo --add-label duplicate-candidate
```

### Vision misalignment actions

```bash
gh pr edit <pr> --repo owner/repo --add-label out-of-scope
gh pr comment <pr> --repo owner/repo --body "Potentially out of scope relative to <doc>."

gh issue edit <issue> --repo owner/repo --add-label out-of-scope
gh issue comment <issue> --repo owner/repo --body "Potentially out of scope relative to <doc>."
```

---

## 9) Scale Patterns for 3000+ Item Repos

1. Use search pre-filters (`updated:>=...`, `is:open`, `is:pr`, labels).
2. Process in batches of 100.
3. Default to last 7 days for historical closed/merged scans.
4. Always incremental after bootstrap.
5. Recompute only impacted clusters (changed items + neighbors from cache index).
6. Avoid fetching full diffs for unchanged PRs.

---

## 10) Cron Runbook (Primary Use Case)

Every 15 minutes:

1. Load cache for `owner/repo`.
2. Fetch PRs/issues updated since `last_incremental_scan`.
3. Enrich only changed/new items.
4. Re-run clustering only where impacted.
5. Execute configured actions (comment/label/close).
6. Perform merged-fix stale duplicate cleanup.
7. Write cache atomically.
8. Emit concise run summary.

If cache file is missing/corrupt:

- rebuild bootstrap cache
- continue incremental cadence on next run

---

## 11) Output Contract

For every run, report:

- repo + mode (bootstrap/incremental)
- scan window (`since` timestamp)
- counts: fetched PRs/issues, unchanged skipped, clusters touched
- duplicate clusters with confidence and canonical selection
- scoring highlights (`quality`, `correctness_risk`, `test_adequacy`, `scope_creep`, `complexity`, `vision_alignment`)
- actions taken (comments/labels/closes)
- stale duplicates auto-closed due to merged fixes
- cache path written
- failures (exact command + error)

Keep output brief, actionable, and maintainer-focused.
