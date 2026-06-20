import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SponsorResultMetadata } from '@stelis/core-api';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { createSponsorResultStateUpdater } from '../../src/sponsor-operations/sponsorResultStateUpdater.js';
import type {
  RedisSponsorOperationsState,
  SlotWriteFields,
  SponsorRefillAccountWriteFields,
} from '../../src/sponsor-operations/redisState.js';
import { SPONSOR_BALANCE_WARN_MIST } from '../../src/sponsor-operations/defaults.js';

// ─────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────

function makeStubState(): {
  state: RedisSponsorOperationsState;
  slotWrites: Array<{ address: string; fields: SlotWriteFields }>;
  sponsorRefillAccountWrites: Array<SponsorRefillAccountWriteFields>;
} {
  const slotWrites: Array<{ address: string; fields: SlotWriteFields }> = [];
  const sponsorRefillAccountWrites: Array<SponsorRefillAccountWriteFields> = [];
  return {
    slotWrites,
    sponsorRefillAccountWrites,
    state: {
      async updateSlot(address, fields) {
        slotWrites.push({ address, fields });
      },
      async updateSponsorRefillAccount(fields) {
        sponsorRefillAccountWrites.push(fields);
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
    },
  };
}

function makeStubSui(impl: { getBalance: (owner: string) => Promise<string> }): SuiGrpcClient {
  // Only `getBalance` is consumed by the sponsor result callback. The cast is
  // local to this test file.
  const stub: {
    getBalance: (params: { owner: string }) => Promise<{ balance: { balance: string } }>;
  } = {
    async getBalance({ owner }) {
      return { balance: { balance: await impl.getBalance(owner) } };
    },
  };
  return stub as unknown as SuiGrpcClient;
}

const SLOT = '0xslot';
const SPONSOR_REFILL_ACCOUNT_ADDRESS = '0x' + '55'.repeat(32);
const LONG_MULTIBYTE_ERROR = '한'.repeat(300);
const TRIMMED_MULTIBYTE_ERROR = '한'.repeat(170);

function metadata(
  outcome: SponsorResultMetadata['outcome'],
  overrides: Partial<SponsorResultMetadata> = {},
): SponsorResultMetadata {
  return {
    slotId: SLOT,
    sponsorAddress: SLOT,
    outcome,
    route: 'generic',
    ...overrides,
  };
}

describe('createSponsorResultStateUpdater — slot probe', () => {
  let stub: ReturnType<typeof makeStubState>;

  beforeEach(() => {
    stub = makeStubState();
  });

  it('probes slot balance and writes healthy state when above warn threshold', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => SPONSOR_BALANCE_WARN_MIST.toString(),
      }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: 1_000_000_000n,
    });

    await callback(metadata('success'));

    expect(stub.slotWrites).toHaveLength(1);
    expect(stub.slotWrites[0]).toEqual({
      address: SLOT,
      fields: {
        state: 'healthy',
        balanceMist: SPONSOR_BALANCE_WARN_MIST.toString(),
        lastError: '',
      },
    });
  });

  it('writes low_balance when balance is under warn threshold', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => (SPONSOR_BALANCE_WARN_MIST - 1n).toString(),
      }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: 1_000_000_000n,
    });

    await callback(metadata('onchain_revert'));

    expect(stub.slotWrites[0].fields.state).toBe('low_balance');
  });

  it('writes rpc_unreachable + lastError when the probe rejects', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => {
          throw new Error('grpc connection lost');
        },
      }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('preflight_failure'));

    expect(stub.slotWrites).toHaveLength(1);
    expect(stub.slotWrites[0].fields.state).toBe('rpc_unreachable');
    expect(stub.slotWrites[0].fields.balanceMist).toBe('');
    expect(stub.slotWrites[0].fields.lastError).toBe('grpc connection lost');
  });

  it('writes rpc_unreachable when the slot balance is not a decimal string', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => '0x10',
      }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('success'));

    expect(stub.slotWrites[0].fields.state).toBe('rpc_unreachable');
    expect(stub.slotWrites[0].fields.balanceMist).toBe('');
    expect(stub.slotWrites[0].fields.lastError).toContain(
      'must be a non-negative decimal integer string',
    );
  });

  it('trims multibyte slot lastError payloads to 512 UTF-8 bytes', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => {
          throw new Error(LONG_MULTIBYTE_ERROR);
        },
      }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('preflight_failure'));

    expect(stub.slotWrites[0].fields.lastError).toBe(TRIMMED_MULTIBYTE_ERROR);
    expect(
      new TextEncoder().encode(stub.slotWrites[0].fields.lastError ?? '').length,
    ).toBeLessThanOrEqual(512);
  });

  it('never throws even when state.updateSlot rejects', async () => {
    const state: RedisSponsorOperationsState = {
      async updateSlot() {
        throw new Error('redis unreachable');
      },
      async updateSponsorRefillAccount() {},
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
    };
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({ getBalance: async () => '0' }),
      state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await expect(callback(metadata('success'))).resolves.toBeUndefined();
  });
});

