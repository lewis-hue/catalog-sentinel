import { platformCode } from '@sentinel/shared-ui';

/** The four evidence verdicts, in severity order, with their token colours. */
const STATUS_KEY: Array<{ tone: string; label: string }> = [
  { tone: 'live', label: 'Confirmed live' },
  { tone: 'gap', label: 'Not confirmed' },
  { tone: 'wrong', label: 'Wrong profile' },
  { tone: 'unk', label: 'Unverifiable' },
];

/**
 * A scannable legend for the coverage grid: the verdict colour key, then the two-letter store codes
 * as a wrapping chip grid. Replaces a dense run-on sentence so the reference reads at a glance.
 */
export function CoverageLegend({ stores }: { stores: string[] }) {
  return (
    <section className="cov-legend" aria-label="Coverage legend">
      <div className="cov-legend-status">
        {STATUS_KEY.map((s) => (
          <span key={s.tone} className="cov-key">
            <span className={`cov-dot ${s.tone}`} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>
      <div className="cov-legend-codes">
        {stores.map((store) => (
          <span key={store} className="cov-code-item">
            <span className="cov-code">{platformCode(store)}</span>
            <span className="cov-code-name">{store}</span>
          </span>
        ))}
      </div>
    </section>
  );
}
