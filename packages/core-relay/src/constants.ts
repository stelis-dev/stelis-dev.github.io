// Core-relay-interior constants.
// Shared cross-package runtime data tables, identifiers, and discriminator
// literals live in @stelis/contracts. This module keeps only core-relay-local
// constants used by validation and gas math.

// ─────────────────────────────────────────────
// Off-chain only constants (core-relay-interior)
// ─────────────────────────────────────────────

/** Final Host-built PTB command count upper bound. */
export const MAX_FINAL_COMMANDS = 16;

/**
 * Generic user TransactionKind command cap.
 *
 * The current generic compiler can append at most five commands, so the user
 * prefix reserves that suffix inside the 16-command final Host policy.
 */
export const MAX_GENERIC_USER_COMMANDS = 11;

/** Sui Clock shared object ID (protocol-level constant) */
export const SUI_CLOCK_OBJECT_ID = '0x6';

// requireContractId lives in @stelis/contracts as the shared
// contract-id lookup validator.
