# Effect Outcomes roadmap

This document is the project's source of truth for scope, architecture, decisions, status, and the next implementation step. Update it whenever meaningful implementation work, architectural decisions, or test results change.

## Purpose and problem

Effect Outcomes aims to help TypeScript applications track the outcome of consequential external actions. A payment refund, account change, or other external effect can complete while the caller loses the response through a timeout, network failure, or process interruption. The caller then has an ambiguous outcome: a retry might duplicate the effect, while assuming failure might conceal a successful action.

The library should persist the identity and known outcome of each logical operation, prevent conflicting reuse of its key, and give callers a safe path to investigate uncertainty.

## Non-goals

- Exactly-once execution or a guarantee that a provider will never perform a duplicate action.
- Automatic retry when the external outcome is unknown.
- A universal provider query or a claim that every provider can be reconciled conclusively.
- A dashboard, workflow engine, policy engine, approvals interface, billing system, or agent runtime.
- Framework-specific integrations in the core package.

## Architectural principles

1. A caller supplies a stable, trusted key for each logical operation. The key must derive from business identity, not from a fresh value generated on every attempt.
2. The same key and equivalent input refer to the same operation. A different input under that key is a conflict, including after completion.
3. Claiming an operation must be atomic in the durable store. Concurrent callers must not both acquire permission to dispatch the same effect.
4. A confirmed result is durable and can be replayed for the same key and input.
5. Lost responses and interrupted attempts are treated conservatively. An expired claim alone is not evidence that the external action did not happen.
6. Unknown outcomes remain durable until explicit reconciliation records evidence of success or absence of an effect.
7. Provider-specific dispatch and reconciliation belong behind narrow adapters or callbacks. The core owns operation identity, transitions, and persistence rules.
8. PostgreSQL is the likely first durable store. Storage boundaries should stay small enough to support another implementation later without weakening guarantees.

## Proposed state machine

The names and public API are provisional. These states describe durable facts about a logical operation, not a guarantee about provider behavior.

| State | Meaning |
| --- | --- |
| `created` | The key and input fingerprint are recorded; no claim is active. |
| `claimed` | One caller has permission to attempt the external action. |
| `confirmed_success` | Evidence confirms the effect occurred; the result is stored for replay. |
| `confirmed_no_effect` | Evidence confirms the effect did not occur; a failure result is stored for replay. |
| `unknown` | The action may have occurred; a fresh dispatch is unsafe without reconciliation. |

```text
created ──claim──> claimed ──confirmed response──> confirmed_success
                      ├──proven pre-dispatch failure──> confirmed_no_effect
                      └──lost response / uncertain interruption──> unknown
unknown ──evidence of effect──> confirmed_success
        └──evidence of no effect──> confirmed_no_effect
```

If reconciliation remains inconclusive, the operation stays `unknown`. A stale `claimed` operation must be treated as potentially dispatched and moved to `unknown` before any further action. A confirmed outcome is terminal for its key in the initial design; retry semantics after confirmed absence of an effect need an explicit decision before implementation. A later operation may use a new business key only when the application has evidence that doing so is safe.

## Roadmap phases

1. **Foundation:** package metadata, TypeScript build, documentation, and a bounded v0.1 design.
2. **Contract and in-memory model (complete):** define operation identity, input fingerprinting, transition rules, result types, and a storage interface; test conflicts, replay, and uncertain outcomes.
3. **PostgreSQL durability (complete):** schema, atomic claims and transitions, persisted evidence, and concurrent-process tests.
4. **Explicit reconciliation:** callback or adapter contract, evidence recording, and tests for conclusive and inconclusive findings.
5. **v0.1 readiness:** examples, API review, failure-mode tests, packaging checks, and a release decision based on demonstrated behavior.

## Decisions made

