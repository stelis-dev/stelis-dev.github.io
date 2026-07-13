/**
 * [app-api] Host-level environment parsing utilities.
 *
 * These are runtime host utilities — not domain logic.
 * Boot passes snapshotted raw values into these parsers.
 * Kept in app-api (host layer), not core-api (framework-agnostic).
 */

export function parseOptionalBooleanEnv(
  name: string,
  rawValue: string | undefined,
): boolean | undefined {
  if (rawValue == null || rawValue.trim() === '') {
    return undefined;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new Error(`[app-api] ${name} must be "true" or "false" when set`);
}

export function parseOptionalPositiveBigIntEnv(
  name: string,
  rawValue: string | undefined,
): bigint | undefined {
  if (rawValue == null || rawValue.trim() === '') {
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`[app-api] ${name} must be a positive integer in MIST when set`);
  }

  const value = BigInt(trimmed);
  if (value <= BigInt(0)) {
    throw new Error(`[app-api] ${name} must be greater than zero when set`);
  }

  return value;
}

export function parseOptionalPositiveIntegerEnv(
  name: string,
  rawValue: string | undefined,
): number | undefined {
  if (rawValue == null || rawValue.trim() === '') {
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`[app-api] ${name} must be a positive integer when set`);
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `[app-api] ${name} must be a positive integer within Number.MAX_SAFE_INTEGER when set`,
    );
  }
  return value;
}

export function parseRequiredPositiveIntegerEnv(
  name: string,
  rawValue: string | undefined,
): number {
  if (rawValue == null || rawValue.trim() === '') {
    throw new Error(`[app-api] Missing required environment variable: ${name}`);
  }

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`[app-api] ${name} must be a positive integer, got "${rawValue}"`);
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `[app-api] ${name} must be a positive integer within Number.MAX_SAFE_INTEGER, got "${rawValue}"`,
    );
  }
  return value;
}

export function parsePortEnv(
  name: string,
  rawValue: string | undefined,
  defaultValue: number,
): number {
  const raw = rawValue == null || rawValue.trim() === '' ? String(defaultValue) : rawValue.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`[app-api] ${name} must be an integer port in [1, 65535], got "${rawValue}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`[app-api] ${name} must be an integer port in [1, 65535], got "${rawValue}"`);
  }
  return value;
}
