# On-Chain Test Scripts

These scripts are manual local tools for testnet experiments. They are not CI,
release, or deployment checks.

## Empty Execution Benchmark

`empty-execution-benchmark.mjs` compares:

- Host-sponsored empty user PTBs: the Host appends Stelis settlement and funds
  gas. Depending on `/prepare`, funding can come from a settlement-token swap
  or existing User Vault credit.
- Direct empty SUI PTBs: the same disposable wallet pays gas directly. For
  `both`, the direct reserve must already exist before the process starts.

Setup:

```sh
cp scripts/onchain-tests/.env.example scripts/onchain-tests/.env
```

The script imports built workspace packages. After a fresh checkout, or after
changing one of those TypeScript workspace dependencies, run
`npm run build:onchain-benchmark` once before using it. This builds only the
contract, Relay-core, Host-core, and SDK authorities consumed by the script. Editing the
benchmark's `.mjs` files does not itself require that build, and a current build
does not need to be repeated for each benchmark run.

Fill `scripts/onchain-tests/.env` with a disposable test wallet key. The actual
`.env` file is local-only and must not be committed. Set
`STELIS_ONCHAIN_RELAY_API_URL` to the current testnet Host being measured; the
temporary demo deployment is not a durable benchmark target.
Copy one exact `settlementTokenType` from that Host's `/relay/config` into
`STELIS_ONCHAIN_SETTLEMENT_TOKEN_TYPE`. Symbols are display metadata and cannot
select token identity.

Only the CLI options and `STELIS_ONCHAIN_*` settings shown here and in
`.env.example` are accepted. Unknown names—including removed settings and
typos in the process environment—fail before any transaction work begins.

Check the wallet and selected settlement token balance before submitting any
transaction:

```sh
node scripts/onchain-tests/empty-execution-benchmark.mjs
```

This prints diagnostic SUI, exact settlement-token, and User Vault snapshots.
An unavailable diagnostic is shown as unavailable instead of being converted
to zero. It does not submit a transaction unless `--execute` is present.

Execute the sponsored phase:

```sh
node scripts/onchain-tests/empty-execution-benchmark.mjs --execute --phase sponsored --sponsored-max-runs 100
```

The Host `/prepare` result is the funding authority. A wallet with zero selected
settlement-token balance can still run `credit_general` when its User Vault
credit covers the current cost; the script does not apply a competing local
token-balance eligibility rule.
`STELIS_ONCHAIN_SLIPPAGE_BPS` configures prepare slippage tolerance (default
200, maximum 500). Set `STELIS_ONCHAIN_REQUIRE_ZERO_SUI_FOR_SPONSORED=true` to
make the script reject a sponsored run whenever the test wallet holds SUI.

The script retries only the current coded `RATE_LIMITED` response with a numeric
`retryAfterMs`. Quota and abuse responses are surfaced instead of being treated
as rate limits.

After externally funding the same wallet with a small amount of SUI, execute the
direct phase:

```sh
node scripts/onchain-tests/empty-execution-benchmark.mjs --execute --phase direct --direct-max-runs 100
```

The direct phase submits only when the SUI balance covers
`STELIS_ONCHAIN_MIN_SUI_RESERVE_MIST + STELIS_ONCHAIN_DIRECT_GAS_BUDGET_MIST`,
so the configured reserve remains after a full gas budget.

Before direct submission, the script derives the transaction digest. If a stale
RPC view builds a digest already recorded in this benchmark, it waits and
rebuilds without resubmitting that digest.

Before any submission, the script verifies that both the Host and the selected
Sui gRPC endpoint are the current testnet network. Mainnet is not a supported
surface of this benchmark.

The disposable wallet must be dedicated to this benchmark on one machine. The
tool keeps a machine-global wallet+chain journal under
`~/.stelis/onchain-tests/empty-execution-benchmark/`; changing checkout,
`STELIS_ONCHAIN_RAW_DIR`, Host URL, or settlement token does not bypass it. A
session lease is acquired before Host connection or `/prepare`, so two local
processes cannot start transaction work for the same wallet. The lock is a
non-empty directory containing `lease.json`; stale takeover moves that whole
directory to a lease-ID archive destination that cannot replace an existing
non-empty archive. Normal release uses the same move and retains the archive as
an identity tombstone. Therefore a delayed contender that inspected lease X
cannot rename newer live lease Y, whether X left through stale takeover or
normal release. Lease ownership is also bound to a live local
Unix-socket/named-pipe server rather than PID identity, so a reboot and later
PID reuse cannot turn a crashed process into a permanent false owner. Local
files cannot coordinate a second machine, which is why sharing the benchmark
wallet across machines or tools is unsupported.

