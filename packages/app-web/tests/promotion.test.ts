/**
 * promotion.test.ts — promotion page wiring, mode gating, canonicalizeTarget parity,
 * S-15 compliance, S-16b security, R-10 coverage, debug panel acceptance.
 */
import { describe, it, expect } from 'vitest';

// ── Page export ────────────────────────────────────────────────────────────

describe('Promotion page exports', () => {
  it('PromotionPage is exported', async () => {
    const mod = await import('../src/pages/promotion');
    expect(mod.PromotionPage).toBeDefined();
  });

  it('default export is PromotionPage', async () => {
    const mod = await import('../src/pages/promotion');
    expect(mod.default).toBe(mod.PromotionPage);
  });
});

// ── useStudioSDK hook ──────────────────────────────────────────────────────

describe('useStudioSDK hook', () => {
  it('exports useStudioSDK function', async () => {
    const mod = await import('../src/pages/promotion/hooks/useStudioSDK');
    expect(typeof mod.useStudioSDK).toBe('function');
  });
});

// ── Mode gating ────────────────────────────────────────────────────────────

describe('Mode gating', () => {
  it('App.tsx contains isStudioMode gate', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf-8');
    expect(src).toContain("VITE_STELIS_UI_MODE === 'studio'");
    expect(src).toMatch(/isStudioMode\s*&&[\s\S]*?path="\/promotion"/);
  });

  it('vite-env.d.ts declares VITE_STELIS_UI_MODE', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/vite-env.d.ts'), 'utf-8');
    expect(src).toContain('VITE_STELIS_UI_MODE');
  });
});

// ── R-10 canonicalizeTarget browser/server parity ──────────────────────────

describe('canonicalizeTarget parity', () => {
  it('browser export matches server export (behavioral parity, not identity)', async () => {
    // tsup bundles @stelis/sdk and @stelis/sdk/server as independent entries, so the
    // function is inlined twice and identity (.toBe) does not hold. The guarantee we
    // care about is behavioral equality: both re-exports must use the same logic
    // from core-relay/canonicalizeTarget.
    const browserMod = await import('@stelis/sdk');
    const serverMod = await import('@stelis/sdk/server');
    const samples: Array<[string, string, string]> = [
      ['0x2', 'coin', 'transfer'],
      ['0x' + 'ab'.repeat(32), 'pool', 'swap_exact_quote_for_base'],
      ['0x0', 'sui', 'SUI'],
    ];
    for (const [pkg, mod, fn] of samples) {
      expect(browserMod.canonicalizeTarget(pkg, mod, fn)).toBe(
        serverMod.canonicalizeTarget(pkg, mod, fn),
      );
    }
  });

  it('produces correct canonical format', async () => {
    const { canonicalizeTarget } = await import('@stelis/sdk');
    const result = canonicalizeTarget('0x2', 'coin', 'transfer');
    expect(result).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000002::coin::transfer',
    );
  });

  it('full-length address passes through unchanged', async () => {
    const { canonicalizeTarget } = await import('@stelis/sdk');
    const fullAddr = '0x' + 'ab'.repeat(32);
    const result = canonicalizeTarget(fullAddr, 'pool', 'swap_exact_quote_for_base');
    expect(result).toBe(`${fullAddr}::pool::swap_exact_quote_for_base`);
  });
});

// ── S-15: GasCoin compliance ───────────────────────────────────────────────

describe('S-15 GasCoin compliance', () => {
  it('StudioExecutionPanel does not use tx.gas or forbidden commands', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/StudioExecutionPanel.tsx'),
      'utf-8',
    );
    // Must not reference GasCoin
    expect(src).not.toMatch(/tx\.gas/);
    // Promotion path: MoveCall-only (no splitCoins, mergeCoins, transferObjects)
    expect(src).not.toContain('splitCoins');
    expect(src).not.toContain('mergeCoins');
    expect(src).not.toContain('transferObjects');
    // Must use MoveCall
    expect(src).toContain('tx.moveCall');
  });
});

// ── Promotion SDK integration ──────────────────────────────────────────────

