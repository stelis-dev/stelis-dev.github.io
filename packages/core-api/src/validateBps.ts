/**
 * Shared BPS field validation helper.
 *
 * Used by:
 *   - app-api/routes/relay.ts (HTTP body: unknown → validated number | undefined)
 *   - core-api/handlers/prepare.ts (domain boundary: defense-in-depth)
 *
 * Pure function, no I/O.
 */

export interface BpsValidationError<Code extends string = string> {
  ok: false;
  code: Code;
  message: string;
}

interface BpsValidationSuccess {
  ok: true;
  value: number;
}

type BpsValidationResult<Code extends string> = BpsValidationSuccess | BpsValidationError<Code>;

/**
 * Validate a BPS value from untrusted input.
 *
 * Accepts `unknown` so it works at both the HTTP body boundary
 * and the domain boundary (post-coalesce number).
 *
 * @returns `{ ok: true, value }` on success, `{ ok: false, code, message }` on failure.
 */
export function validateBps<Code extends string>(
  name: string,
  value: unknown,
  cap: number,
  code: Code,
): BpsValidationResult<Code> {
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > 10_000) {
    throw new Error(`${name} cap must be a safe integer in [0, 10000]`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > cap) {
    return {
      ok: false,
      code,
      message: `${name} must be an integer in [0, ${cap}]`,
    };
  }
  return { ok: true, value };
}