describe('createSponsorResultStateUpdater — sponsor-refill-account refresh', () => {
  let stub: ReturnType<typeof makeStubState>;

  beforeEach(() => {
    stub = makeStubState();
  });

  it('probes sponsor refill account when the sponsor refill account is the settlement payout recipient and outcome is success', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async (owner) =>
          owner === SPONSOR_REFILL_ACCOUNT_ADDRESS ? '10000000000' : '5000000000',
      }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS, // sponsor refill account == recipient
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: 1_000_000_000n,
    });

    await callback(metadata('success'));

    expect(stub.sponsorRefillAccountWrites).toHaveLength(1);
    expect(stub.sponsorRefillAccountWrites[0]).toEqual({
      balanceMist: '10000000000',
      healthy: '1',
      refillsRemaining: '10',
      lastError: '',
    });
  });

  it('does NOT probe sponsor refill account when outcome is not success', async () => {
    const getBalance = vi.fn(async () => '5000000000');
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({ getBalance }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('onchain_revert'));
    expect(stub.sponsorRefillAccountWrites).toHaveLength(0);
    // Only slot probe fired — no sponsor-refill-account probe.
    expect(getBalance.mock.calls.some((call) => call[0] === SPONSOR_REFILL_ACCOUNT_ADDRESS)).toBe(
      false,
    );
  });

  it('does NOT probe sponsor refill account when it is not the settlement payout recipient', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({ getBalance: async () => '5000000000' }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xdifferent', // sponsor refill account != recipient
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('success'));
    expect(stub.sponsorRefillAccountWrites).toHaveLength(0);
  });

  it('writes sponsor-refill-account healthy=0 with lastError when the sponsor-refill-account probe rejects', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async (owner) => {
          if (owner === SPONSOR_REFILL_ACCOUNT_ADDRESS)
            throw new Error('sponsor refill account rpc down');
          return '5000000000';
        },
      }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('success'));
    expect(stub.sponsorRefillAccountWrites[0]).toEqual({
      balanceMist: '',
      healthy: '0',
      refillsRemaining: '',
      lastError: 'sponsor refill account rpc down',
    });
  });

  it('leaves refillsRemaining empty when refillTargetMist is null', async () => {
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({ getBalance: async () => '10000000000' }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('success'));
    expect(stub.sponsorRefillAccountWrites[0].refillsRemaining).toBe('');
  });
});

// ─────────────────────────────────────────────
// Observability contract: SPONSOR_OPERATIONS_STATE_WRITE_FAILED
//
// Emit contract (mirrors the header doc in `sponsorResultStateUpdater.ts`):
//   - Chain probe failure with a successful degraded-state fallback
//     write is NOT an event; the degraded state is the signal.
//   - Event fires whenever the callback cannot commit its slot or sponsor-refill-account
//     state update, or when an unexpected error escapes the outer `try`.
//   - `source` payload discriminates:
//       * sponsor_result_state_update_slot_update  — slot write failed
//       * sponsor_result_state_update_sponsor_refill_account_update    — sponsor-refill-account write failed
//       * sponsor_result_state_update_unhandled    — outer defensive trap
// ─────────────────────────────────────────────

