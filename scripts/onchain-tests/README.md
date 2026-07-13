# On-Chain Test Scripts

These scripts are manual local tools for testnet experiments. They are not CI,
release, or deployment checks.

## Empty Execution Benchmark

`empty-execution-benchmark.mjs` compares:

- Host-sponsored empty user PTBs: the user wallet has the settlement token
  only, and the Host appends Stelis settlement.
- Direct empty SUI PTBs: the same wallet is later funded with a small SUI
  amount and pays gas directly.

Setup:

```sh
cp scripts/onchain-tests/.env.example scripts/onchain-tests/.env
```

Fill `scripts/onchain-tests/.env` with a disposable test wallet key. The actual
`.env` file is local-only and must not be committed.

Check the wallet and selected settlement token balance before submitting any
transaction:

```sh
node scripts/onchain-tests/empty-execution-benchmark.mjs
```

This prints the SUI balance and the balance for the settlement token selected
by `STELIS_ONCHAIN_SETTLEMENT_TOKEN_SYMBOL` or
`STELIS_ONCHAIN_SETTLEMENT_TOKEN_TYPE`. It also prints whether the wallet has a
User Vault and the current User Vault credit. It does not submit a transaction
unless `--execute` is present.

Execute the sponsored phase:

```sh
node scripts/onchain-tests/empty-execution-benchmark.mjs --execute --phase sponsored --max-runs 100
```

The sponsored phase exits before submitting any transaction if the selected
settlement token balance is zero or below
`STELIS_ONCHAIN_MIN_SETTLEMENT_TOKEN_RAW`.
`STELIS_ONCHAIN_SLIPPAGE_BPS` configures prepare slippage tolerance (default
200, maximum 500). Set `STELIS_ONCHAIN_REQUIRE_ZERO_SUI_FOR_SPONSORED=true` to
make the script reject a sponsored run whenever the test wallet holds SUI.

If the Relay API returns a rate-limit response, the script waits for the
provided retry interval and retries the same prepare or sponsor step. Rate-limit
waits do not count as submitted runs.

After externally funding the same wallet with a small amount of SUI, execute the
direct phase:

```sh
node scripts/onchain-tests/empty-execution-benchmark.mjs --execute --phase direct --max-runs 100
```

The direct phase exits before submitting any transaction if the SUI balance is
below `STELIS_ONCHAIN_DIRECT_GAS_BUDGET_MIST` or at/below
`STELIS_ONCHAIN_MIN_SUI_RESERVE_MIST`.

After each direct submission, the script waits until the transaction can be read
back from the Sui client before starting the next run. If the client still
returns a digest that was already recorded in the same direct run, the script
retries the same run number instead of counting the duplicate as a submitted
transaction.

When `--execute` is present, the script creates a timestamped raw JSONL file
before submitting any transaction. Every submitted transaction is recorded with
the network, mode, execution kind, Stelis package ID, executed package ID,
transaction digest, whether events were available, event types, and gas fields
needed to compare direct gas overhead and Host recovery.

Sponsored runs are split by the `/prepare` settlement profile:

- `vault_create`: the transaction creates a User Vault and settles through the
  configured settlement swap path. Treat this as setup cost.
- `vault_top_up`: the transaction uses an existing User Vault but still settles
  through the configured settlement swap path. Report this separately from
  direct empty-transaction overhead.
- `vault_credit_use`: the transaction uses existing User Vault credit without a
  settlement-token swap. This is the sponsored run type compared against direct
  empty SUI transactions.

Raw JSONL files are written locally for detailed inspection, and the script
prints the raw file path after each run. Processed Markdown summaries are
appended to a fixed report file named after this benchmark. The report adds one
summary section per run and includes the test date, network, Stelis package ID,
mode, run counts, starting balances, sponsored flow breakdown, and summary
metrics.
