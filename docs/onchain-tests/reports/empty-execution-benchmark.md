# Empty Execution Benchmark Report

## Current Summary

This report summarizes manual empty-transaction benchmark runs on Sui testnet.
It compares direct SUI-paid empty transactions with Host-sponsored empty
transactions that use existing User Vault credit. User Vault creation is reported
separately because it includes one-time setup work.

## Network and Contracts

- Network: Sui testnet
- Stelis package ID: `0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738`
- VaultRegistry object: `0x2eb04cf3625fb68d2d6c452952b24989f1aa8be4a1f72235c1d791267197459f`
- Config object: `0xb727aa48b94e4710c13d527963460e44e3ab0973e341c4892fed8559e29d015c`
- Settlement token: DEEP
- Settlement token type:
  `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP`

## Current Benchmark Result

| Execution kind                                      | Count |                      Gas |
| --------------------------------------------------- | ----: | -----------------------: |
| Direct empty SUI transaction                        |   150 |  0.001009880 SUI average |
| Sponsored empty transaction using User Vault credit |   117 |  0.002012092 SUI average |
| User Vault creation                                 |     1 | 0.007208060 SUI measured |

The repeated sponsored path added about 0.001002212 SUI of gas over the direct
empty transaction baseline in this test set.

This should be read as fixed settlement overhead for this empty transaction
shape, not as a proportional gas multiplier. For real app transactions, the app
PTB work adds its own gas cost; the settlement overhead should be evaluated as an
added component on top of that app transaction.

## Host Recovery

For User Vault credit-use runs, the observed Host margin was 0.000100000 SUI per
transaction. The average recovered amount charged to the user's vault credit was
0.002112092 SUI:

- 0.002012092 SUI average paid gas
- 0.000100000 SUI configured Host margin

Under this tested configuration, the Host recovered the paid gas plus the
configured margin on repeated User Vault credit-use transactions.

## User Vault Creation

User Vault creation is not part of the repeated empty-transaction overhead
comparison. It is a setup transaction and should be reported separately.

The measured User Vault creation transaction was:

- Digest: `CesHefDJFsgXEipkQmK6zbmWvicG5YLtAKqwZBYN4J6`
- Total gas fee: 0.007208060 SUI
- Computation fee: 0.001000000 SUI
- Storage fee: 0.073058800 SUI
- Storage rebate: -0.066850740 SUI
- Non-refundable storage fee: 0.000675260 SUI

Compared with the repeated User Vault credit-use average, the one-time creation
transaction cost about 0.005195968 SUI more. Compared with the direct empty SUI
transaction average, it cost about 0.006198180 SUI more.

## Scope and Limits

- These are testnet measurements for the package and config listed above.
- The direct comparison uses only sponsored `User Vault credit use` runs.
- User Vault creation and settlement-token top-up runs include additional setup
  or swap work and are not direct empty-transaction overhead.
- Testnet liquidity and gas behavior can change over time.

## Run 2026-06-21T09:22:45.450Z

- Test date: 2026-06-21T09:22:45.450Z
- Completed at: 2026-06-21T09:22:49.364Z
- Network: testnet
- Stelis package ID: `0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738`
- Mode: sponsored
- Settlement token: DEEP
- Settlement token type: `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP`

## Test Counts

- Sponsored submitted: 0 / 100
- Direct submitted: 0 / 20

## Starting Balances

- SUI: 0.000000000 SUI
- DEEP: 10.000000 (10000000 raw)

## Summary

- Average sponsored gas: n/a
- Average direct gas: n/a
- Average extra gas vs direct: n/a
- Average Host margin: n/a
- Average sponsored user total cost: n/a
- Average settlement token spent: n/a
- Sponsored stop: before submission
- Direct stop: n/a

## Interpretation Fields

- `gasMist`: actual on-chain gas paid for the submitted transaction.
- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.
- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.

## Run 2026-06-21T09:46:45.607Z

