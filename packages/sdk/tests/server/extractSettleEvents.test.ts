/**
 * Tests for extractSettleEvents.
 *
 * Uses realistic Sui transaction-result discriminants while keeping the
 * network client local and deterministic.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { extractSettleEvents } from '../../src/server/extractSettleEvents.js';
import { STELIS_CONTRACT_IDS, SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import { serializeSettleEventBcs } from '../helpers/settleEventBcs.js';
import type { SuiTransactionWithEventsResult } from '@stelis/core-relay/browser';
import { SuiOperationError } from '@stelis/core-relay/browser';
import { withSuiClientIdentity } from '../helpers/suiClientIdentity.js';

const { getSuiTransactionEventsMock, responsesByDigest } = vi.hoisted(() => {
  const responsesByDigest = new Map<string, unknown>();
  return {
    responsesByDigest,
    getSuiTransactionEventsMock: vi.fn((_snapshot: unknown, options: { digest: string }) => {
      const response = responsesByDigest.get(options.digest);
      if (response instanceof Error) throw response;
      return response;
    }),
  };
});

vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return { ...actual, getSuiTransactionEvents: getSuiTransactionEventsMock };
});

const PACKAGE_ID = STELIS_CONTRACT_IDS.testnet!.packageId;
const SETTLE_EVENT_TYPE = `${PACKAGE_ID}::events::SettleEvent`;
const USER = `0x${'ab'.repeat(32)}`;

type SuiEvent = Extract<SuiTransactionWithEventsResult, { outcome: 'success' }>['events'][number];

function createMockSettleEventBcs(): Uint8Array {
  return serializeSettleEventBcs({
    receipt_id: Uint8Array.from({ length: 32 }, (_, i) => i),
    nonce: 1n,
    policy_hash: new Uint8Array(32),
    quote_timestamp_ms: 1000n,
    exec_timestamp_ms: 2000n,
    sim_gas_reported: 100n,
    gas_variance_fixed_mist: 10n,
    slippage_buffer_mist: 5n,
    execution_cost_claim_mist: 50n,
    quoted_host_fee_mist: 60n,
    protocol_fee: 20n,
    protocol_treasury: `0x${'00'.repeat(32)}`,
    payout: 900n,
    total_in: 1000n,
    surplus_credited: 0n,
    config_version: 1n,
    user: USER,
    settlement_payout_recipient: `0x${'cc'.repeat(32)}`,
    order_id_hash: new Uint8Array(32).fill(0xff),
  });
}

function createEvent(bcs: Uint8Array, overrides: Partial<Omit<SuiEvent, 'bcs'>> = {}): SuiEvent {
  return {
    packageId: PACKAGE_ID,
    module: 'settle',
    sender: USER,
    eventType: SETTLE_EVENT_TYPE,
    bcs,
    ...overrides,
  };
}

function effects(digest: string, success: boolean) {
  const error = success ? null : ({ kind: 'MoveAbortRaw' as const } as const);
  return {
    version: 2 as const,
    transactionDigest: digest,
    status: success
      ? ({ success: true as const, error: null } as const)
      : ({ success: false as const, error: error! } as const),
    gasUsed: {
      computationCost: '1',
      storageCost: '1',
      storageRebate: '0',
      nonRefundableStorageFee: '0',
    },
    eventsDigest: null,
  };
}

function successfulTransaction(
  events: readonly SuiEvent[],
  digest = 'digest',
): SuiTransactionWithEventsResult {
  return {
    outcome: 'success',
    digest,
    effects: effects(digest, true),
    events,
  };
}

function failedTransaction(
  events: readonly SuiEvent[],
  digest = 'failed',
): SuiTransactionWithEventsResult {
  const error = { kind: 'MoveAbortRaw' as const };
  return { outcome: 'failure', digest, effects: effects(digest, false), events, error };
}

function createMockClient(
  responses: Record<string, unknown>,
  network: 'testnet' | 'mainnet' = 'testnet',
  chainIdentifier = SUI_CHAIN_IDENTIFIERS[network],
) {
  const client = withSuiClientIdentity({}, network, chainIdentifier);
  responsesByDigest.clear();
  for (const [digest, response] of Object.entries(responses)) {
    responsesByDigest.set(digest, response);
  }
  return client;
}

beforeEach(() => {
  getSuiTransactionEventsMock.mockClear();
});

describe('extractSettleEvents', () => {
  it('rejects the batch before event reads when the live chain is not the settlement network', async () => {
    const logger = vi.fn();
    const client = createMockClient(
      {
        digest1: successfulTransaction([createEvent(createMockSettleEventBcs())], 'digest1'),
      },
      'testnet',
      SUI_CHAIN_IDENTIFIERS.mainnet,
    );

    await expect(extractSettleEvents(client, ['digest1'], logger)).rejects.toThrow(
      'Sui operation returned a malformed response',
    );
    expect(getSuiTransactionEventsMock).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
  });

  it('extracts the canonical SettleEvent from a successful transaction', async () => {
    const logger = vi.fn();
    const client = createMockClient({
      digest1: successfulTransaction([createEvent(createMockSettleEventBcs())], 'digest1'),
    });

    const results = await extractSettleEvents(client, ['digest1'], logger);

    expect(results).toEqual([
      expect.objectContaining({ digest: 'digest1', user: USER, timestampMs: '2000' }),
    ]);
    expect(logger).not.toHaveBeenCalled();
  });

  it('normally skips a successful transaction with no canonical SettleEvent', async () => {
    const logger = vi.fn();
    const client = createMockClient({
      digest2: successfulTransaction(
        [createEvent(new Uint8Array(), { eventType: `${PACKAGE_ID}::events::OtherEvent` })],
        'digest2',
      ),
    });

    const results = await extractSettleEvents(client, ['digest2'], logger);

    expect(results).toEqual([]);
    expect(logger).not.toHaveBeenCalled();
  });

  it('continues after a fetch failure and reports the failed digest', async () => {
    const logger = vi.fn();
    const client = createMockClient({
      bad: new SuiOperationError('transport_unavailable', {
        operation: 'get_transaction_events',
        attempt: 1,
        maxAttempts: 1,
      }),
      good: successfulTransaction([createEvent(createMockSettleEventBcs())], 'good'),
    });

    const results = await extractSettleEvents(client, ['bad', 'good'], logger);

    expect(results).toEqual([expect.objectContaining({ digest: 'good' })]);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Sui RPC transport was unavailable'),
    );
  });

  it('skips a normalized failed transaction even when it carries a matching event', async () => {
    const logger = vi.fn();
    const event = createEvent(createMockSettleEventBcs());
    const client = createMockClient({
      failed: failedTransaction([event], 'failed'),
    });

    const results = await extractSettleEvents(client, ['failed'], logger);

    expect(results).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('execution failed'));
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Sui execution failed (MoveAbortRaw)'),
    );
  });

  it('skips duplicate SettleEvents and reports the count boundary', async () => {
    const logger = vi.fn();
    const event = createEvent(createMockSettleEventBcs());
    const client = createMockClient({
      duplicate: successfulTransaction([event, event], 'duplicate'),
    });

    const results = await extractSettleEvents(client, ['duplicate'], logger);

    expect(results).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('expected one SettleEvent'));
  });

  it('skips non-canonical event BCS and reports the rejected boundary', async () => {
    const canonical = createMockSettleEventBcs();
    const withTrailingByte = new Uint8Array(canonical.length + 1);
    withTrailingByte.set(canonical);
    const logger = vi.fn();
    const client = createMockClient({
      malformed: successfulTransaction([createEvent(withTrailingByte)], 'malformed'),
    });

    const results = await extractSettleEvents(client, ['malformed'], logger);

    expect(results).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('invalid SettleEvent'));
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('not canonical'));
  });

  it.each([
    ['package', { packageId: `0x${'9'.repeat(64)}` }],
    ['module', { module: 'not_settle' }],
  ] as const)(
    'rejects a canonical eventType whose top-level %s identity conflicts',
    async (_field, overrides) => {
      const logger = vi.fn();
      const client = createMockClient({
        mismatched: successfulTransaction(
          [createEvent(createMockSettleEventBcs(), overrides)],
          'mismatched',
        ),
      });

      const results = await extractSettleEvents(client, ['mismatched'], logger);

      expect(results).toEqual([]);
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('envelope identity'));
    },
  );

  it('rejects a canonical event whose sender conflicts with the decoded user', async () => {
    const logger = vi.fn();
    const client = createMockClient({
      mismatched: successfulTransaction(
        [createEvent(createMockSettleEventBcs(), { sender: `0x${'dd'.repeat(32)}` })],
        'mismatched',
      ),
    });

    const results = await extractSettleEvents(client, ['mismatched'], logger);

    expect(results).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('sender does not match'));
  });
});
