# @sentinel/shared-ui

Small, dependency-free presentational React components and audit primitives shared by the
web app. **Server-component friendly** (no hooks). Two styling conventions coexist:

- **Inline-styled** components (`StatCard`, `Card`, `SeverityBadge`, …) carry their own colors
  and render anywhere with no CSS pipeline.
- **Class-based** components (`Readout`, `NoAudit`) use the app's `globals.css` token classes
  (`.cat-identity`, `.cat-stat`, `.cat-empty`, `.btn`, …), they only render *styled* inside the
  web app that ships those tokens. This keeps the enterprise design system as the single source
  of truth for color/spacing.

## Audit primitives (added for the catalog redesign)

| Export | Kind | Purpose |
| --- | --- | --- |
| `PLATFORM_CODE`, `platformCode(store)` | data / fn | Two-letter platform codes for dense pip strips (`Deezer → DZ`). Fallback: first two letters uppercased. |
| `statusClass(status)` → `'live'\|'gap'\|'wrong'\|'unk'` | fn | Maps a per-store presence status to a status-pill class. `live→live`, `not-live→gap`, `wrong-profile→wrong`, else `unk`. |
| `csvEscape(v)` | fn | Quote a CSV field containing `,` `"` or newline. |
| `downloadCsv(filename, rows)` | fn (client) | Build a CSV from a `(string\|number)[][]` matrix and trigger a browser download. |
| `Readout` | component | Identity block (eyebrow + name) with a right-aligned `ReadoutStat[]` readout. Each stat takes an optional `tone: 'ok'\|'warn'\|'bad'`. |
| `NoAudit` | component | "No audit run yet" empty state with the standard CTA (`href` defaults to `/connect`). |

### Consumers

- `Readout`, Catalog, Coverage, Manual review, Support center headers.
- `NoAudit`, the empty state on all four audit pages.
- `platformCode` / `statusClass`, Catalog + Manual review pip strips.
- `downloadCsv` / `csvEscape`, Catalog CSV + Support-center evidence exports.

### Example

```tsx
import { Readout, NoAudit, platformCode, statusClass, downloadCsv } from '@sentinel/shared-ui';

if (!record) return <NoAudit message="No audit has been run yet." />;

<Readout
  eyebrow={`Catalog · ${date}`}
  title={record.artist}
  stats={[
    { value: summary.tracks, label: 'tracks' },
    { value: summary.live, label: 'confirmed', tone: 'ok' },
    { value: summary.notLive, label: 'not confirmed', tone: summary.notLive ? 'warn' : undefined },
  ]}
/>;

<span className={`pip ${statusClass(cell.status)}`}>{platformCode(cell.store)}</span>;

downloadCsv('catalog.csv', [['Track', 'Status'], ['Icy Love', 'live']]);
```

> A full Storybook was intentionally deferred: it's a heavy install with React 19 / Next 15
> monorepo compatibility caveats and adds no customer-facing value. This catalog + the typed
> exports serve as the component reference. Revisit if a visual regression harness is needed.
