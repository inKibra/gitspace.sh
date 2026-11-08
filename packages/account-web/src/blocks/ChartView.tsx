import type { gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { badgeColors } from '@gitspace/ui';
import type { ReactElement } from 'react';
import type { z } from 'zod';

type ChartProps = z.output<typeof gitspaceUiCatalog.components.Chart.props>;
type Unit = ChartProps['unit'];

const LABEL_FONT = '12px var(--font-sans, system-ui)';
const VALUE_FONT = '11px ui-monospace, monospace';
const WIDTH = 640;

/** A value as its unit reads: ms as seconds, bytes in the largest of KB, MB and GB that keeps it at 1 or more. */
export function formatChartValue(value: number, unit: Unit): string {
  switch (unit) {
    case 'ms': return `${(value / 1000).toFixed(1)} s`;
    case 'seconds': return `${value.toFixed(1)} s`;
    case 'percent': return `${value}%`;
    case 'bytes': {
      const [size, suffix] = value >= 2 ** 30 ? [value / 2 ** 30, 'GB'] : value >= 2 ** 20 ? [value / 2 ** 20, 'MB'] : value >= 2 ** 10 ? [value / 2 ** 10, 'KB'] : [value, 'B'];
      return `${suffix === 'B' ? size : size.toFixed(1)} ${suffix}`;
    }
    case 'usd': return `$${value.toLocaleString('en-US', { minimumFractionDigits: value < 10 ? 2 : 0, maximumFractionDigits: 2 })}`;
    case 'tokens': return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M tokens` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k tokens` : `${value} tokens`;
    case 'count': return value.toLocaleString('en-US');
  }
}

/** Horizontal bars: one group per row, one bar per series, or with `stacked` one bar per row of its series end to end. */
function Bars({ props, max, stacked }: { props: ChartProps; max: number; stacked: boolean }): ReactElement {
  const barHeight = 12;
  const groupHeight = (stacked ? 1 : props.series.length) * (barHeight + 3) + 10;
  const labelWidth = 230;
  const track = WIDTH - labelWidth - 80;
  return <svg viewBox={`0 0 ${WIDTH} ${props.rows.length * groupHeight}`} className="w-full" role="img" aria-label={props.title ?? 'Bar chart'}>
    {props.rows.map((row, rowIndex) => {
      const top = rowIndex * groupHeight;
      let offset = 0;
      const total = props.series.reduce((sum, series) => sum + (row.values[series.key] ?? 0), 0);
      return <g key={`${rowIndex}:${row.label}`}>
        <text x={0} y={top + groupHeight / 2} dominantBaseline="middle" style={{ font: LABEL_FONT, fill: 'var(--foreground)' }}>{row.label}</text>
        <rect x={labelWidth} y={top + 2} width={track} height={groupHeight - 8} rx={4} style={{ fill: 'var(--surface-2)' }} />
        {props.series.map((series, seriesIndex) => {
          const value = row.values[series.key] ?? 0;
          const length = Math.max(stacked ? 0 : 2, (value / max) * track);
          const x = labelWidth + (stacked ? offset : 0);
          const y = top + 5 + (stacked ? 0 : seriesIndex * (barHeight + 3));
          offset += length;
          return <g key={series.key}>
            <rect x={x} y={y} height={barHeight} rx={stacked ? 0 : 3} style={{ width: length, fill: badgeColors[series.color], transition: 'width 350ms cubic-bezier(.2,.8,.2,1)' }}><title>{`${series.label}: ${formatChartValue(value, props.unit)}`}</title></rect>
            {stacked ? null : <text x={x + length + 6} y={y + barHeight / 2} dominantBaseline="middle" style={{ font: VALUE_FONT, fill: 'var(--muted-foreground)' }}>{formatChartValue(value, props.unit)}</text>}
          </g>;
        })}
        {stacked ? <text x={labelWidth + offset + 6} y={top + 5 + barHeight / 2} dominantBaseline="middle" style={{ font: VALUE_FONT, fill: 'var(--muted-foreground)' }}>{formatChartValue(total, props.unit)}</text> : null}
      </g>;
    })}
  </svg>;
}

/** The smallest vertical distance between two end labels of a line chart. */
const LABEL_GAP = 13;

/** Vertical axes for columns and lines: a value scale on the left with three gridlines, row labels along the bottom.
 * Each line ends in its last value, to its right, the labels pushed apart where lines end close together; a column
 * shows its value above it when it is wide enough to hold it. */
function Plot({ props, max, line }: { props: ChartProps; max: number; line: boolean }): ReactElement {
  const height = 220;
  const left = 64, right = line ? 76 : 16, top = 16, bottom = 28;
  const plotWidth = WIDTH - left - right, plotHeight = height - top - bottom;
  const y = (value: number): number => top + plotHeight - (Math.min(value, max) / max) * plotHeight;
  const slot = plotWidth / Math.max(1, props.rows.length);
  const center = (index: number): number => left + slot * index + slot / 2;
  const groupWidth = Math.min(slot * 0.7, props.series.length * 40);
  const columnWidth = groupWidth / Math.max(1, props.series.length);
  const lines = props.series.map((series) => ({ series, points: props.rows.map((row, index) => ({ x: center(index), y: y(row.values[series.key] ?? 0), value: row.values[series.key] ?? 0 })) }));
  // End labels from the top down, each at least LABEL_GAP below the one above it.
  const ends = lines.flatMap(({ series, points }) => { const last = points.at(-1); return last ? [{ series, last, at: last.y }] : []; }).sort((a, b) => a.at - b.at);
  ends.forEach((end, index) => { const above = ends[index - 1]; if (above && end.at - above.at < LABEL_GAP) end.at = above.at + LABEL_GAP; });
  return <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label={props.title ?? (line ? 'Line chart' : 'Column chart')}>
    {[0, 0.5, 1].map((fraction) => <g key={fraction}>
      <line x1={left} x2={WIDTH - right} y1={y(max * fraction)} y2={y(max * fraction)} style={{ stroke: 'var(--border)', strokeWidth: 1 }} />
      <text x={left - 6} y={y(max * fraction)} textAnchor="end" dominantBaseline="middle" style={{ font: VALUE_FONT, fill: 'var(--muted-foreground)' }}>{formatChartValue(max * fraction, props.unit)}</text>
    </g>)}
    {props.rows.map((row, index) => <text key={`${index}:${row.label}`} x={center(index)} y={height - 8} textAnchor="middle" style={{ font: LABEL_FONT, fill: 'var(--foreground)' }}>{row.label}</text>)}
    {line
      ? <>
        {lines.map(({ series, points }) => <g key={series.key}>
          <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} style={{ fill: 'none', stroke: badgeColors[series.color], strokeWidth: 2 }} />
          {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={3} style={{ fill: badgeColors[series.color] }}><title>{`${series.label}, ${props.rows[index]?.label ?? ''}: ${formatChartValue(point.value, props.unit)}`}</title></circle>)}
        </g>)}
        {ends.map(({ series, last, at }) => <text key={series.key} x={last.x + 8} y={at} dominantBaseline="middle" style={{ font: VALUE_FONT, fill: badgeColors[series.color] }}>{formatChartValue(last.value, props.unit)}</text>)}
      </>
      : props.rows.map((row, index) => <g key={`${index}:${row.label}`}>{props.series.map((series, seriesIndex) => {
        const value = row.values[series.key] ?? 0;
        const x = center(index) - groupWidth / 2 + seriesIndex * columnWidth;
        return <g key={series.key}>
          <rect x={x + 1} y={y(value)} width={Math.max(1, columnWidth - 2)} height={top + plotHeight - y(value)} rx={2} style={{ fill: badgeColors[series.color] }}><title>{`${series.label}, ${row.label}: ${formatChartValue(value, props.unit)}`}</title></rect>
          {columnWidth >= 32 ? <text x={x + columnWidth / 2} y={y(value) - 4} textAnchor="middle" style={{ font: VALUE_FONT, fill: 'var(--muted-foreground)' }}>{formatChartValue(value, props.unit)}</text> : null}
        </g>;
      })}</g>)}
  </svg>;
}

/** A Chart block: its kind's drawing, its title above and its series' key below. */
export function ChartView({ props }: { props: ChartProps }): ReactElement {
  const kind = props.kind ?? 'bars';
  const largest = kind === 'stacked'
    ? Math.max(1, ...props.rows.map((row) => props.series.reduce((sum, series) => sum + (row.values[series.key] ?? 0), 0)))
    : Math.max(1, ...props.rows.flatMap((row) => props.series.map((series) => row.values[series.key] ?? 0)));
  const max = props.max ?? largest * 1.15;
  return <figure className="flex flex-col gap-2" data-chart-kind={kind}>
    {props.title ? <figcaption className="text-caption font-medium text-muted-foreground">{props.title}</figcaption> : null}
    {kind === 'bars' || kind === 'stacked' ? <Bars props={props} max={max} stacked={kind === 'stacked'} /> : <Plot props={props} max={max} line={kind === 'line'} />}
    <div className="flex flex-wrap gap-3 text-caption text-muted-foreground">
      {props.series.map((series) => <span key={series.key} className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm" style={{ background: badgeColors[series.color] }} />{series.label}</span>)}
    </div>
  </figure>;
}
