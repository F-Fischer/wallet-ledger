# Effort scale

Effort is estimated as a **size relative to work already shipped in this repo**, not in days. Plans
used to carry calendar estimates ("3–4 days", "2 weeks") written before any code existed; the only
one that can be checked, the ledger foundation, was built in two working sessions rather than "3–4 days of one engineer", but its commits can't say how many hours those sessions were. Comparing a new
task to a finished one is a judgement too, but one anyone can check.

## The scale

A size covers everything needed to merge: code, tests, the feature page, a `money-reviewer` pass
when money moves, and checking the preview deployment.

| Size | Reference (already merged) | What it looks like |
|---|---|---|
| **XS** | [#6](https://github.com/F-Fischer/wallet-ledger/pull/6): stop awaiting `bootstrap()` on Vercel | One file, one focused change, no money logic |
| **S** | [#5](https://github.com/F-Fischer/wallet-ledger/pull/5): prepare the app for Vercel + Neon | A few files; configuration or one simple flow; no money, or trivial money |
| **M** | [#4](https://github.com/F-Fischer/wallet-ledger/pull/4): the demo web page; the load simulator | A complete new surface with e2e tests, **or** one money flow with its edge cases |
| **L** | [#1](https://github.com/F-Fischer/wallet-ledger/pull/1): the ledger foundation | Several new money flows, locking and concurrency, many tests, money review required |
| **XL** | — | Bigger than the foundation: split it before starting |

`L−` / `M+` are allowed when a task clearly sits between two references.

## What pushes a task up a size

- It moves money (any new journal shape), especially money that can be partly covered (splits
  between `available` and `receivable`).
- It has to be correct under concurrency or retries (new locks, duplicate or out-of-order events).
- It adds a new kind of surface: the first webhook endpoint, the first scheduled job, the first
  external integration.
- It changes behaviour other features rely on (the ledger, idempotency, the transaction host).

## What keeps it down

- It reuses an existing pattern unchanged (a new deposit-like flow, another admin endpoint).
- It's documentation or configuration only.

## Calibration log

Each merged task records its estimated size and what it actually took, so the scale can be
corrected. "Took" is what can be checked afterwards: commits, review rounds, and surprises (a case
the plan didn't foresee, a fix after review, a platform issue found only in the preview).

| PR | Task | Estimated | Took | Surprises | Verdict |
|---|---|---|---|---|---|
| [#1](https://github.com/F-Fischer/wallet-ledger/pull/1) | Ledger foundation | 3–4 days of one engineer (calendar estimate, before this scale) | 4 commits in two working sessions: implementation and feature page on the day the plan was written, review fixes 12 days later; defines **L** | the money review found a lock-order deadlock risk and a double-refund race | reference |
| [#4](https://github.com/F-Fischer/wallet-ledger/pull/4) | Demo web page | — | Defines **M** | double-submit guard added after review | reference |
| [#5](https://github.com/F-Fischer/wallet-ledger/pull/5) | Vercel + Neon | — | Defines **S** | migrations had to move to the build step | reference |
| [#6](https://github.com/F-Fischer/wallet-ledger/pull/6) | `await bootstrap()` deadlock | — | Defines **XS** | only reproducible on Vercel | reference |
| [#7](https://github.com/F-Fischer/wallet-ledger/pull/7) | Docs site | — | M | Mermaid plugin preloaded ~50 chunks; broken anchors; missing sidebar | sized after the fact |

When a size is consistently wrong for one kind of task (say, every money-moving **M** takes as long
as an **L**), the scale's description changes, not just the next estimate.