- The intended npm package name is `@granetra/effect-outcomes`.
- The core targets TypeScript and Node.js, uses ESM, and remains framework-neutral.
- A stable, trusted operation key and input comparison are required.
- Reuse of a key with different input is a conflict; confirmed results are replayed for matching input.
- Unknown outcomes are durable and are never retried automatically.
- Reconciliation must be explicit, evidence-based, and provider-specific through an adapter or callback.
- The project does not claim exactly-once execution.
- The package remains private and at version `0.0.0` until the v0.1 readiness review.
- Input equality uses canonical JSON with sorted object keys and ordered arrays, then SHA-256 under the version tag `sha256-json-v1`. Values outside JSON, nonfinite numbers, sparse arrays, and cyclic structures are rejected.
- Confirmed no-effect outcomes are terminal for their key in v0.1. A new action requires a new business key and an application decision that it is safe.
- Results, failures, and evidence details are JSON values. The core copies them at the in-memory store boundary so caller mutation cannot change recorded facts.
- Claim ownership uses a random claim ID. A stale claim is moved to `unknown` after an application-selected age; age alone never permits redispatch.
- Resolution evidence is caller supplied and must have a nonempty basis. Provider-specific verification remains a later phase.
- PostgreSQL uses one conditional statement per state change, with the operation key as the primary key. It does not keep a transaction open during an external call.
- The application owns a shared `pg` connection pool and applies the versioned schema migration before use. The library does not run migrations automatically.

## Current implementation status

Phases 1–3 are complete. Phase 3 is implemented and verified against a local PostgreSQL 18.4 server. The public module also exports `PostgresOperationStore`, backed by a constrained PostgreSQL table. Claims, claim completion, stale recovery, and reconciliation use conditional atomic statements. Results, failures, and evidence use JSONB; an explicit flag preserves the distinction between missing evidence details and JSON `null`. Phases 4 and 5 remain: explicit provider reconciliation, followed by v0.1 readiness and a release decision.

## Completed work

- Established the repository's initial package structure and Apache-2.0 licensing.
- Documented the problem, scope, proposed state machine, and path to v0.1.
- Implemented the Phase 2 contract, versioned input fingerprinting, in-memory state machine, and focused behavior tests.
- Added a PostgreSQL migration, durable store, usage guide, and integration tests that launch separate Node workers against one key.

## Tests completed

- `npm ci` completed from the lockfile.
- `npm run typecheck` and `npm run build` passed.
- `npm pack --dry-run` included the README, license, compiled entry point, and TypeScript declarations.

Phase 2: `npm run typecheck` and `npm test` passed. Nine behavior tests cover canonical fingerprints and invalid values, key conflicts, concurrent claims, result replay and isolation from mutation, terminal no-effect replay, unknown outcomes and both reconciliation conclusions, stale claim recovery, claim ownership, and key validation.

Phase 3: `npm run typecheck`, all nine in-memory tests, `npm pack --dry-run`, and all three PostgreSQL integration tests passed. The PostgreSQL tests ran against a disposable local PostgreSQL 18.4 server and covered eight separate processes contending for one claim, replay after a new pool, durable unknown recovery and reconciliation, and competing terminal transitions. To run them again, set `TEST_DATABASE_URL` to a disposable PostgreSQL database.

## Unresolved technical questions

- What exact boundary proves a failure occurred before dispatch, and how should an adapter present that proof?
- Which PostgreSQL deployment settings and operational monitoring are required for a production release?
- What evidence is sufficient to close an unknown outcome as `confirmed_no_effect` for providers with delayed visibility?
- What is the smallest useful provider adapter contract, including providers that support their own idempotency keys?

## Known risks

- A caller-supplied key that changes between attempts defeats deduplication; an untrusted or overly broad key can conflate different operations.
- Incorrect input fingerprinting can produce false replay or false conflict.
- A process can stop after dispatch but before recording success. Claim expiry cannot safely distinguish this from a never-dispatched attempt.
- Provider lookup can be delayed or incomplete. An absence of a record is not always proof that no effect happened.
- Database transactions cannot make an external provider call atomic with local persistence.

## Next recommended task

Define the explicit provider reconciliation callback or adapter contract in Phase 4, including what evidence can conclusively establish no effect after a lost response.
