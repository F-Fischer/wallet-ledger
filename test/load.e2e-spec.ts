import { AddressInfo } from 'node:net';
import { runLoad } from '../scripts/load.js';
import { TestContext, createTestContext } from './helpers.js';

describe('load simulator (e2e)', () => {
  let ctx: TestContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.app.listen(0);
    const { port } = ctx.app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterAll(() => ctx.app.close());

  it('keeps every invariant under concurrent, conflicting requests', async () => {
    const report = await runLoad({ baseUrl, wallets: 3, requests: 300, concurrency: 30 });

    expect(report.duplicate_mismatches).toEqual([]);
    expect(report.checks).toEqual({
      no_server_errors: true,
      no_negative_balances: true,
      money_conserved: true,
      duplicates_consistent: true,
      reconciliation_ok: true,
    });
    // The run must actually exercise contention, not only happy paths.
    expect(report.outcomes['201']).toBeGreaterThan(0);
    expect(report.outcomes['422 insufficient_funds']).toBeGreaterThan(0);
    expect(report.ops.duplicate.count).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
  });
});
