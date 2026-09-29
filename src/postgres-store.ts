import type { Pool, QueryResultRow } from 'pg';
import { ClaimOwnershipError, OperationConflictError, TransitionError } from './errors.js';
import { canonicalJson } from './json.js';
import type { Claim, Evidence, JsonValue, Operation, OperationStore, Reconciliation } from './types.js';

interface OperationRow extends QueryResultRow {
  key: string;
  fingerprint: string;
  state: Operation['state'];
  claim_id: string | null;
  claimed_at: number | null;
  result: JsonValue | null;
  failure: JsonValue | null;
  evidence_basis: string | null;
  evidence_details: JsonValue | null;
  evidence_has_details: boolean;
  reason: string | null;
  recorded_at: number | null;
}

function operationFromRow(row: OperationRow): Operation {
  const base = { key: row.key, fingerprint: row.fingerprint };
  switch (row.state) {
    case 'created':
      return { ...base, state: 'created' };
    case 'claimed':
      return { ...base, state: 'claimed', claimId: row.claim_id!, claimedAt: row.claimed_at! };
    case 'unknown':
      return { ...base, state: 'unknown', reason: row.reason!, recordedAt: row.recorded_at! };
    case 'confirmed_success':
      return { ...base, state: 'confirmed_success', result: row.result!, evidence: evidenceFromRow(row) };
    case 'confirmed_no_effect':
      return { ...base, state: 'confirmed_no_effect', failure: row.failure!, evidence: evidenceFromRow(row) };
  }
}

function evidenceFromRow(row: OperationRow): Evidence {
  return row.evidence_has_details
    ? { basis: row.evidence_basis!, details: row.evidence_details }
    : { basis: row.evidence_basis! };
}

function evidenceValues(evidence: Evidence): [string, string | null, boolean] {
  if (typeof evidence?.basis !== 'string' || evidence.basis.trim() === '') {
    throw new TypeError('Evidence basis must be a nonempty string');
  }
  const hasDetails = evidence.details !== undefined;
  return [evidence.basis, hasDetails ? canonicalJson(evidence.details!) : null, hasDetails];
}

function requireReason(reason: string): void {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new TypeError('Unknown outcome reason must be a nonempty string');
  }
}

function requireFiniteTime(value: number): void {
  if (!Number.isFinite(value)) throw new RangeError('Operation time must be finite');
}

/** A durable OperationStore using one atomic statement for each state change. */
export class PostgresOperationStore implements OperationStore {
  /** The caller owns the pool and its lifecycle. Apply schema/001_operations.sql first. */
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<Operation | undefined> {
    const { rows } = await this.pool.query<OperationRow>(
      'SELECT * FROM public.effect_outcomes_operations WHERE key = $1', [key],
    );
    return rows[0] && operationFromRow(rows[0]);
  }

  async prepare(key: string, fingerprint: string): Promise<Operation> {
    const { rows } = await this.pool.query<OperationRow>(
      `INSERT INTO public.effect_outcomes_operations (key, fingerprint, state)
       VALUES ($1, $2, 'created') ON CONFLICT (key) DO NOTHING RETURNING *`,
      [key, fingerprint],
    );
    if (rows[0]) return operationFromRow(rows[0]);
    return this.existing(key, fingerprint);
  }

  async claim(key: string, fingerprint: string, claimId: string, claimedAt: number): Promise<Operation> {
    requireFiniteTime(claimedAt);
    const { rows } = await this.pool.query<OperationRow>(
      `INSERT INTO public.effect_outcomes_operations (key, fingerprint, state, claim_id, claimed_at)
       VALUES ($1, $2, 'claimed', $3, $4)
       ON CONFLICT (key) DO UPDATE SET
         state = 'claimed', claim_id = EXCLUDED.claim_id, claimed_at = EXCLUDED.claimed_at
       WHERE effect_outcomes_operations.fingerprint = EXCLUDED.fingerprint
         AND effect_outcomes_operations.state = 'created'
       RETURNING *`,
      [key, fingerprint, claimId, claimedAt],
    );
    if (rows[0]) return operationFromRow(rows[0]);
    return this.existing(key, fingerprint);
  }

  async confirmSuccess(claim: Claim, result: JsonValue, evidence: Evidence): Promise<Operation> {
    const payload = canonicalJson(result);
    const [basis, details, hasDetails] = evidenceValues(evidence);
    return this.finishClaim(claim, 'confirmed_success', payload, basis, details, hasDetails);
  }

  async confirmNoEffect(claim: Claim, failure: JsonValue, evidence: Evidence): Promise<Operation> {
    const payload = canonicalJson(failure);
    const [basis, details, hasDetails] = evidenceValues(evidence);
    return this.finishClaim(claim, 'confirmed_no_effect', payload, basis, details, hasDetails);
  }

