import { isNodeTimerDelayMs, NODE_TIMER_MAX_DELAY_MS } from '@stelis/contracts';

export class SponsorOperationsTimeoutError extends Error {
  readonly operation: string;
  readonly budgetMs: number;

  constructor(operation: string, budgetMs: number) {
    super(`sponsor operation '${operation}' exceeded timeout budget ${budgetMs}ms`);
    this.name = 'SponsorOperationsTimeoutError';
    this.operation = operation;
    this.budgetMs = budgetMs;
  }
}

/**
 * Run one SponsorOperations task within a Node.js timer budget.
 *
 * The task receives the signal owned by this boundary. A timeout or caller
 * cancellation records the boundary reason and aborts that signal. This
 * function waits for the task Promise to settle before reporting the recorded
 * reason, so its returned Promise is also the task owner's completion Promise.
 */
export async function withTimeout<T>(
  operation: string,
  budgetMs: number,
  task: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (!isNodeTimerDelayMs(budgetMs)) {
    throw new Error(
      `withTimeout: budgetMs must be an integer from 1 through ${NODE_TIMER_MAX_DELAY_MS}, got ${String(budgetMs)}`,
    );
  }
  callerSignal?.throwIfAborted();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onCallerAbort: (() => void) | null = null;
  let boundaryEnded = false;
  let boundaryReason: unknown;

  const endBoundary = (reason: unknown): void => {
    if (boundaryEnded) return;
    boundaryEnded = true;
    boundaryReason = reason;
    controller.abort(reason);
  };

  try {
    onCallerAbort = () => {
      endBoundary(callerSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal?.aborted) onCallerAbort();

    timer = setTimeout(() => {
      endBoundary(new SponsorOperationsTimeoutError(operation, budgetMs));
    }, budgetMs);
    timer.unref?.();

    const outcome = await Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return task(controller.signal);
      })
      .then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );

    if (boundaryEnded) throw boundaryReason;
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onCallerAbort !== null) {
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