describe('Promotion SDK integration', () => {
  it('StudioExecutionPanel uses sdk.preparePromotionSponsored (not generic relay)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/StudioExecutionPanel.tsx'),
      'utf-8',
    );
    // Must use promotion-specific prepare method
    expect(src).toMatch(/await\s+sdk\.preparePromotionSponsored\s*\(/);
    // Must use promotion-specific sponsor method
    expect(src).toMatch(/await\s+sdk\.sponsorPromotionSponsored\s*\(/);
    // Must NOT use generic Relay API path
    expect(src).not.toMatch(/sdk\.prepareSponsored/);
    expect(src).not.toMatch(/fetch\s*\(/);
  });

  it('SDK PrepareSponsoredResult includes policyHash', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const typeSrc = fs.readFileSync(path.resolve(__dirname, '../../sdk/src/types.ts'), 'utf-8');
    // PrepareSponsoredResult must include policyHash for debug tooling
    expect(typeSrc).toMatch(/interface PrepareSponsoredResult[\s\S]*?policyHash:\s*string/);
    // authJwtVerified must not be present on PrepareSponsoredResult
    expect(typeSrc).not.toMatch(/interface PrepareSponsoredResult[\s\S]*?authJwtVerified/);
    // policyHash pass-through in sdk.ts
    const sdkSrc = fs.readFileSync(path.resolve(__dirname, '../../sdk/src/sdk.ts'), 'utf-8');
    expect(sdkSrc).toContain('policyHash: prepareRes.policyHash');
  });

  it('SDK exports promotion-specific types', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const indexSrc = fs.readFileSync(path.resolve(__dirname, '../../sdk/src/index.ts'), 'utf-8');
    expect(indexSrc).toContain('PromotionPrepareResponse');
    expect(indexSrc).toContain('PromotionSponsorResponse');
    expect(indexSrc).toContain('ExecutePromotionSponsoredOptions');
    expect(indexSrc).toContain('ExecutePromotionSponsoredResult');
    expect(indexSrc).toContain('PromotionListResponse');
    expect(indexSrc).toContain('PromotionDetailResponse');
  });
});

// ── R-10: MoveCall target presence ─────────────────────────────────────────

describe('R-10 allowedTargets coverage', () => {
  it('StudioExecutionPanel tracks moveCallTargets for debug', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/StudioExecutionPanel.tsx'),
      'utf-8',
    );
    // Must track moveCallTargets in debug entries
    expect(src).toContain('moveCallTargets');
  });
});

// ── Promotion page inputs ─────────────────────────────────────────────────

describe('Promotion page inputs', () => {
  it('PromotionPage has promotionId input', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/index.tsx'),
      'utf-8',
    );
    // Must have promotionId state
    expect(src).toContain('promotionId');
    expect(src).toContain('setPromotionId');
    // Must pass promotionId to StudioExecutionPanel
    expect(src).toContain('promotionId={promotionId}');
    // Must NOT have settlement swap path selector (promotion path does not use settlementTokenType)
    expect(src).not.toContain('settlementSwapPathIndex');
  });
});

// ── AllowedTargets auto-fill ───────────────────────────────────────────────

describe('AllowedTargets auto-fill', () => {
  it('AllowedTargetsBuilder has auto-fill for test TX targets', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/AllowedTargetsBuilder.tsx'),
      'utf-8',
    );
    // Must auto-fill both MoveCall targets used by StudioExecutionPanel
    expect(src).toContain('autoFillTestTargets');
    expect(src).toContain("'0x2', 'coin', 'zero'");
    expect(src).toContain("'0x2', 'coin', 'destroy_zero'");
  });

  it('AllowedTargetsBuilder and StudioExecutionPanel use the same MoveCall targets', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const builderSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/AllowedTargetsBuilder.tsx'),
      'utf-8',
    );
    const panelSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/StudioExecutionPanel.tsx'),
      'utf-8',
    );
    // Both generated paths must reference coin::zero and coin::destroy_zero
    expect(builderSrc).toContain("'0x2', 'coin', 'zero'");
    expect(builderSrc).toContain("'0x2', 'coin', 'destroy_zero'");
    expect(panelSrc).toContain("'0x2::coin::zero'");
    expect(panelSrc).toContain("'0x2::coin::destroy_zero'");
    // Panel must use MoveCall (not forbidden commands)
    expect(panelSrc).toContain('tx.moveCall');
    expect(panelSrc).not.toContain('tx.splitCoins');
    expect(panelSrc).not.toContain('tx.transferObjects');
    // Panel must consume the coin::zero result (Coin<T> has no drop)
    expect(panelSrc).toContain('zeroCoin');
  });
});

// ── Debug panel acceptance ─────────────────────────────────────────────────

