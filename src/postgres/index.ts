import { Pool, type PoolClient } from 'pg';
import type { Records, Storage, Transaction } from '../core/index.js';

export { Pool } from 'pg';

/** One namespace per installation; account tables remain entirely application-owned. */
export class PostgresStorage implements Storage {
  constructor(
    readonly pool: Pool,
    readonly namespace = 'verity',
  ) {
    if (!namespace) throw new Error('Storage namespace required');
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      // IF NOT EXISTS does not make CREATE TABLE safe to race: two workers starting on a new
      // database both create the table's row type, and one fails. The table is shared by
      // every namespace, so the lock is one of its own rather than the namespace's.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('verity migrate', 0))");

      await client.query(`CREATE TABLE IF NOT EXISTS verity_records (
        namespace text NOT NULL, kind text NOT NULL, id text NOT NULL, value jsonb NOT NULL,
        PRIMARY KEY (namespace, kind, id)
      )`);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');

      throw error;
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      // Serialize installation writes, including callback claims and share rotation across workers.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.namespace]);
      const result = await work(this.operations(client));

      await client.query('COMMIT');

      return result;
    } catch (error) {
      await client.query('ROLLBACK');

      throw error;
    } finally {
      client.release();
    }
  }

  private operations(client: PoolClient): Transaction {
    const namespace = this.namespace;

    return {
      async get<K extends keyof Records>(kind: K, id: string) {
        const result = await client.query(
          'SELECT value FROM verity_records WHERE namespace=$1 AND kind=$2 AND id=$3',
          [namespace, kind, id],
        );

        return result.rows[0]?.value as Records[K] | undefined;
      },
      async put(kind, id, value) {
        await client.query(
          `INSERT INTO verity_records(namespace,kind,id,value) VALUES($1,$2,$3,$4)
          ON CONFLICT(namespace,kind,id) DO UPDATE SET value=EXCLUDED.value`,
          [namespace, kind, id, JSON.stringify(value)],
        );
      },
      async delete(kind, id) {
        await client.query('DELETE FROM verity_records WHERE namespace=$1 AND kind=$2 AND id=$3', [
          namespace,
          kind,
          id,
        ]);
      },
      async list<K extends keyof Records>(kind: K) {
        const result = await client.query(
          'SELECT value FROM verity_records WHERE namespace=$1 AND kind=$2',
          [namespace, kind],
        );

        return result.rows.map((row) => row.value as Records[K]);
      },
    };
  }
}
