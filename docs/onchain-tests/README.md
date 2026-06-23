# On-Chain Test Reports

This folder stores processed reports from manual on-chain tests.

Each report file is named after the test it summarizes. Repeated runs append a
new summary section to the same report.

The empty execution benchmark report records the test date, network, Stelis
package ID, execution mode, submitted transaction count, starting balances, and
summary metrics for gas overhead and Host recovery.

Sponsored benchmark runs are separated into User Vault creation, User Vault
top-up, and User Vault credit-use flows. Direct empty SUI transaction gas is
compared only against User Vault credit-use runs; creation and top-up runs are
reported separately because they include setup or settlement-token swap work.
