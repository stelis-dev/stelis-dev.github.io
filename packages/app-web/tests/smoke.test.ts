/**
 * app-web smoke tests — SDK wiring, Relay API endpoint, component/page exports.
 *
 * Verifies sandbox execution flow wiring against app-api route layout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Relay API endpoint logic ─────────────────────────────────────────────────

describe('relayApiEndpoint', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('RELAY_API_BASE is always explicit (no runtime fallback)', async () => {
    const mod = await import('../src/relayApiEndpoint');
    expect(mod.RELAY_API_BASE.endsWith('/relay')).toBe(true);
    expect(mod.RELAY_API_BASE).not.toBe('/relay');
  });
});

// ── SDK constants from @stelis/sdk ──────────────────────────────────────────

describe('Sandbox SDK wiring', () => {
  it('DEEPBOOK_IDS.testnet is defined and has deepType', async () => {
    const { DEEPBOOK_IDS } = await import('@stelis/sdk');
    expect(DEEPBOOK_IDS.testnet).toBeDefined();
    expect(DEEPBOOK_IDS.testnet!.deepType).toBeTruthy();
  });

  it('STELIS_CONTRACT_IDS.testnet has packageId', async () => {
    const { STELIS_CONTRACT_IDS } = await import('@stelis/sdk');
    expect(STELIS_CONTRACT_IDS.testnet).toBeDefined();
    expect(STELIS_CONTRACT_IDS.testnet!.packageId).toBeTruthy();
  });

  it('StelisSDK class is exported and has connect method', async () => {
    const { StelisSDK } = await import('@stelis/sdk');
    expect(StelisSDK).toBeDefined();
    expect(typeof StelisSDK.connect).toBe('function');
  });

  it('getSelectedSettlementSwapPath returns first path from supportedSettlementSwapPaths', async () => {
    const { getSelectedSettlementSwapPath } = await import('../src/pages/sandbox/constants');
    const mockSdk = {
      supportedSettlementSwapPaths: [
        { settlementTokenType: '0xTOKEN', settlementTokenSymbol: 'TOKEN', settlementTokenDecimals: 6 },
      ],
    };
    const settlementSwapPath = getSelectedSettlementSwapPath(mockSdk as never);
    expect(settlementSwapPath.settlementTokenType).toBe('0xTOKEN');
    expect(settlementSwapPath.settlementTokenSymbol).toBe('TOKEN');
  });

  it('getSelectedSettlementSwapPath throws when no paths are available', async () => {
    const { getSelectedSettlementSwapPath } = await import('../src/pages/sandbox/constants');
    const mockSdk = { supportedSettlementSwapPaths: [] };
    expect(() => getSelectedSettlementSwapPath(mockSdk as never)).toThrow(
      'no supported settlement swap paths',
    );
  });

  it('getSelectedSettlementSwapPath returns correct path by index for multi-path hosts', async () => {
    const { getSelectedSettlementSwapPath } = await import('../src/pages/sandbox/constants');
    const mockSdk = {
      supportedSettlementSwapPaths: [
        { settlementTokenType: '0xDEEP', settlementTokenSymbol: 'DEEP', settlementTokenDecimals: 6 },
        { settlementTokenType: '0xUSDC', settlementTokenSymbol: 'USDC', settlementTokenDecimals: 6 },
      ],
    };
    expect(getSelectedSettlementSwapPath(mockSdk as never, 0).settlementTokenSymbol).toBe('DEEP');
    expect(getSelectedSettlementSwapPath(mockSdk as never, 1).settlementTokenSymbol).toBe('USDC');
  });

  it('getSelectedSettlementSwapPath throws on out-of-range path index', async () => {
    const { getSelectedSettlementSwapPath } = await import('../src/pages/sandbox/constants');
    const mockSdk = {
      supportedSettlementSwapPaths: [
        { settlementTokenType: '0xDEEP', settlementTokenSymbol: 'DEEP', settlementTokenDecimals: 6 },
      ],
    };
    expect(() => getSelectedSettlementSwapPath(mockSdk as never, 5)).toThrow('out of range');
  });

  it('isSwapDemoSupported returns true for 1-hop whitelisted, false for hop count > 1', async () => {
    const { isSwapDemoSupported } = await import('../src/pages/sandbox/constants');
    const oneHop = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'DEEP',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
    };
    const invalidHopCount = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'DEEP',
          quoteType: 'USDC',
          swapDirection: 'quoteForBase',
          feeBps: 0,
        },
        {
          poolId: '0x2',
          baseType: 'DEEP',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
    };
    expect(isSwapDemoSupported(oneHop as never)).toBe(true);
    expect(isSwapDemoSupported(invalidHopCount as never)).toBe(false);
  });

  it('isSwapDemoSupported returns false for fee-bearing 1-hop (demo scope limit)', async () => {
    // Fee-bearing 1-hop pools run under DeepBook's input-fee economics, so the
    // fee is charged on the input side and the user receives less settlement token.
    // Handling that requires a min-out / slippage UX that the sandbox demo does
    // not implement.
    const { isSwapDemoSupported } = await import('../src/pages/sandbox/constants');
    const feeBearing = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'TOKEN',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 20,
        },
      ],
    };
    expect(isSwapDemoSupported(feeBearing as never)).toBe(false);
  });

  it('swapDemoRejectReason distinguishes unsupported_hop_count from fee_bearing', async () => {
    const { swapDemoRejectReason } = await import('../src/pages/sandbox/constants');
    const whitelisted1Hop = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'DEEP',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
    };
    const invalidHopCount = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'DEEP',
          quoteType: 'USDC',
          swapDirection: 'quoteForBase',
          feeBps: 0,
        },
        {
          poolId: '0x2',
          baseType: 'DEEP',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
    };
    const feeBearing = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'TOKEN',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 20,
        },
      ],
    };
    expect(swapDemoRejectReason(whitelisted1Hop as never)).toBeNull();
    expect(swapDemoRejectReason(invalidHopCount as never)).toBe('unsupported_hop_count');
    expect(swapDemoRejectReason(feeBearing as never)).toBe('fee_bearing');
  });

  it('getSwapDemoRejectMessage reports fee_bearing reason distinctly from unsupported_hop_count', async () => {
    const { getSwapDemoRejectMessage } = await import('../src/pages/sandbox/constants');
    const invalidHopCount = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'DEEP',
          quoteType: 'USDC',
          swapDirection: 'quoteForBase',
          feeBps: 0,
        },
        {
          poolId: '0x2',
          baseType: 'DEEP',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
    };
    const feeBearing = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'TOKEN',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 20,
        },
      ],
    };
    const invalidHopCountMsg = getSwapDemoRejectMessage(invalidHopCount as never);
    const feeBearingMsg = getSwapDemoRejectMessage(feeBearing as never);
    expect(invalidHopCountMsg).toContain('reports 2 hops');
    expect(feeBearingMsg).toContain('whitelisted');
    expect(feeBearingMsg).toContain('20 bps');
    // Fee-bearing settlement swap paths must not get the hop-count rejection message.
    expect(feeBearingMsg).not.toContain('reports 2 hops');
  });

  it('getSandboxSwapTarget returns correct function for both settlement swap directions', async () => {
    const { getSandboxSwapTarget } = await import('../src/pages/sandbox/constants');
    const bfqPool = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'DEEP',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
    };
    const qfbPool = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'SUI',
          quoteType: 'USDC',
          swapDirection: 'quoteForBase',
          feeBps: 0,
        },
      ],
    };
    expect(getSandboxSwapTarget(bfqPool as never)).toBe('swap_exact_quote_for_base');
    expect(getSandboxSwapTarget(qfbPool as never)).toBe('swap_exact_base_for_quote');
  });

  it('getSandboxSwapTarget throws for pool with hop count > 1', async () => {
    const { getSandboxSwapTarget } = await import('../src/pages/sandbox/constants');
    const invalidHopCount = {
      hops: [
        {
          poolId: '0x1',
          baseType: 'DEEP',
          quoteType: 'USDC',
          swapDirection: 'quoteForBase',
          feeBps: 0,
        },
        {
          poolId: '0x2',
          baseType: 'DEEP',
          quoteType: 'SUI',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
    };
    expect(() => getSandboxSwapTarget(invalidHopCount as never)).toThrow('exactly 1 hop');
  });

  it('parses sandbox decimal amounts without floating-point arithmetic', async () => {
    const { parseDecimalToSmallestUnit, parsePercentToBps } =
      await import('../src/pages/sandbox/amount');
    expect(parseDecimalToSmallestUnit('0.100000001', 9, 'SUI amount')).toBe(100_000_001n);
    expect(parseDecimalToSmallestUnit('1.234567', 6, 'token amount')).toBe(1_234_567n);
    expect(() => parseDecimalToSmallestUnit('1.2345678', 6, 'token amount')).toThrow(
      'more than 6 decimal places',
    );
    expect(parsePercentToBps('2.5', 500, 'slippage')).toBe(250);
    expect(() => parsePercentToBps('2.555', 500, 'slippage')).toThrow('more than 2 decimal places');
  });
});

// ── Page/component exports ─────────────────────────────────────────────────

describe('Page exports', () => {
  it('Home page is exported', async () => {
    const mod = await import('../src/pages/Home');
    expect(mod.default).toBeDefined();
  });

  it('Status page is exported', async () => {
    const mod = await import('../src/pages/Status');
    expect(mod.StatusPage).toBeDefined();
  });

  it('Playground page is exported', async () => {
    const mod = await import('../src/pages/Playground');
    expect(mod.PlaygroundPage).toBeDefined();
  });

  it('Sandbox page is exported', async () => {
    const mod = await import('../src/pages/sandbox');
    expect(mod.SandboxPage).toBeDefined();
  });
});

// ── Endpoint route verification ────────────────────────────────────────────

describe('Endpoint routes', () => {
  it('Status page probes /relay/status and /relay/config', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/pages/Status.tsx'), 'utf-8');
    expect(src).toContain('`${RELAY_API_BASE}/status`');
    expect(src).toContain('`${RELAY_API_BASE}/config`');
  });

  it('Playground endpoints match app-api /relay/* routes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/pages/Playground.tsx'), 'utf-8');
    expect(src).toContain("path: '/relay/status'");
    expect(src).toContain("path: '/relay/config'");
    expect(src).toContain("path: '/relay/prepare'");
    expect(src).toContain("path: '/relay/sponsor'");
  });
});
