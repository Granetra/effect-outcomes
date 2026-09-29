import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import {
  ClaimOwnershipError, EffectOutcomes, OperationConflictError,
  PostgresOperationStore, TransitionError,
} from '../dist/index.js';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL test database');
}

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
const schema = await readFile(new URL('../schema/001_operations.sql', import.meta.url), 'utf8');
await pool.query(schema);
const keys = [];
const operation = (suffix) => {
  const key = `effect-outcomes-test:${randomUUID()}:${suffix}`;
  keys.push(key);
  return { key, input: { amount: 1200, currency: 'USD' } };
};
const tracker = new EffectOutcomes(new PostgresOperationStore(pool));

function worker(op) {
  const child = spawn(process.execPath, [new URL('./postgres-worker.mjs', import.meta.url).pathname, JSON.stringify(op)], {
    env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let error = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { error += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker did not become ready')), 10_000);
    const check = () => {
      if (output.includes('ready\n')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => {
      if (!output.includes('ready\n')) {
        clearTimeout(timeout);
        reject(new Error(`Worker exited early (${code}): ${error}`));
      }
    });
    check();
  });
  const completed = new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited (${code}): ${error}`));
      else resolve(JSON.parse(output.trim().split('\n').at(-1)));
    });
  });
  return { ready, completed, start: () => child.stdin.end('go\n'), stop: () => child.kill() };
}

test('separate processes contend for one claim and replay the durable result', async () => {
  const op = operation('race');
  const workers = Array.from({ length: 8 }, () => worker(op));
  try {
    await Promise.all(workers.map((item) => item.ready));
    workers.forEach((item) => item.start());
    const decisions = await Promise.all(workers.map((item) => item.completed));
    assert.equal(decisions.filter((item) => item.kind === 'claimed').length, 1);
    assert.equal(decisions.filter((item) => item.kind === 'already_claimed').length, 7);
    const claim = decisions.find((item) => item.kind === 'claimed').claim;
    const evidence = { basis: 'provider response', details: null };
    await tracker.confirmSuccess(claim, null, evidence);

    const anotherPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      const restarted = new EffectOutcomes(new PostgresOperationStore(anotherPool));
      assert.deepEqual(await restarted.claim(op), { kind: 'replay_success', result: null, evidence });
      await assert.rejects(restarted.confirmSuccess(claim, true, evidence), ClaimOwnershipError);
      await assert.rejects(restarted.prepare({ ...op, input: { amount: 1300 } }), OperationConflictError);
    } finally {
      await anotherPool.end();
    }
  } finally {
    workers.forEach((item) => item.stop());
  }
});

test('stale claims remain unknown across restart until explicit reconciliation', async () => {
  const op = operation('recovery');
  let now = 1000;
  const timed = new EffectOutcomes(new PostgresOperationStore(pool), () => now);
  assert.equal((await timed.prepare(op)).state, 'created');
  const first = await timed.claim(op);
  assert.equal(first.kind, 'claimed');
  now = 1100;
  assert.equal((await timed.recoverStaleClaim(op, 100, 'worker interrupted')).state, 'unknown');

  const anotherPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  try {
    const restarted = new EffectOutcomes(new PostgresOperationStore(anotherPool));
    assert.equal((await restarted.claim(op)).kind, 'unknown');
    await assert.rejects(restarted.markUnknown(first.claim, 'late response'), ClaimOwnershipError);
    await restarted.reconcileUnknown(op, {
      kind: 'no_effect', failure: { code: 'provider-confirmed-absent' },
      evidence: { basis: 'provider lookup', details: { reference: 'missing' } },
    });
    assert.equal((await restarted.claim(op)).kind, 'replay_no_effect');
    await assert.rejects(restarted.reconcileUnknown(op, {
      kind: 'success', result: true, evidence: { basis: 'late lookup' },
    }), TransitionError);
  } finally {
    await anotherPool.end();
  }
});

test('competing terminal transitions accept exactly one owner', async () => {
  const op = operation('terminal');
  const claimed = await tracker.claim(op);
  assert.equal(claimed.kind, 'claimed');
  const contender = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  try {
    const other = new EffectOutcomes(new PostgresOperationStore(contender));
    const outcomes = await Promise.allSettled([
      tracker.confirmSuccess(claimed.claim, { id: 'one' }, { basis: 'response one' }),
      other.confirmNoEffect(claimed.claim, { code: 'two' }, { basis: 'response two' }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason instanceof ClaimOwnershipError).length, 1);
    assert.match((await tracker.get(op)).state, /^confirmed_/);
  } finally {
    await contender.end();
  }
});

test.after(async () => {
  try {
    await pool.query('DELETE FROM public.effect_outcomes_operations WHERE key = ANY($1::text[])', [keys]);
  } finally {
    await pool.end();
  }
});
