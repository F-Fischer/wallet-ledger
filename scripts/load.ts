/**
 * Load simulator: fires many concurrent, conflicting requests at a running
 * API and then checks that no money was lost or created.
 *
 *   node scripts/load.ts --url http://localhost:3000 --requests 2000 --concurrency 100
 *
 * What it does:
 *   1. Creates `--wallets` wallets and funds each with `--start-cents` (deposit + settle).
 *   2. Sends `--requests` operations, `--concurrency` at a time, picked at random:
 *      - transfers between the same few wallets, in both directions (lock contention,
 *        deadlock risk) and often larger than the sender's balance (insufficient_funds);
 *      - holds that are then released (80%) or captured (20%; capture moves money out);
 *      - the same request sent twice in parallel with one Idempotency-Key (must
 *        execute once and return the same response twice).
 *   3. Checks the invariants: no 5xx responses, no negative balance, money is
 *      conserved (wallet totals + captured = funded), every duplicate pair got
 *      identical responses, and /admin/reconciliation is ok.
 *
 * Exits with code 1 if any invariant fails. No dependencies: Node 22.18+ runs this
 * file directly (type stripping) and uses the built-in fetch.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export interface LoadOptions {
  baseUrl: string;
  wallets: number;
  startCents: number;
  requests: number;
  concurrency: number;
  /** Largest transfer/hold amount; above startCents / wallets it overdraws often. */
  maxAmountCents: number;
  seed: number;
}

export interface OpStats {
  count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}

export interface LoadReport {
  run_id: string;
  duration_ms: number;
  requests_per_second: number;
  ops: Record<string, OpStats>;
  /** e.g. { "201": 812, "422 insufficient_funds": 190 } */
  outcomes: Record<string, number>;
  checks: {
    no_server_errors: boolean;
    no_negative_balances: boolean;
    money_conserved: boolean;
    duplicates_consistent: boolean;
    reconciliation_ok: boolean;
  };
  totals: { funded_cents: number; in_wallets_cents: number; captured_cents: number };
  /** Up to 3 duplicate pairs whose responses differed, for debugging. */
  duplicate_mismatches: { first: Res; second: Res }[];
  ok: boolean;
}

export const DEFAULT_OPTIONS: LoadOptions = {
  baseUrl: 'http://localhost:3000',
  wallets: 5,
  startCents: 100_000,
  requests: 2_000,
  concurrency: 100,
  maxAmountCents: 30_000,
  seed: 42,
};

export interface Res {
  status: number;
  body: any;
}