When `--execute` is present, the script exclusively creates a raw JSONL file
whose run ID contains both a timestamp and a UUID. It writes a `run/started`
record and prints the raw path before any transaction work; an existing path is
never appended to as a new run. Sponsored Host preparation is recorded before
local signing. For every signed transaction, the durable journal first records
`ready`, the raw file is synced with an `attempt` row, and the journal moves to
`submission_started` before the network submit begins. Candidate digests only
grow. A definitive terminal transition is committed to immutable `resolved/`
history before its raw reporting row is appended. A power loss or reporting
failure therefore cannot leave a submitted transaction active merely because
the report projection failed. Markdown reports are also exclusively created.

The journal accepts closed execution events rather than a caller-selected
state/outcome pair. Submitted success or failure is derived from the matching
current Sui terminal kind. Pre-submission abandonment and a current Host
preflight rejection are explicit non-submitted outcomes, and only sponsored
attempts may use the latter. Host congestion is not proof that a signed
transaction was never submitted: it remains `submission_uncertain` until Sui
reconciliation proves every candidate terminal. A resolved filename and an
idempotent archive collision must match the entire normalized attempt record,
not only its attempt ID.

After the Host returns a sponsored transaction digest, the script calls the
current Sui SDK `waitForTransaction` method for that exact digest with effects
and events requested. This wait handles the interval between transaction
execution and availability through the read API; it never submits or rebuilds
the transaction. The wait result is only a readiness barrier. The benchmark's
strict current-effects and compiled `SettleEvent` validation remains the
authority for a verified success.

At the next invocation, recovery runs before Host connection, settlement-token
selection, or wallet snapshots. A `ready` attempt is safely archived because
submission had not started. A closed current Host preflight response can record
a sponsored non-submitted terminal outcome. Congestion, every reported
on-chain failure, and every uncertain/candidate-digest path is released only
when the current Sui terminal union proves the digest and terminal kind; Host
digest text is never a terminal proof. RPC failure, absence, malformed results,
or a digest mismatch leave the wallet blocked; there is no text acknowledgement
or force unlock. A successful recovery exits without starting a new benchmark,
so run the command again deliberately. Sui-proven terminal digests remain in
the journal and are also used to reject stale direct-transaction rebuilds after
a restart.

A balance-check invocation still acquires the same lease and may perform this
recovery, but it never submits a transaction. Generated JSONL is a report
projection; the machine journal is the durable execution-safety authority.

Sponsored success is counted only after all current boundaries agree:

- the exact Relay sponsor response shape;
- the prepared, sponsor-response, and terminal transaction digest;
- the normalized current Sui terminal outcome and successful effects status;
- exactly one compiled-schema `SettleEvent` bound to receipt ID, user, unique
  benchmark order ID, execution claim, Host fee, and protocol fee.

Raw success rows also preserve the decoded event payout/total input and the
exact user settlement-token delta from that transaction's Sui
`balanceChanges`. Debit, unchanged, credit, and unavailable are distinct; a
credit or unavailable result is never counted as zero spend. User Vault
before/after reads remain diagnostic snapshots and preserve object identity,
creation state, credit, and nonce. Their failure or identity drift is recorded
without changing a verified on-chain success.

Sponsored runs are split by the `/prepare` settlement profile:

- `vault_create`: the transaction creates a User Vault and settles through the
  configured settlement swap path. Treat this as setup cost.
- `vault_top_up`: the transaction uses an existing User Vault but still settles
  through the configured settlement swap path. Report this separately from
  direct empty-transaction overhead.
- `vault_credit_use`: the transaction uses existing User Vault credit without a
  settlement-token swap. This is the sponsored run type compared against direct
  empty SUI transactions.

Raw JSONL and processed Markdown files use timestamp-plus-UUID names under
ignored `.WORK` directories by default. The report includes safely redacted Relay and Sui gRPC
endpoints, chain identifier, network, Stelis package ID, mode, verified-success
counts, diagnostic starting snapshots, sponsored flow breakdown, and summary
metrics. Settlement-token spend averages are per flow and show excluded credit
or unavailable observations. Copy a report into
`docs/onchain-tests/reports` only after deliberately reviewing it as curated
evidence.
