# Effect Outcomes

Effect Outcomes is a TypeScript library for recording what is known about consequential external actions. It is intended for AI-driven applications and backend systems that call payment providers, account services, and other systems where repeating an action can have real consequences.

An external system may complete an action while the caller loses its response. After a timeout or crash, the caller cannot safely infer whether the action happened. Retrying blindly can duplicate it; treating the timeout as a failure can hide a completed action.

The library associates each logical operation with a stable, trusted key and an input fingerprint. It records confirmed success, confirmed absence of an effect, or an unknown outcome. Reusing a key with different input is a conflict. An unknown outcome requires explicit, evidence-based reconciliation before the operation can be treated as resolved. Provider-specific lookup and reconciliation will live behind adapters or callbacks.

The project does **not** promise exactly-once execution. It will not automatically retry an action with an unknown external outcome.

## Status

Phases 1–3 are complete. The library has an in-memory store and a PostgreSQL store with atomic claims and transitions, persistent outcomes, and evidence. Two phases remain: Phase 4 defines explicit provider reconciliation, and Phase 5 prepares for the v0.1 release decision. The package remains private at version `0.0.0`.

See the [project roadmap](docs/EFFECT_OUTCOMES_ROADMAP.md) for the state model, implementation phases, open questions, and current status.

## Development

Node.js 22 or newer and npm are required.

```sh
npm ci
npm run typecheck
npm test
# With a disposable PostgreSQL database:
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/effect_outcomes_test npm run test:postgres
```

The build writes ESM JavaScript and TypeScript declarations to `dist/`.

## API

```ts
import { EffectOutcomes, InMemoryOperationStore } from '@granetra/effect-outcomes';

const outcomes = new EffectOutcomes(new InMemoryOperationStore());
const operation = {
  key: 'refund:order-123', // Stable business identity; reuse it on every attempt.
  input: { amount: 1200, currency: 'USD' },
};

const decision = await outcomes.claim(operation);
if (decision.kind === 'claimed') {
  let response;
  try {
    response = { kind: 'received', result: await paymentProvider.refund(operation.input) } as const;
  } catch (error) {
    // A thrown error alone does not prove that the provider did nothing.
    response = { kind: 'missing' } as const;
  }
  if (response.kind === 'received') {
    await outcomes.confirmSuccess(decision.claim, response.result, { basis: 'provider response' });
  } else {
    await outcomes.markUnknown(decision.claim, 'provider response unavailable');
  }
}
// Other decisions: already_claimed, unknown, replay_success, replay_no_effect.
```

`prepare` records an operation before a claim; `claim` also creates and claims it atomically if it does not exist. `confirmNoEffect` requires caller-supplied evidence that the effect could not have occurred. `recoverStaleClaim` changes an old active claim to `unknown`; elapsed time never grants a new dispatch. `reconcileUnknown` explicitly records a supported success or no-effect conclusion. Confirmed outcomes are terminal for that key, including confirmed no-effect outcomes.

## PostgreSQL store

Apply [schema/001_operations.sql](schema/001_operations.sql) once to the database before constructing the store. The migration creates `effect_outcomes_operations` and enforces the state shape in PostgreSQL. Give the application role permission to select, insert, and update the table. Use a shared `pg` pool for concurrent calls and close it during application shutdown.

For local development with Docker, start PostgreSQL 18 with a named volume so its data persists across container restarts. PostgreSQL 18's official image stores its data under `/var/lib/postgresql` ([image documentation](https://hub.docker.com/_/postgres)):

```sh
docker run --name effect-outcomes-db \
  -e POSTGRES_USER=effect_user \
  -e POSTGRES_PASSWORD=local_dev_password \
  -e POSTGRES_DB=effect_outcomes \
  -p 5432:5432 \
  -v effect-outcomes-pgdata:/var/lib/postgresql \
  -d postgres:18
```

Apply the migration from the repository root, then set the connection string for the app:

```sh
docker exec -i effect-outcomes-db psql -U effect_user -d effect_outcomes < schema/001_operations.sql
export DATABASE_URL='postgresql://effect_user:local_dev_password@localhost:5432/effect_outcomes'
```

Use `docker stop effect-outcomes-db` and `docker start effect-outcomes-db` to stop and restart this local database. The PostgreSQL integration tests apply the migration to their test database automatically.

```ts
import { Pool } from 'pg';
import { EffectOutcomes, PostgresOperationStore } from '@granetra/effect-outcomes';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const outcomes = new EffectOutcomes(new PostgresOperationStore(pool));
```

The store uses a primary key and conditional PostgreSQL statements so only one worker can claim a key or complete a given claim. It records evidence and unknown outcomes in the table. A process that stops after dispatch but before confirmation leaves a `claimed` row; after an application-chosen age, call `recoverStaleClaim` to move it to `unknown` for investigation. Never treat a database write error as proof the provider did nothing. Configure PostgreSQL durability, backups, and pool size for your deployment.

Inputs, results, failures, and evidence details must be JSON values with finite numbers. Input fingerprints are SHA-256 hashes of canonical JSON with sorted object keys and ordered arrays, tagged `sha256-json-v1`. A fingerprint does not encrypt low-entropy or sensitive input; callers should avoid putting secrets in operation input. The library stores the fingerprint, not the original input. Evidence is supplied and assessed by the application; the core does not verify provider claims.

## License

Apache-2.0. See [LICENSE](LICENSE).
