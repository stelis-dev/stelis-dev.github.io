import { getSuiBalance, type SuiEndpointSnapshot } from '@stelis/core-relay';
import {
  logStructuredEvent,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
} from '@stelis/core-api/observability';
import type { SponsorRefillAccountWriteFields } from './redisState.js';
import type { SponsorRefillAccountSpendStateStore } from './accountSpendState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { withTimeout } from './timeout.js';
import { parseChainBalanceMist } from './balanceParsing.js';
import type { SponsorOperationsSettings } from './settings.js';
import { isActiveSponsorRefillOperationState } from './status.js';

export interface SponsorRefillAccountProbeDeps {
  readonly sui: SuiEndpointSnapshot;
  readonly spendState: SponsorRefillAccountSpendStateStore;
  readonly settings: SponsorOperationsSettings;
  readonly signal?: AbortSignal;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logSponsorRefillAccountWriteFailure(payload: {
  readonly sponsor_refill_account_address: string;
  readonly probe_error?: string;
  readonly write_error: string;
}): void {
  try {
    logStructuredEvent(
      SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
      {
        source: 'sponsor_result_state_update_sponsor_refill_account_update',
        ...payload,
      },
      'warn',
    );
  } catch {
    // A logging failure must not replace the Redis write failure.
  }
}

export async function probeAndWriteSponsorRefillAccountState(
  deps: SponsorRefillAccountProbeDeps,
): Promise<bigint | null> {
  deps.signal?.throwIfAborted();
  const observationCursor = await deps.spendState.readAccountObservationCursor();
  deps.signal?.throwIfAborted();
  if (isActiveSponsorRefillOperationState(observationCursor.spendState)) return null;
  let fields: SponsorRefillAccountWriteFields;
  let probeError: string | undefined;
  let observedBalance: bigint | null = null;

  try {
    const balance = await withTimeout(
      'sponsorResultStateUpdater.getSponsorRefillAccountBalance',
      deps.settings.sponsorRefillAccountBalanceTimeoutMs,
      async (operationSignal) => {
        const res = await getSuiBalance(deps.sui, {
          owner: deps.settings.sponsorRefillAccountAddress,
          signal: operationSignal,
        });
        return parseChainBalanceMist(res.balance, 'Sponsor refill account balance');
      },
      deps.signal,
    );
    observedBalance = balance;
    fields = {
      totalBalanceMist: balance.toString(),
      lastError: '',
    };
  } catch (err) {
    deps.signal?.throwIfAborted();
    probeError = getErrorMessage(err);
    fields = {
      totalBalanceMist: '',
      lastError: normalizeSponsorOperationsLastError(err),
    };
  }

  try {
    deps.signal?.throwIfAborted();
    const updated = await deps.spendState.updateAccountObservation(observationCursor, fields);
    if (!updated) {
      throw new Error('Sponsor Refill Account changed during the balance probe');
    }
    return updated ? observedBalance : null;
  } catch (writeErr) {
    deps.signal?.throwIfAborted();
    logSponsorRefillAccountWriteFailure({
      sponsor_refill_account_address: deps.settings.sponsorRefillAccountAddress,
      probe_error: probeError,
      write_error: getErrorMessage(writeErr),
    });
    throw writeErr instanceof Error ? writeErr : new Error(String(writeErr));
  }
}
