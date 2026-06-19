# On-Chain Settlement

The Move package lives under [`packages/contracts/move`](../../packages/contracts/move).

## Modules

| Module | Purpose |
| --- | --- |
| `config.move` | Stores config values, admin authority, pause state, and fee caps |
| `vault.move` | Owns user vault and vault registry behavior |
| `settle.move` | Settlement and swap-and-settle entry points |
| `events.move` | Events emitted by config and settlement operations |

## Settlement Entry Points

The TypeScript allowlist in `@stelis/contracts` currently includes:

- `swap_and_settle_new_user_bfq`
- `swap_and_settle_with_vault_bfq`
- `swap_and_settle_new_user_qfb`
- `swap_and_settle_with_vault_qfb`
- `settle_with_credit`

The `_bfq` and `_qfb` suffixes are Move entry-name suffixes for the public settlement swap directions `baseForQuote` and `quoteForBase`.
HTTP responses, schema values, SDK types, and app configuration use the full direction names.

The relay validates that a sponsored settlement transaction contains one allowed settlement call.

## User Vaults

User vaults are owned objects. Users can withdraw directly through the vault module even when relay infrastructure is not available.

## DeepBook Fee Model

Settlement swap paths use DeepBook pools. Path data comes from the `NETWORK` section in `packages/app-api/settlement-swap-paths.json`, and the API host derives path details from on-chain pool data at boot.

Leftover payment coin is returned to the sender in swap variants. Settlement surplus is credited to the user's vault balance.
