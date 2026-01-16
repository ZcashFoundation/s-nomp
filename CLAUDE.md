# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

S-NOMP (Some New Open Mining Portal) is a Zcash Equihash mining pool forked for Zebra testnet mining. This fork on the `zebra-mining` branch has NU5-related fixes that disable pool/miner payments—all rewards go to the node's configured address.

**Requirements:** Node.js v8.11 (locked in .nvmrc), Redis 2.6+

## Commands

```bash
# Install (requires Node 8.11)
nvm use 8.11.0  # or: nodenv local 8.11.0
export CXXFLAGS="-std=gnu++17"
npm update && npm install

# Run
npm start
```

The start script sets `LD_LIBRARY_PATH` for native equihashverify modules.

## Architecture

The pool runs as a clustered Node.js app with forked worker processes:

```
init.js (master)
├── PoolWorker     - Stratum server handling miner connections
├── PaymentProcessor - Payout processing (disabled for NU5)
├── Website        - Express web UI & stats API
├── ProfitSwitch   - Multi-pool switching logic
└── CliListener    - IPC command interface
```

Workers receive config via environment variables (`pools`, `portalConfig` as JSON).

## Configuration

Two-level config system:
- `config.json` - Portal-wide settings (Redis, website, clustering, CLI)
- `pool_configs/{coin}.json` - Per-coin settings (daemon RPC, ports, difficulty, vardiff)

Copy from `config_example.json` and `pool_configs/examples/` to get started.

## Key Modules (libs/)

| Module | Purpose |
|--------|---------|
| `poolWorker.js` | Stratum server, share submission |
| `shareProcessor.js` | Records shares to Redis by block height |
| `paymentProcessor.js` | Payout calculations, daemon RPC |
| `stats.js` | Real-time pool statistics |
| `website.js` | Express server, API endpoints |

## Difficulty Note

Pool difficulty is scaled: 1 difficulty = 8192, 0.125 difficulty = 1024. Shares are accumulated by this multiplier.

## Block Notification

Two modes:
1. **blocknotify script**: Daemon calls `node scripts/cli.js blocknotify {coin} %s`
2. **Polling**: Fallback via `blockRefreshInterval` (default 500ms)

## Redis Data

Shares stored as `{coin}:{block_height}` with miner addresses and difficulty counts.