  async markUnknown(claim: Claim, reason: string, recordedAt: number): Promise<Operation> {
    requireReason(reason);
    requireFiniteTime(recordedAt);
    const { rows } = await this.pool.query<OperationRow>(
      `UPDATE public.effect_outcomes_operations SET
         state = 'unknown', claim_id = NULL, claimed_at = NULL,
         reason = $4, recorded_at = $5
       WHERE key = $1 AND fingerprint = $2 AND state = 'claimed' AND claim_id = $3
       RETURNING *`,
      [claim.key, claim.fingerprint, claim.id, reason, recordedAt],
    );
    if (rows[0]) return operationFromRow(rows[0]);
    return this.unowned(claim);
  }

  async recoverStaleClaim(
    key: string, fingerprint: string, claimedBefore: number, reason: string, recordedAt: number,
  ): Promise<Operation | undefined> {
    requireReason(reason);
    requireFiniteTime(claimedBefore);
    requireFiniteTime(recordedAt);
    const { rows } = await this.pool.query<OperationRow>(
      `UPDATE public.effect_outcomes_operations SET
         state = 'unknown', claim_id = NULL, claimed_at = NULL,
         reason = $3, recorded_at = $4
       WHERE key = $1 AND fingerprint = $2 AND state = 'claimed' AND claimed_at <= $5
       RETURNING *`,
      [key, fingerprint, reason, recordedAt, claimedBefore],
    );
    return rows[0] ? operationFromRow(rows[0]) : this.matched(key, fingerprint);
  }

  async reconcile(key: string, fingerprint: string, resolution: Reconciliation): Promise<Operation> {
    const [basis, details, hasDetails] = evidenceValues(resolution.evidence);
    let state: 'confirmed_success' | 'confirmed_no_effect';
    let payload: string;
    switch (resolution.kind) {
      case 'success':
        state = 'confirmed_success';
        payload = canonicalJson(resolution.result);
        break;
      case 'no_effect':
        state = 'confirmed_no_effect';
        payload = canonicalJson(resolution.failure);
        break;
      default:
        throw new TypeError('Invalid reconciliation result');
    }
    const { rows } = await this.pool.query<OperationRow>(
      `UPDATE public.effect_outcomes_operations SET
         state = $3, reason = NULL, recorded_at = NULL,
         result = CASE WHEN $3 = 'confirmed_success' THEN $4::jsonb ELSE NULL END,
         failure = CASE WHEN $3 = 'confirmed_no_effect' THEN $4::jsonb ELSE NULL END,
         evidence_basis = $5, evidence_details = $6::jsonb, evidence_has_details = $7
       WHERE key = $1 AND fingerprint = $2 AND state = 'unknown'
       RETURNING *`,
      [key, fingerprint, state, payload, basis, details, hasDetails],
    );
    if (rows[0]) return operationFromRow(rows[0]);
    const current = await this.matched(key, fingerprint);
    throw new TransitionError(key, current?.state ?? 'missing', 'reconcile');
  }

  private async finishClaim(
    claim: Claim, state: 'confirmed_success' | 'confirmed_no_effect', payload: string,
    basis: string, details: string | null, hasDetails: boolean,
  ): Promise<Operation> {
    const { rows } = await this.pool.query<OperationRow>(
      `UPDATE public.effect_outcomes_operations SET
         state = $4, claim_id = NULL, claimed_at = NULL,
         result = CASE WHEN $4 = 'confirmed_success' THEN $5::jsonb ELSE NULL END,
         failure = CASE WHEN $4 = 'confirmed_no_effect' THEN $5::jsonb ELSE NULL END,
         evidence_basis = $6, evidence_details = $7::jsonb, evidence_has_details = $8
       WHERE key = $1 AND fingerprint = $2 AND state = 'claimed' AND claim_id = $3
       RETURNING *`,
      [claim.key, claim.fingerprint, claim.id, state, payload, basis, details, hasDetails],
    );
    if (rows[0]) return operationFromRow(rows[0]);
    return this.unowned(claim);
  }

  private async matched(key: string, fingerprint: string): Promise<Operation | undefined> {
    const current = await this.get(key);
    if (current && current.fingerprint !== fingerprint) throw new OperationConflictError(key);
    return current;
  }

  private async existing(key: string, fingerprint: string): Promise<Operation> {
    const current = await this.matched(key, fingerprint);
    if (!current) throw new Error(`Operation ${JSON.stringify(key)} disappeared after a key conflict`);
    return current;
  }

  private async unowned(claim: Claim): Promise<never> {
    await this.matched(claim.key, claim.fingerprint);
    throw new ClaimOwnershipError(claim.key);
  }
}
