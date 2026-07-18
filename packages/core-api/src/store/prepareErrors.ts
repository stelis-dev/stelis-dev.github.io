/**
 * Shared error classes for prepared receipt admission and commit.
 *
 * Kept in the store layer so that both store adapters (memory, Redis) and
 * the prepare runner / public handler adapter and host routes can import from a single
 * source without creating a circular dependency.
 *
 * Layering rule:
 *   store/prepareErrors.ts  ← store adapters import from here
 *                           ← prepare runner / handler adapter import from here
 *                           ← host routes import from here (via index.ts)
 */

/**
 * Thrown when the sponsored execution store commits a prepared receipt and the verified developer
 * JWT `userId` has reached the maximum number of outstanding
 * promotion-mode prepared transactions. Studio promotion is the only
 * route family that enforces a developer-user quota. Generic
 * `/relay/prepare` separately enforces a quota on the verified sender.
 *
 * The store does not release a provisional sponsor slot when commit fails.
 * The prepare runner owns reverse-order cleanup until commit succeeds.
 */
export class PrepareStudioUserQuotaError extends Error {
  readonly code = 'PREPARE_STUDIO_USER_QUOTA_EXCEEDED';

  constructor(userId: string, max: number) {
    super(
      `Studio user ${userId} has reached the maximum of ${max} outstanding prepared transactions.`,
    );
    this.name = 'PrepareStudioUserQuotaError';
  }
}

/**
 * Thrown by the sponsored execution store when a verified wallet
 * sender already has too many live or pending generic prepare entries.
 *
 * This quota is enforced only after prepare authorization proves control
 * of `senderAddress`, so a caller cannot exhaust another address's
 * outstanding-prepare allowance by submitting an unsigned body.
 */
export class PrepareSenderQuotaError extends Error {
  readonly code = 'PREPARE_SENDER_QUOTA_EXCEEDED';

  constructor(senderAddress: string, max: number) {
    super(
      `Sender ${senderAddress} has reached the maximum of ${max} outstanding prepared transactions.`,
    );
    this.name = 'PrepareSenderQuotaError';
  }
}

/**
 * Thrown when the prepare in-flight limiter rejects a request because
 * the maximum number of concurrent expensive prepare operations is reached.
 *
 * Distinct from NO_SPONSOR_SLOT (which indicates slot exhaustion).
 * Host routes should map this to 503 + Retry-After + PREPARE_OVERLOADED.
 */
export class PrepareOverloadError extends Error {
  readonly code = 'PREPARE_OVERLOADED';

  constructor(currentInflight: number, maxInflight: number) {
    super(`Prepare capacity reached (${currentInflight}/${maxInflight} in-flight). Retry shortly.`);
    this.name = 'PrepareOverloadError';
  }
}
