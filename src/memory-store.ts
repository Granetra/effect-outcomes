import { ClaimOwnershipError, OperationConflictError, TransitionError } from './errors.js';
import { copyJson } from './json.js';
import type { Claim, Evidence, JsonValue, Operation, OperationStore, Reconciliation } from './types.js';

function copyEvidence(evidence: Evidence): Evidence {
  if (typeof evidence.basis !== 'string' || evidence.basis.trim() === '') {
    throw new TypeError('Evidence basis must be a nonempty string');
  }
  return evidence.details === undefined
    ? { basis: evidence.basis }
    : { basis: evidence.basis, details: copyJson(evidence.details) };
}

function copyOperation(operation: Operation): Operation {
  switch (operation.state) {
    case 'confirmed_success':
      return { ...operation, result: copyJson(operation.result), evidence: copyEvidence(operation.evidence) };
    case 'confirmed_no_effect':
      return { ...operation, failure: copyJson(operation.failure), evidence: copyEvidence(operation.evidence) };
    default:
      return { ...operation };
  }
}

/** A process-local reference implementation. It offers no durability across restarts. */
export class InMemoryOperationStore implements OperationStore {
  private readonly operations = new Map<string, Operation>();

  async get(key: string): Promise<Operation | undefined> {
    const operation = this.operations.get(key);
    return operation && copyOperation(operation);
  }

  async prepare(key: string, fingerprint: string): Promise<Operation> {
    const current = this.matched(key, fingerprint);
    if (current) return copyOperation(current);
    const created: Operation = { key, fingerprint, state: 'created' };
    this.operations.set(key, created);
    return copyOperation(created);
  }

  async claim(key: string, fingerprint: string, claimId: string, claimedAt: number): Promise<Operation> {
    const current = this.matched(key, fingerprint);
    if (current && current.state !== 'created') return copyOperation(current);
    const claimed: Operation = { key, fingerprint, state: 'claimed', claimId, claimedAt };
    this.operations.set(key, claimed);
    return copyOperation(claimed);
  }

  async confirmSuccess(claim: Claim, result: JsonValue, evidence: Evidence): Promise<Operation> {
    const current = this.ownedClaim(claim);
    const confirmed: Operation = {
      key: current.key,
      fingerprint: current.fingerprint,
      state: 'confirmed_success',
      result: copyJson(result),
      evidence: copyEvidence(evidence),
    };
    this.operations.set(claim.key, confirmed);
    return copyOperation(confirmed);
  }

  async confirmNoEffect(claim: Claim, failure: JsonValue, evidence: Evidence): Promise<Operation> {
    const current = this.ownedClaim(claim);
    const confirmed: Operation = {
      key: current.key,
      fingerprint: current.fingerprint,
      state: 'confirmed_no_effect',
      failure: copyJson(failure),
      evidence: copyEvidence(evidence),
    };
    this.operations.set(claim.key, confirmed);
    return copyOperation(confirmed);
  }

  async markUnknown(claim: Claim, reason: string, recordedAt: number): Promise<Operation> {
    const current = this.ownedClaim(claim);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new TypeError('Unknown outcome reason must be a nonempty string');
    }
    const unknown: Operation = {
      key: current.key,
      fingerprint: current.fingerprint,
      state: 'unknown',
      reason,
      recordedAt,
    };
    this.operations.set(claim.key, unknown);
    return copyOperation(unknown);
  }

  async recoverStaleClaim(
    key: string,
    fingerprint: string,
    claimedBefore: number,
    reason: string,
    recordedAt: number,
  ): Promise<Operation | undefined> {
    const current = this.matched(key, fingerprint);
    if (!current) return undefined;
    if (current.state !== 'claimed' || current.claimedAt > claimedBefore) return copyOperation(current);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new TypeError('Unknown outcome reason must be a nonempty string');
    }
    const unknown: Operation = { key, fingerprint, state: 'unknown', reason, recordedAt };
    this.operations.set(key, unknown);
    return copyOperation(unknown);
  }

  async reconcile(key: string, fingerprint: string, resolution: Reconciliation): Promise<Operation> {
    const current = this.matched(key, fingerprint);
    if (!current || current.state !== 'unknown') {
      throw new TransitionError(key, current?.state ?? 'missing', 'reconcile');
    }
    const evidence = copyEvidence(resolution.evidence);
    let confirmed: Operation;
    switch (resolution.kind) {
      case 'success':
        confirmed = { key, fingerprint, state: 'confirmed_success', result: copyJson(resolution.result), evidence };
        break;
      case 'no_effect':
        confirmed = { key, fingerprint, state: 'confirmed_no_effect', failure: copyJson(resolution.failure), evidence };
        break;
      default:
        throw new TypeError('Invalid reconciliation result');
    }
    this.operations.set(key, confirmed);
    return copyOperation(confirmed);
  }

  private matched(key: string, fingerprint: string): Operation | undefined {
    const current = this.operations.get(key);
    if (current && current.fingerprint !== fingerprint) throw new OperationConflictError(key);
    return current;
  }

  private ownedClaim(claim: Claim): Extract<Operation, { state: 'claimed' }> {
    const current = this.matched(claim.key, claim.fingerprint);
    if (!current || current.state !== 'claimed' || current.claimId !== claim.id) {
      throw new ClaimOwnershipError(claim.key);
    }
    return current;
  }
}
