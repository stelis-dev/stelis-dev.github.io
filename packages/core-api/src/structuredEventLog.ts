import { redactDiagnosticRecord, redactSensitiveText } from './observability/redaction.js';

export type StructuredEventLogLevel = 'info' | 'warn' | 'error';

/**
 * Single structured event sink shared by core-api runtime modules and exposed
 * to app-api through the `@stelis/core-api/observability` subpath.
 */
export function logStructuredEvent(
  event: string,
  payload: Record<string, unknown>,
  level: StructuredEventLogLevel = 'info',
): void {
  const line = JSON.stringify({
    ...redactDiagnosticRecord(payload),
    // The function argument is the event authority. A payload field must not
    // relabel the emitted event.
    event: redactSensitiveText(event),
  });
  if (level === 'error') {
    // eslint-disable-next-line no-console -- intentional structured operations log
    console.error(line);
    return;
  }
  if (level === 'warn') {
    // eslint-disable-next-line no-console -- intentional structured operations log
    console.warn(line);
    return;
  }
  // eslint-disable-next-line no-console -- intentional structured operations log
  console.info(line);
}