describe('createSponsorResultStateUpdater — SPONSOR_OPERATIONS_STATE_WRITE_FAILED emissions', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  function findWriteFailedLogs(source?: string): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          entry['event'] === 'SPONSOR_OPERATIONS_STATE_WRITE_FAILED' &&
          (source === undefined || entry['source'] === source),
      );
  }

  it('does NOT emit when probe rejects but fallback degraded-state write succeeds (slot)', async () => {
    const stub = makeStubState();
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => {
          throw new Error('grpc connection lost');
        },
      }),
      state: stub.state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('preflight_failure'));

    // Degraded state write succeeded → no observability event.
    expect(stub.slotWrites).toHaveLength(1);
    expect(stub.slotWrites[0].fields.state).toBe('rpc_unreachable');
    expect(findWriteFailedLogs()).toHaveLength(0);
  });

  it('emits with source=sponsor_result_state_update_slot_update when slot fallback write rejects', async () => {
    // Every slot write rejects → both the healthy write AND the
    // rpc_unreachable fallback fail → event fires.
    const state: RedisSponsorOperationsState = {
      async updateSlot() {
        throw new Error('redis write timeout');
      },
      async updateSponsorRefillAccount() {},
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
    };
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => {
          throw new Error('rpc down');
        },
      }),
      state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('success'));

    const logs = findWriteFailedLogs('sponsor_result_state_update_slot_update');
    expect(logs).toHaveLength(1);
    expect(logs[0]['slot_address']).toBe(SLOT);
    expect(logs[0]['probe_error']).toBe('rpc down');
    expect(logs[0]['write_error']).toBe('redis write timeout');
  });

  it('emits with source=sponsor_result_state_update_slot_update when the healthy-state write rejects', async () => {
    const state: RedisSponsorOperationsState = {
      async updateSlot() {
        throw new Error('redis rejected healthy write');
      },
      async updateSponsorRefillAccount() {},
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
    };
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({ getBalance: async () => '0' }),
      state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('success'));

    const logs = findWriteFailedLogs('sponsor_result_state_update_slot_update');
    expect(logs).toHaveLength(1);
    expect(logs[0]['slot_address']).toBe(SLOT);
    expect(logs[0]['state']).toBe('low_balance');
    expect(logs[0]['probe_error']).toBeUndefined();
    expect(logs[0]['write_error']).toBe('redis rejected healthy write');
  });

  it('emits with source=sponsor_result_state_update_sponsor_refill_account_update when sponsor-refill-account fallback write rejects', async () => {
    // Slot path works; sponsor-refill-account path fails both probe and fallback write.
    const state: RedisSponsorOperationsState = {
      async updateSlot() {},
      async updateSponsorRefillAccount() {
        throw new Error('sponsor refill account redis rejected');
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
    };
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async (owner) => {
          if (owner === SPONSOR_REFILL_ACCOUNT_ADDRESS)
            throw new Error('sponsor refill account rpc down');
          return '5000000000';
        },
      }),
      state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS, // sponsor refill account == recipient triggers the sponsor-refill-account path
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('success'));

    // No slot_update event (slot path succeeded).
    expect(findWriteFailedLogs('sponsor_result_state_update_slot_update')).toHaveLength(0);
    const sponsorRefillAccountLogs = findWriteFailedLogs(
      'sponsor_result_state_update_sponsor_refill_account_update',
    );
    expect(sponsorRefillAccountLogs).toHaveLength(1);
    expect(sponsorRefillAccountLogs[0]['probe_error']).toBe('sponsor refill account rpc down');
    expect(sponsorRefillAccountLogs[0]['write_error']).toBe(
      'sponsor refill account redis rejected',
    );
  });

  it('emits with source=sponsor_result_state_update_unhandled when the helper-level log throw escapes', async () => {
    // The outer `catch` is a defensive trap for unexpected escapes
    // from the two inner helpers. The helpers catch async/sync throws
    // from probes and writes, but a transient log-sink failure (here:
    // `console.warn` rejecting on a specific call) can still propagate
    // out of the inner catch's `logStructuredEvent`, which is what
    // this case simulates.
    //
    // Scenario: slot path rejects both probe and fallback write. The
    // inner catch calls `logStructuredEvent(…'slot_update'…)` →
    // `console.warn` throws on the first invocation → propagates out
    // of `probeAndWriteSlot` → reaches `onSponsorResult`'s outer
    // `try`. The outer catch then calls `logStructuredEvent(
    // …'unhandled'…)` which uses the still-healthy warn path (our
    // mock succeeds from the second call onward).
    const state: RedisSponsorOperationsState = {
      async updateSlot() {
        throw new Error('redis down');
      },
      async updateSponsorRefillAccount() {},
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
    };
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => {
          throw new Error('rpc down');
        },
      }),
      state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: '0xrecipient',
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    // Restore beforeEach's default spy and install one that throws on
    // the first call only. We collect all call arguments (including
    // the thrown one) via the captured array so the test can assert
    // both emissions still happened at the payload level.
    warnSpy.mockRestore();
    const capturedWarnCalls: unknown[][] = [];
    let warnCallCount = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      capturedWarnCalls.push(args);
      warnCallCount += 1;
      if (warnCallCount === 1) {
        throw new Error('log sink transient failure');
      }
    });

    await expect(callback(metadata('success'))).resolves.toBeUndefined();

    // First call: the slot-update emission, which triggered the sink throw.
    expect(capturedWarnCalls).toHaveLength(2);
    const first = JSON.parse(capturedWarnCalls[0][0] as string) as Record<string, unknown>;
    expect(first['event']).toBe('SPONSOR_OPERATIONS_STATE_WRITE_FAILED');
    expect(first['source']).toBe('sponsor_result_state_update_slot_update');
    // Second call: the outer defensive trap, re-logging the same event name
    // with a different source discriminator.
    const second = JSON.parse(capturedWarnCalls[1][0] as string) as Record<string, unknown>;
    expect(second['event']).toBe('SPONSOR_OPERATIONS_STATE_WRITE_FAILED');
    expect(second['source']).toBe('sponsor_result_state_update_unhandled');
    expect(second['slot_id']).toBe(SLOT);
    expect(second['sponsor_address']).toBe(SLOT);
    expect(second['outcome']).toBe('success');
    expect(second['error']).toContain('log sink transient failure');
  });

  it('does not emit any alternate callback write-failure event name', async () => {
    const state: RedisSponsorOperationsState = {
      async updateSlot() {
        throw new Error('redis down');
      },
      async updateSponsorRefillAccount() {
        throw new Error('redis down');
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
    };
    const callback = createSponsorResultStateUpdater({
      sui: makeStubSui({
        getBalance: async () => {
          throw new Error('rpc down');
        },
      }),
      state,
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      settlementPayoutRecipientAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      refillTargetMist: null,
    });

    await callback(metadata('success'));

    const supervisorEventLogs = warnSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.['event'] === 'SPONSOR_OPERATIONS_OBSERVATION_CYCLE_FAILED');
    expect(supervisorEventLogs).toHaveLength(0);
  });
});