/** Small seeded PRNG so a run can be reproduced with --seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON with sorted keys: replayed bodies come from jsonb, so key order may differ. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, i)] * 10) / 10;
}

export async function runLoad(partial: Partial<LoadOptions> = {}): Promise<LoadReport> {
  const opts: LoadOptions = { ...DEFAULT_OPTIONS, ...partial };
  const base = opts.baseUrl.replace(/\/$/, '');
  const rand = mulberry32(opts.seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const amount = () => 1 + Math.floor(rand() * opts.maxAmountCents);

  const runId = `${Date.now().toString(36)}${Math.floor(rand() * 1e6).toString(36)}`;
  const owners = Array.from({ length: opts.wallets }, (_, i) => `load-${runId}-${i}`);

  const latencies: Record<string, number[]> = {};
  const outcomes: Record<string, number> = {};
  let serverErrors = 0;
  let capturedCents = 0;
  const duplicateMismatches: { first: Res; second: Res }[] = [];

  async function call(op: string, method: string, path: string, body?: object, key?: string): Promise<Res> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = key ?? randomUUID();
    const t0 = performance.now();
    const res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    (latencies[op] ??= []).push(performance.now() - t0);
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const label = res.status < 300 ? String(res.status) : `${res.status} ${parsed?.error?.code ?? ''}`.trim();
    outcomes[label] = (outcomes[label] ?? 0) + 1;
    if (res.status >= 500) serverErrors++;
    return { status: res.status, body: parsed };
  }

  async function mustOk(res: Promise<Res>, what: string): Promise<any> {
    const r = await res;
    if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  // 1. Setup: fund every wallet.
  for (const owner of owners) {
    await mustOk(call('setup', 'POST', '/wallets', { owner }), `create wallet ${owner}`);
    const dep = await mustOk(
      call('setup', 'POST', `/wallets/${owner}/deposits`, { amount_cents: opts.startCents }),
      'deposit',
    );
    await mustOk(call('setup', 'POST', `/deposits/${dep.id}/settle`), 'settle');
  }

  // 2. The storm.
  const transfer = () => {
    const from = pick(owners);
    let to = pick(owners);
    while (to === from) to = pick(owners);
    return call('transfer', 'POST', '/transfers', { from, to, amount_cents: amount() });
  };

  const holdLifecycle = async () => {
    const owner = pick(owners);
    const hold = await call('hold', 'POST', `/wallets/${owner}/holds`, { amount_cents: amount() });
    if (hold.status !== 201) return;
    if (rand() < 0.2) {
      const r = await call('capture', 'POST', `/holds/${hold.body.id}/capture`);
      if (r.status === 200) capturedCents += hold.body.amount_cents;
    } else {
      await call('release', 'POST', `/holds/${hold.body.id}/release`);
    }
  };

  const duplicateTransfer = async () => {
    const from = pick(owners);
    let to = pick(owners);
    while (to === from) to = pick(owners);
    const body = { from, to, amount_cents: amount() };
    const key = randomUUID();
    const [a, b] = await Promise.all([
      call('duplicate', 'POST', '/transfers', body, key),
      call('duplicate', 'POST', '/transfers', body, key),
    ]);
    if (a.status !== b.status || canonical(a.body) !== canonical(b.body)) {
      duplicateMismatches.push({ first: a, second: b });
    }
  };

  const ops = Array.from({ length: opts.requests }, () => {
    const r = rand();
    return r < 0.7 ? transfer : r < 0.9 ? holdLifecycle : duplicateTransfer;
  });

  const started = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, ops.length) }, async () => {
      while (next < ops.length) {
        await ops[next++]();
      }
    }),
  );
  const durationMs = performance.now() - started;

  // 3. Verify.
  let inWallets = 0;
  let negative = false;
  for (const owner of owners) {
    const w = await mustOk(call('verify', 'GET', `/wallets/${owner}`), `get wallet ${owner}`);
    for (const k of ['available_cents', 'pending_cents', 'held_cents'] as const) {
      if (w[k] < 0) negative = true;
      inWallets += w[k];
    }
  }
  const recon = await mustOk(call('verify', 'GET', '/admin/reconciliation'), 'reconciliation');

  const funded = opts.wallets * opts.startCents;
  const checks = {
    no_server_errors: serverErrors === 0,
    no_negative_balances: !negative,
    money_conserved: inWallets + capturedCents === funded,
    duplicates_consistent: duplicateMismatches.length === 0,
    reconciliation_ok: recon.ok === true,
  };

  const opStats: Record<string, OpStats> = {};
  for (const [op, xs] of Object.entries(latencies)) {
    if (op === 'setup' || op === 'verify') continue;
    const sorted = [...xs].sort((x, y) => x - y);
    opStats[op] = {
      count: sorted.length,
      p50_ms: percentile(sorted, 50),
      p95_ms: percentile(sorted, 95),
      p99_ms: percentile(sorted, 99),
      max_ms: percentile(sorted, 100),
    };
  }
  const stormRequests = Object.values(opStats).reduce((n, s) => n + s.count, 0);

  return {
    run_id: runId,
    duration_ms: Math.round(durationMs),
    requests_per_second: Math.round((stormRequests / durationMs) * 1000),
    ops: opStats,
    outcomes,
    checks,
    totals: { funded_cents: funded, in_wallets_cents: inWallets, captured_cents: capturedCents },
    duplicate_mismatches: duplicateMismatches.slice(0, 3),
    ok: Object.values(checks).every(Boolean),
  };
}

function parseArgs(argv: string[]): Partial<LoadOptions> {
  const flags: Record<string, keyof LoadOptions> = {
    '--url': 'baseUrl',
    '--wallets': 'wallets',
    '--start-cents': 'startCents',
    '--requests': 'requests',
    '--concurrency': 'concurrency',
    '--max-amount-cents': 'maxAmountCents',
    '--seed': 'seed',
  };
  const out: Record<string, string | number> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const field = flags[argv[i]];
    if (!field || argv[i + 1] === undefined) {
      throw new Error(`unknown or incomplete flag: ${argv[i]} (flags: ${Object.keys(flags).join(' ')})`);
    }
    out[field] = field === 'baseUrl' ? argv[i + 1] : Number(argv[i + 1]);
  }
  return out as Partial<LoadOptions>;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runLoad(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nPASS: all invariants held' : '\nFAIL: an invariant was broken');
  process.exitCode = report.ok ? 0 : 1;
}