describe('Debug panel fields', () => {
  it('StudioExecutionPanel captures promotion prepare response fields', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/StudioExecutionPanel.tsx'),
      'utf-8',
    );
    // Promotion prepare response fields
    expect(src).toContain('prepared.receiptId');
    expect(src).toContain('prepared.estimatedGasMist');
  });

  it('StudioExecutionPanel logs both request and response summaries', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/StudioExecutionPanel.tsx'),
      'utf-8',
    );
    // The panel should show prepare/sponsor request and response summaries.
    expect(src).toContain("label: 'Prepare Request'");
    expect(src).toContain("label: 'Prepare Response'");
    expect(src).toContain("label: 'Sponsor Request'");
    expect(src).toContain("label: 'Sponsor Response'");
    // Prepare request: promotionId and senderAddress
    expect(src).toContain('senderAddress: account.address');
    expect(src).toContain('promotionId');
    // Sponsor request: receiptId
    expect(src).toContain('receiptId: prepared.receiptId');
  });

  it('StudioExecutionPanel shows structured error codes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/StudioExecutionPanel.tsx'),
      'utf-8',
    );
    // Must import StelisApiException for structured error handling
    expect(src).toContain("import { StelisApiException } from '@stelis/sdk'");
    // Must instanceof check to extract code/status/meta
    expect(src).toContain('err instanceof StelisApiException');
    // Must show code and status in debug entry
    expect(src).toContain('code: err.code');
    expect(src).toContain('status: err.status');
    // Must show meta (extra fields)
    expect(src).toContain('err.meta');
  });
});

// ── Developer JWT panel (paste-only) ────────────────────────────────────────

describe('DeveloperJwtPanel (paste-only)', () => {
  it('DeveloperJwtPanel does not call /studio/issue-jwt', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const panelSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/DeveloperJwtPanel.tsx'),
      'utf-8',
    );

    // Must NOT reference /studio/issue-jwt endpoint or related state
    expect(panelSrc).not.toContain('/studio/issue-jwt');
    expect(panelSrc).not.toContain('handleIssueJwt');
    expect(panelSrc).not.toContain('TabId');
    // Must export DeveloperJwtPanel
    expect(panelSrc).toContain('DeveloperJwtPanel');
  });
});

// ── Component exports ──────────────────────────────────────────────────────

describe('Promotion component exports', () => {
  it('ConnectionPanel is exported', async () => {
    const mod = await import('../src/pages/promotion/components/ConnectionPanel');
    expect(mod.ConnectionPanel).toBeDefined();
  });

  it('DeveloperJwtPanel is exported', async () => {
    const mod = await import('../src/pages/promotion/components/DeveloperJwtPanel');
    expect(mod.DeveloperJwtPanel).toBeDefined();
  });

  it('AllowedTargetsBuilder is exported', async () => {
    const mod = await import('../src/pages/promotion/components/AllowedTargetsBuilder');
    expect(mod.AllowedTargetsBuilder).toBeDefined();
  });

  it('DebugPanel is exported', async () => {
    const mod = await import('../src/pages/promotion/components/DebugPanel');
    expect(mod.DebugPanel).toBeDefined();
  });

  it('StudioExecutionPanel is exported', async () => {
    const mod = await import('../src/pages/promotion/components/StudioExecutionPanel');
    expect(mod.StudioExecutionPanel).toBeDefined();
  });
});

// ── No-synthetic-runtime-defaults compliance ───────────────────────────────

describe('No-synthetic-runtime-defaults policy', () => {
  it('ConnectionPanel does not hardcode a runtime endpoint default', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/ConnectionPanel.tsx'),
      'utf-8',
    );
    // AGENTS.md: no hardcoded security-critical runtime values outside test scope.
    // Endpoint should be empty by default; placeholder text is fine.
    expect(src).not.toContain("useState(endpoint || 'http");
    expect(src).not.toContain("useState('http");
    // Placeholder is allowed
    expect(src).toContain('placeholder=');
  });
});

// ── Transport parity ───────────────────────────────────────────────────────

describe('Endpoint transport parity', () => {
  it('useStudioSDK normalizes endpoint (trailing slash strip)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/hooks/useStudioSDK.ts'),
      'utf-8',
    );
    // Must strip trailing slashes — matches StelisClient constructor (client.ts L39)
    expect(src).toContain(".replace(/\\/+$/, '')");
  });

  it('StudioExecutionPanel uses SDK methods (no raw fetch)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/StudioExecutionPanel.tsx'),
      'utf-8',
    );
    // Promotion path uses SDK methods, no raw fetch or timeout constants needed
    expect(src).not.toContain('AbortSignal.timeout');
    expect(src).toContain('sdk.preparePromotionSponsored');
    expect(src).toContain('sdk.sponsorPromotionSponsored');
  });

  it('DeveloperJwtPanel is a paste-only component (no fetch, no timeout)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/pages/promotion/components/DeveloperJwtPanel.tsx'),
      'utf-8',
    );
    // Paste-only panel has no network calls
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('AbortSignal');
    expect(src).not.toContain('REQUEST_TIMEOUT_MS');
  });
});
