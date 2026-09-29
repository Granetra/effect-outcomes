import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClaimOwnershipError,
  EffectOutcomes,
  InMemoryOperationStore,
  OperationConflictError,
  TransitionError,
  fingerprintInput,
} from '../dist/index.js';

const input = { key: 'refund:order-1', input: { amount: 1200, currency: 'USD' } };
const evidence = { basis: 'provider response', details: { reference: 'refund-42' } };

test('canonical fingerprints ignore object key order and distinguish array order', async () => {
  assert.equal(await fingerprintInput({ a: 1, b: [2, 3] }), await fingerprintInput({ b: [2, 3], a: 1 }));
  assert.notEqual(await fingerprintInput([1, 2]), await fingerprintInput([2, 1]));
  assert.match(await fingerprintInput({ a: 1 }), /^sha256-json-v1:[0-9a-f]{64}$/);
  await assert.rejects(fingerprintInput({ bad: Number.NaN }), TypeError);
  await assert.rejects(fingerprintInput(new Date()), TypeError);
  await assert.rejects(fingerprintInput([, 1]), TypeError);
});

test('a key is bound to its input before and after completion', async () => {
  const tracker = new EffectOutcomes(new InMemoryOperationStore());
  assert.equal((await tracker.prepare(input)).state, 'created');
  await assert.rejects(tracker.claim({ ...input, input: { amount: 1300, currency: 'USD' } }), OperationConflictError);
  const first = await tracker.claim(input);
  assert.equal(first.kind, 'claimed');
  await tracker.confirmSuccess(first.claim, { id: 'refund-42' }, evidence);
  await assert.rejects(tracker.prepare({ ...input, input: { amount: 1300, currency: 'USD' } }), OperationConflictError);
  await assert.rejects(tracker.get({ ...input, input: { amount: 1300, currency: 'USD' } }), OperationConflictError);
});

test('concurrent claim attempts grant one caller and replay a confirmed result', async () => {
  const tracker = new EffectOutcomes(new InMemoryOperationStore());
  const [one, two] = await Promise.all([tracker.claim(input), tracker.claim(input)]);
  assert.deepEqual([one.kind, two.kind].sort(), ['already_claimed', 'claimed']);
  const winner = one.kind === 'claimed' ? one : two;
  const result = { id: 'refund-42' };
  const responseEvidence = { basis: 'provider response', details: { reference: 'refund-42' } };
  await tracker.confirmSuccess(winner.claim, result, responseEvidence);
  result.id = 'mutated';
  responseEvidence.details.reference = 'mutated';
  const replay = await tracker.claim(input);
  assert.equal(replay.kind, 'replay_success');
  assert.deepEqual(replay.result, { id: 'refund-42' });
  assert.deepEqual(replay.evidence.details, { reference: 'refund-42' });
  replay.result.id = 'changed';
  assert.deepEqual((await tracker.claim(input)).result, { id: 'refund-42' });
  await assert.rejects(tracker.markUnknown(winner.claim, 'late timeout'), ClaimOwnershipError);
});

test('confirmed absence is terminal and replays its failure', async () => {
  const tracker = new EffectOutcomes(new InMemoryOperationStore());
  const claimed = await tracker.claim(input);
  await tracker.confirmNoEffect(claimed.claim, { code: 'validation_rejected' }, { basis: 'rejected before dispatch' });
  assert.deepEqual(await tracker.claim(input), {
    kind: 'replay_no_effect',
    failure: { code: 'validation_rejected' },
    evidence: { basis: 'rejected before dispatch' },
  });
  await assert.rejects(
    tracker.reconcileUnknown(input, { kind: 'success', result: true, evidence: { basis: 'late query' } }),
    TransitionError,
  );
});

test('unknown blocks redispatch until explicit evidence resolves it', async () => {
  const tracker = new EffectOutcomes(new InMemoryOperationStore());
  const claimed = await tracker.claim(input);
  await tracker.markUnknown(claimed.claim, 'provider response lost');
  assert.equal((await tracker.claim(input)).kind, 'unknown');
  await assert.rejects(tracker.confirmSuccess(claimed.claim, true, evidence), ClaimOwnershipError);
  await tracker.reconcileUnknown(input, {
    kind: 'success',
    result: { id: 'refund-42' },
    evidence: { basis: 'provider lookup by operation key' },
  });
  assert.equal((await tracker.claim(input)).kind, 'replay_success');
});

test('reconciliation can confirm no effect, but cannot resolve a second time', async () => {
  const tracker = new EffectOutcomes(new InMemoryOperationStore());
  const claimed = await tracker.claim(input);
  await tracker.markUnknown(claimed.claim, 'lookup required');
  await tracker.reconcileUnknown(input, {
    kind: 'no_effect',
    failure: { code: 'not_submitted' },
    evidence: { basis: 'provider confirmed no submission' },
  });
  assert.equal((await tracker.claim(input)).kind, 'replay_no_effect');
  await assert.rejects(
    tracker.reconcileUnknown(input, { kind: 'success', result: true, evidence }),
    TransitionError,
  );
});

test('stale claims become unknown and cannot be completed by the old owner', async () => {
  let time = 1000;
  const tracker = new EffectOutcomes(new InMemoryOperationStore(), () => time);
  const claimed = await tracker.claim(input);
  time = 1099;
  assert.equal((await tracker.recoverStaleClaim(input, 100, 'worker lost')).state, 'claimed');
  time = 1100;
  assert.equal((await tracker.recoverStaleClaim(input, 100, 'worker lost')).state, 'unknown');
  assert.equal((await tracker.claim(input)).kind, 'unknown');
  await assert.rejects(tracker.confirmSuccess(claimed.claim, true, evidence), ClaimOwnershipError);
});

test('claim ownership and evidence are checked before terminal transitions', async () => {
  const tracker = new EffectOutcomes(new InMemoryOperationStore());
  const claimed = await tracker.claim(input);
  await assert.rejects(tracker.confirmSuccess({ ...claimed.claim, id: 'wrong' }, true, evidence), ClaimOwnershipError);
  await assert.rejects(tracker.confirmNoEffect(claimed.claim, false, { basis: ' ' }), TypeError);
  assert.equal((await tracker.get(input)).state, 'claimed');
  await tracker.confirmSuccess(claimed.claim, true, evidence);
  await assert.rejects(tracker.confirmSuccess(claimed.claim, true, evidence), ClaimOwnershipError);
});

test('operation keys and stale thresholds are validated', async () => {
  const tracker = new EffectOutcomes(new InMemoryOperationStore());
  await assert.rejects(tracker.claim({ key: ' refund:order-1', input: true }), TypeError);
  await assert.rejects(tracker.claim({ key: '', input: true }), TypeError);
  await assert.rejects(tracker.recoverStaleClaim(input, -1, 'worker lost'), RangeError);
});
