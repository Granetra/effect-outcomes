import { Pool } from 'pg';
import { EffectOutcomes, PostgresOperationStore } from '../dist/index.js';

const operation = JSON.parse(process.argv[2]);
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });

process.stdout.write('ready\n');
process.stdin.once('data', async () => {
  try {
    const decision = await new EffectOutcomes(new PostgresOperationStore(pool)).claim(operation);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
});
