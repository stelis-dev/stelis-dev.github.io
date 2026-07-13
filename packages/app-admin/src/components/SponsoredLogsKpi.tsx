/**
 * SponsoredLogsKpi — shared KPI card grid rendered on the Dashboard
 * (mode='all' summary) and the Sponsored Logs page (mode-filterable
 * summary).
 *
 * Display contract:
 *   - Aggregate counts and MIST amounts are exact decimal strings from
 *     the API. Only MIST fields pass through `mistToSui`; counts use
 *     integer-only compaction.
 *   - Losses and sponsored executions are displayed as
 *     `lossCount / sponsoredExecutions`; count compaction is display-only
 *     and the exact API strings remain available in the value title.
 *   - Cumulative loss is rendered with a warning style so the operator
 *     notices the loss without parsing the sign.
 *   - Aggregate is always read from the durable backend; this component
 *     does NOT compute lifetime totals from row lists.
 */

import { mistToSui } from '../utils';
import type { SponsoredExecutionAggregate } from '../api/client';

const NEGATIVE_STYLE: React.CSSProperties = { color: '#f87171' };
const UNSIGNED_DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const COUNT_UNITS: readonly { value: bigint; suffix: string }[] = [
  { value: 1_000_000_000_000n, suffix: 'T' },
  { value: 1_000_000_000n, suffix: 'B' },
  { value: 1_000_000n, suffix: 'M' },
  { value: 1_000n, suffix: 'K' },
];

function isNegativeMistString(value: string): boolean {
  return value.startsWith('-') && value !== '-0';
}

function formatCompactCount(value: string): string {
  if (!UNSIGNED_DECIMAL_RE.test(value)) return '—';
  const count = BigInt(value);
  for (const unit of COUNT_UNITS) {
    if (count < unit.value) continue;
    const scaledTenths = (count * 10n) / unit.value;
    const whole = scaledTenths / 10n;
    const tenths = scaledTenths % 10n;
    return tenths === 0n ? `${whole}${unit.suffix}` : `${whole}.${tenths}${unit.suffix}`;
  }
  return count.toString();
}

export interface SponsoredLogsKpiProps {
  /** Aggregate summary fetched from the admin API. */
  readonly summary: SponsoredExecutionAggregate | null;
  /** Loading state — render dimmed placeholders. */
  readonly loading?: boolean;
}

export function SponsoredLogsKpi({ summary, loading }: SponsoredLogsKpiProps) {
  const placeholder = '—';
  const lossCount = summary ? summary.lossCount : placeholder;
  const lossExecutionRatio = summary
    ? `${formatCompactCount(summary.lossCount)} / ${formatCompactCount(summary.sponsoredExecutions)}`
    : `${placeholder} / ${placeholder}`;
  const cumulativeNetMist = summary ? summary.cumulativeHostNetMist : null;
  const cumulativeLossMist = summary ? summary.cumulativeLossMist : null;

  const cumulativeNetSui = cumulativeNetMist ? mistToSui(cumulativeNetMist) : placeholder;
  const cumulativeNetNegative =
    cumulativeNetMist !== null && isNegativeMistString(cumulativeNetMist);
  const cumulativeLossSui = cumulativeLossMist ? mistToSui(cumulativeLossMist) : placeholder;
  const cumulativeLossNegative =
    cumulativeLossMist !== null && isNegativeMistString(cumulativeLossMist);

  const opacity = loading ? 0.6 : 1;

  const ratioTitle = summary
    ? `${summary.lossCount} losses / ${summary.sponsoredExecutions} sponsored executions`
    : undefined;

  return (
    <div
      className="admin-stat-grid sponsored-kpi-grid"
      style={{ opacity, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
    >
      <div className="admin-card">
        <div className="admin-card-title">Cumulative Net</div>
        <div
          style={{
            fontSize: 28,
            fontFamily: "'JetBrains Mono', monospace",
            ...(cumulativeNetNegative ? NEGATIVE_STYLE : null),
          }}
        >
          {cumulativeNetSui} SUI
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>sum of host net</div>
      </div>

      <div className="admin-card">
        <div className="admin-card-title">Cumulative Loss</div>
        <div
          style={{
            fontSize: 28,
            fontFamily: "'JetBrains Mono', monospace",
            ...(cumulativeLossNegative ? NEGATIVE_STYLE : null),
          }}
        >
          {cumulativeLossSui} SUI
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>sum of negative host net</div>
      </div>

      <div className="admin-card">
        <div className="admin-card-title">Loss / Executions</div>
        <div
          title={ratioTitle}
          style={{
            fontSize: 28,
            fontFamily: "'JetBrains Mono', monospace",
            ...(lossCount !== placeholder && lossCount !== '0' ? NEGATIVE_STYLE : null),
          }}
        >
          {lossExecutionRatio}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
          losses / sponsored executions
        </div>
      </div>
    </div>
  );
}
