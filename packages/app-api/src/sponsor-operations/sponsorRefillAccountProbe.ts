import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  logStructuredEvent,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
} from '@stelis/core-api/observability';
import type { SponsorRefillAccountWriteFields, RedisSponsorOperationsState } from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { withTimeout } from './timeout.js';
import { parseChainBalanceMist } from './balanceParsing.js';

export type SponsorRefillAccountProbeWriteFailureSource =
  | 'sponsor_result_state_update_sponsor_refill_account_update'
  | 'refill_worker_sponsor_refill_account_update'
  | 'admin_sponsor_operations_sponsor_refill_account_update'
  | 'admin_withdraw_sponsor_refill_account_update';

export interface SponsorRefillAccountProbeDeps {
  readonly sui: SuiGrpcClient;
  readonly state: RedisSponsorOperationsState;
  readonly sponsorRefillAccountAddress: string;
  readonly refillTargetMist: bigint | null;
  readonly sponsorRefillAccountBalanceTimeoutMs: number;
}

export interface ProbeAndWriteSponsorRefillAccountStateOptions {
  readonly operation: string;
  readonly source: SponsorRefillAccountProbeWriteFailureSource;
  readonly writeFailureMode: 'throw' | 'swallow';
}

function computeRefillsRemaining(balance: bigint, refillTargetMist: bigint | null): string {
  if (refillTargetMist == null || refillTargetMist <= 0n) return '';
  return (balance / refillTargetMist).toString();
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logSponsorRefillAccountWriteFailure(payload: {
  readonly source: SponsorRefillAccountProbeWriteFailureSource;
  readonly sponsor_refill_account_address: string;
  readonly probe_error?: string;
  readonly write_error: string;
}): void {
  try {
    logStructuredEvent(SPONSOR_OPERATIONS_STATE_WRITE_FAILED, payload, 'warn');
  } catch {
    // Observability sink failure must not rewrite the helper's own
    // throw/swallow contract. Callers rely on `swallow` for best-effort
    // Sponsor refill account refresh after success paths (for example withdraw success).
  }
}

export async function probeAndWriteSponsorRefillAccountState(
  deps: SponsorRefillAccountProbeDeps,
  options: ProbeAndWriteSponsorRefillAccountStateOptions,
): Promise<void> {
  let fields: SponsorRefillAccountWriteFields;
  let probeError: string | undefined;

  try {
    const balance = await withTimeout(
      options.operation,
      deps.sponsorRefillAccountBalanceTimeoutMs,
      async () => {
        const res = await deps.sui.getBalance({ owner: deps.sponsorRefillAccountAddress });
        return parseChainBalanceMist(res.balance.balance, 'Sponsor refill account balance');
      },
    );
    fields = {
      balanceMist: balance.toString(),
      healthy: '1',
      refillsRemaining: computeRefillsRemaining(balance, deps.refillTargetMist),
      lastError: '',
    };
  } catch (err) {
    probeError = getErrorMessage(err);
    fields = {
      balanceMist: '',
      healthy: '0',
      refillsRemaining: '',
      lastError: normalizeSponsorOperationsLastError(err),
    };
  }

  try {
    await deps.state.updateSponsorRefillAccount(fields);
  } catch (writeErr) {
    logSponsorRefillAccountWriteFailure({
      source: options.source,
      sponsor_refill_account_address: deps.sponsorRefillAccountAddress,
      probe_error: probeError,
      write_error: getErrorMessage(writeErr),
    });
    if (options.writeFailureMode === 'throw') {
      throw writeErr instanceof Error ? writeErr : new Error(String(writeErr));
    }
  }
}
