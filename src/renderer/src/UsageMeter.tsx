import { formatUsage, monthLabel, nextMonthStart, usageLevel, usagePercent, type RelayUsage } from '../../shared/usage'

export function UsageMeter({ usage, compact = false }: { usage: RelayUsage; compact?: boolean }): React.JSX.Element {
  const level = usageLevel(usage.estGB, usage.capGB)
  const percent = usagePercent(usage.estGB, usage.capGB)
  return (
    <div className={`usage-meter usage-${level}${compact ? ' usage-compact' : ''}`}>
      <div className="usage-head">
        <span className="usage-label">Cloudflare usage ({monthLabel(usage.month)})</span>
        <span className="usage-text">{formatUsage(usage)}</span>
      </div>
      <div
        className="usage-track"
        role="progressbar"
        aria-label={`Cloudflare relay usage: ${formatUsage(usage)}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className="usage-fill" style={{ width: `${percent}%` }} />
      </div>
      {level === 'capped' && <p className="usage-capped-note">Relay paused until {nextMonthStart(usage.month)}</p>}
      {!compact && <p className="usage-hint">Estimate. Exact numbers: Cloudflare dashboard → Realtime.</p>}
    </div>
  )
}
