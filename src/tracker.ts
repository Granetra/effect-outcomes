import { OperationConflictError } from './errors.js';
import { fingerprintInput } from './json.js';
import type { Claim, ClaimResult, Evidence, JsonValue, Operation, OperationInput, OperationStore, Reconciliation } from './types.js';

export class EffectOutcomes {
  constructor(
    private readonly store: OperationStore,
    private readonly now: () => number = Date.now,
  ) {}

  async get(operation: OperationInput): Promise<Operation | undefined> {
    const { key, fingerprint } = await this.identity(operation);
    const current = await this.store.get(key);
    if (current && current.fingerprint !== fingerprint) {
      throw new OperationConflictError(key);
    }
    return current;
  }

  async prepare(operation: OperationInput): Promise<Operation> {
    const { key, fingerprint } = await this.identity(operation);
    return this.store.prepare(key, fingerprint);
  }

  async claim(operation: OperationInput): Promise<ClaimResult> {
    const { key, fingerprint } = await this.identity(operation);
    const id = crypto.randomUUID();
    const current = await this.store.claim(key, fingerprint, id, this.now());
    switch (current.state) {
      case 'claimed':
        return current.claimId === id
          ? { kind: 'claimed', claim: { key, fingerprint, id } }
          : { kind: 'already_claimed', claimedAt: current.claimedAt };
      case 'confirmed_success':
        return { kind: 'replay_success', result: current.result, evidence: current.evidence };
      case 'confirmed_no_effect':
        return { kind: 'replay_no_effect', failure: current.failure, evidence: current.evidence };
      case 'unknown':
        return { kind: 'unknown', reason: current.reason, recordedAt: current.recordedAt };
      case 'created':
        throw new Error('Store did not atomically claim the created operation');
    }
  }

  confirmSuccess(claim: Claim, result: JsonValue, evidence: Evidence): Promise<Operation> {
    return this.store.confirmSuccess(claim, result, evidence);
  }

  /** Only call when evidence proves the effect could not have occurred. */
  confirmNoEffect(claim: Claim, failure: JsonValue, evidence: Evidence): Promise<Operation> {
    return this.store.confirmNoEffect(claim, failure, evidence);
  }

  markUnknown(claim: Claim, reason: string): Promise<Operation> {
    return this.store.markUnknown(claim, reason, this.now());
  }

  async recoverStaleClaim(operation: OperationInput, olderThanMs: number, reason: string): Promise<Operation | undefined> {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new RangeError('olderThanMs must be a finite nonnegative number');
    }
    const { key, fingerprint } = await this.identity(operation);
    const now = this.now();
    return this.store.recoverStaleClaim(key, fingerprint, now - olderThanMs, reason, now);
  }

  async reconcileUnknown(operation: OperationInput, resolution: Reconciliation): Promise<Operation> {
    const { key, fingerprint } = await this.identity(operation);
    return this.store.reconcile(key, fingerprint, resolution);
  }

  private async identity(operation: OperationInput): Promise<{ key: string; fingerprint: string }> {
    if (typeof operation?.key !== 'string' || operation.key.trim() === '' || operation.key !== operation.key.trim()) {
      throw new TypeError('Operation key must be a nonempty string without surrounding whitespace');
    }
    return { key: operation.key, fingerprint: await fingerprintInput(operation.input) };
  }
}
