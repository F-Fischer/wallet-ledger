---
layout: page
title: Live demo
sidebar: false
aside: false
---

<div class="demo-intro">
  <p>
    Every button is a real call to this deployment's API. Create two wallets, deposit, settle,
    transfer, then press <strong>Replay</strong> in the HTTP log: same <code>Idempotency-Key</code>,
    marked <em>replayed</em>, no money moves.
    <a href="/demo-app.html" target="_blank" rel="noopener">Open full screen ↗</a>
  </p>
</div>

<iframe class="demo-frame" src="/demo-app.html" title="Wallet Ledger demo"></iframe>

<style>
.demo-intro {
  max-width: 1400px;
  margin: 0 auto;
  padding: 16px 24px 8px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.demo-frame {
  display: block;
  width: 100%;
  /* the nav bar is --vp-nav-height tall; leave room for the intro line */
  height: calc(100vh - var(--vp-nav-height) - 72px);
  min-height: 600px;
  border: 0;
  border-top: 1px solid var(--vp-c-divider);
}
</style>