- Test date: 2026-06-21T09:46:45.607Z
- Completed at: 2026-06-21T09:46:49.680Z
- Network: testnet
- Stelis package ID: `0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738`
- Mode: sponsored
- Settlement token: DEEP
- Settlement token type: `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP`

## Test Counts

- Sponsored submitted: 0 / 100
- Direct submitted: 0 / 20

## Starting Balances

- SUI: 0.000000000 SUI
- DEEP: 10.000000 (10000000 raw)

## Summary

- Average sponsored gas: n/a
- Average direct gas: n/a
- Average extra gas vs direct: n/a
- Average Host margin: n/a
- Average sponsored user total cost: n/a
- Average settlement token spent: n/a
- Sponsored stop: before submission
- Direct stop: n/a

## Interpretation Fields

- `gasMist`: actual on-chain gas paid for the submitted transaction.
- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.
- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.

## Run 2026-06-21T09:49:16.517Z

- Test date: 2026-06-21T09:49:16.517Z
- Completed at: 2026-06-21T09:49:21.121Z
- Network: testnet
- Stelis package ID: `0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738`
- Mode: sponsored
- Settlement token: DEEP
- Settlement token type: `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP`

## Test Counts

- Sponsored submitted: 0 / 100
- Direct submitted: 0 / 20

## Starting Balances

- SUI: 0.000000000 SUI
- DEEP: 10.000000 (10000000 raw)

## Summary

- Average sponsored gas: n/a
- Average direct gas: n/a
- Average extra gas vs direct: n/a
- Average Host margin: n/a
- Average sponsored user total cost: n/a
- Average settlement token spent: n/a
- Sponsored stop: before submission
- Direct stop: n/a

## Interpretation Fields

- `gasMist`: actual on-chain gas paid for the submitted transaction.
- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.
- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.

## Run 2026-06-21T10:06:25.063Z

- Test date: 2026-06-21T10:06:25.063Z
- Completed at: 2026-06-21T10:06:29.242Z
- Network: testnet
- Stelis package ID: `0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738`
- Mode: sponsored
- Settlement token: DEEP
- Settlement token type: `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP`

## Test Counts

- Sponsored submitted: 0 / 100
- Direct submitted: 0 / 20

## Starting Balances

- SUI: 0.000000000 SUI
- DEEP: 10.000000 (10000000 raw)

## Summary

- Average sponsored gas: n/a
- Average direct gas: n/a
- Average extra gas vs direct: n/a
- Average Host margin: n/a
- Average sponsored user total cost: n/a
- Average settlement token spent: n/a
- Sponsored stop: before submission
- Direct stop: n/a

## Interpretation Fields

- `gasMist`: actual on-chain gas paid for the submitted transaction.
- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.
- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.

## Run 2026-06-21T10:48:04.179Z

- Test date: 2026-06-21T10:48:04.179Z
- Completed at: 2026-06-21T10:52:54.338Z
- Network: testnet
- Stelis package ID: `0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738`
- Mode: sponsored
- Settlement token: DEEP
- Settlement token type: `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP`

## Test Counts

- Sponsored submitted: 97 / 100
- Direct submitted: 0 / 20

## Sponsored Flow Breakdown

### User Vault create + token-funded settlement

- Flow key: `vault_create`
- Submitted: 0
- Average gas: n/a
- Average Host margin: n/a
- Interpretation: Creates the User Vault and settles through the configured settlement swap path. Treat as setup cost, not direct empty-transaction overhead.

### User Vault top-up + token-funded settlement

- Flow key: `vault_top_up`
- Submitted: 0
- Average gas: n/a
- Average Host margin: n/a
- Interpretation: Uses an existing User Vault but still settles through the configured settlement swap path. Report separately from direct empty-transaction overhead.

### User Vault credit use

- Flow key: `vault_credit_use`
- Submitted: 97
- Average gas: 0.002012092 SUI
- Average Host margin: 0.000100000 SUI
- Interpretation: Uses existing User Vault credit without a settlement-token swap. This is the sponsored path compared against direct empty SUI transactions.

