# On-Chain Test Reports

This folder stores deliberately reviewed reports from manual on-chain tests.
Generated raw data and reports stay under ignored `.WORK/onchain-tests` paths by
default; running a benchmark does not append to tracked documentation.

Each curated report must identify safely redacted Relay and Sui gRPC endpoints,
Sui chain identifier, network, and Stelis package ID. Historical reports that
predate those fields are measurements for their listed package, not proof that
a currently deployed Host still implements the current wire contract.

The current empty execution benchmark records attempt identity before submit
and counts success only after the exact Host sponsor wire, current Sui terminal
union, and compiled-schema SettleEvent agree. It records verified-success
counts, starting balances, and summary metrics for gas overhead and Host
recovery. Settlement-token use comes from transaction-local Sui
`balanceChanges`; wallet and User Vault snapshots remain diagnostic and do not
claim transaction attribution.

Execution safety is owned by a machine-global wallet+chain journal under the
operator's `~/.stelis` directory, not by generated report files. It serializes
local invocations before Host preparation using an OS-liveness-bound session
lease. Its non-empty directory lock and lease-ID archive destination prevent a
stale claimant from renaming a newer live lease. Stale takeover and normal
release both retain the prior lease-ID directory as an identity tombstone, so
a delayed observer cannot act on an ABA replacement. The journal keeps
monotonic active-attempt state and retains Sui-proven terminal digests. A Host-reported
on-chain failure is verified through the same exact Sui transaction gateway used
for success and restart recovery. Host congestion remains uncertain rather
than becoming a non-submitted terminal without Sui proof. After an uncertain
submit, a later invocation performs Host-independent Sui terminal reconciliation
and exits; it cannot start new work unless every candidate digest has a
canonical matching terminal.
The journal exposes closed execution events rather than arbitrary state/outcome
combinations, derives submitted success or failure from the Sui terminal kind,
permits Host preflight rejection only for sponsored attempts, and accepts an
archive collision as idempotent only when the full normalized attempt records
are identical. A terminal journal transition is durable before the raw report
projection is appended. Raw and Markdown output paths use timestamp-plus-UUID
run IDs and exclusive creation, so concurrent wallets cannot share a report.
Because this is local coordination, the disposable wallet must not be shared
with another machine or transaction tool.

Sponsored benchmark runs are separated into User Vault creation, User Vault
top-up, and User Vault credit-use flows. Direct empty SUI transaction gas is
compared only against User Vault credit-use runs; creation and top-up runs are
reported separately because they include setup or settlement-token swap work.