## Starting Balances

- SUI: 0.000000000 SUI
- DEEP: 1.000000 (1000000 raw)

## Summary

- Average sponsored gas (all flows): 0.002012092 SUI
- Average sponsored gas (User Vault credit use only): 0.002012092 SUI
- Average direct gas: n/a
- Average extra gas vs direct: n/a
- Direct comparison basis: User Vault credit use only
- Average Host margin: 0.000100000 SUI
- Average sponsored user total cost: 0.002112092 SUI
- Average settlement token spent: 0.000000 DEEP
- Sponsored stop: before submission
- Direct stop: n/a

## Interpretation Fields

- `gasMist`: actual on-chain gas paid for the submitted transaction.
- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.
- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.
- Direct gas overhead is compared only against `vault_credit_use` runs. `vault_create` and `vault_top_up` include User Vault setup or settlement-token swap work and are reported separately.

## Run 2026-06-21T11:27:33.643Z

- Test date: 2026-06-21T11:27:33.643Z
- Completed at: 2026-06-21T11:28:39.066Z
- Network: testnet
- Stelis package ID: `0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738`
- Mode: direct
- Settlement token: DEEP
- Settlement token type: `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP`

## Test Counts

- Sponsored submitted: 0 / 100
- Direct submitted: 50 / 100
- Direct duplicate digest retries: 50

## Sponsored Flow Breakdown

- Sponsored phase was not run.

## Starting Balances

- SUI: 0.500000000 SUI
- DEEP: 1.000000 (1000000 raw)
- User Vault: present
- User Vault credit: 0.002077176 SUI (2077176 MIST)

## Summary

- Average sponsored gas (all flows): n/a
- Average sponsored gas (User Vault credit use only): n/a
- Average direct gas: 0.001009880 SUI
- Average extra gas vs direct: n/a
- Direct comparison basis: User Vault credit use only
- Average Host margin: n/a
- Average sponsored user total cost: n/a
- Average settlement token spent: n/a
- Sponsored stop: n/a
- Direct stop: n/a

## Interpretation Fields

- `gasMist`: actual on-chain gas paid for the submitted transaction.
- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.
- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.
- Direct gas overhead is compared only against `vault_credit_use` runs. `vault_create` and `vault_top_up` include User Vault setup or settlement-token swap work and are reported separately.

## Run 2026-06-21T11:54:35.694Z

- Test date: 2026-06-21T11:54:35.694Z
- Completed at: 2026-06-21T11:57:12.308Z
- Network: testnet
- Stelis package ID: `0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738`
- Mode: direct
- Settlement token: DEEP
- Settlement token type: `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP`

## Test Counts

- Sponsored submitted: 0 / 100
- Direct submitted: 100 / 100
- Direct duplicate digest retries: 0

## Sponsored Flow Breakdown

- Sponsored phase was not run.

## Starting Balances

- SUI: 0.449506000 SUI
- DEEP: 1.000000 (1000000 raw)
- User Vault: present
- User Vault credit: 0.002077176 SUI (2077176 MIST)

## Summary

- Average sponsored gas (all flows): n/a
- Average sponsored gas (User Vault credit use only): n/a
- Average direct gas: 0.001009880 SUI
- Average extra gas vs direct: n/a
- Direct comparison basis: User Vault credit use only
- Average Host margin: n/a
- Average sponsored user total cost: n/a
- Average settlement token spent: n/a
- Sponsored stop: n/a
- Direct stop: n/a

## Interpretation Fields

- `gasMist`: actual on-chain gas paid for the submitted transaction.
- `hostMarginMist`: `executionCostClaimMist + hostFeeMist - gasMist`.
- `hostMarginMist >= 0` means the Host recovered at least the paid gas for that run.
- Direct gas overhead is compared only against `vault_credit_use` runs. `vault_create` and `vault_top_up` include User Vault setup or settlement-token swap work and are reported separately.
