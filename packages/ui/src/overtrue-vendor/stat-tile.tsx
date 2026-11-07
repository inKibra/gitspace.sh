// Adapted from overtrue/ui `stat-card.tsx` (MIT, see LICENSE in this folder): the headline number with its unit set
// quieter than the digits, on the Fluid token set instead of shadcn's Card; no icon, change pill or sparkline.
import type { ReactNode } from "react";
import { badgeColors } from "../fluid-vendor/components/ui/badge.js";
import { cn } from "../fluid-vendor/lib/utils.js";

export type StatTileTone = "neutral" | "good" | "bad";

export interface StatTileProps {
  label: string;
  value: string | number;
  detail?: string;
  tone?: StatTileTone;
  className?: string;
}

const TONE_COLOR: Record<StatTileTone, string | undefined> = {
  neutral: undefined,
  good: badgeColors.green,
  bad: badgeColors.red,
};

// A short trailing unit ("3.7 s", "253 ms", "−23%") sits quieter than the digits; anything else stays as written.
function typeset(text: string): ReactNode {
  const match = /^([+\-−]?\d(?:[\d.,  ]*\d)?)(%|\s?[A-Za-zµ]{1,4})$/u.exec(text);
  if (!match) return text;
  const [, digits, unit] = match;
  return <>{digits}<span className="text-[0.62em] font-medium tracking-normal opacity-60">{unit}</span></>;
}

export function StatTile({ label, value, detail, tone = "neutral", className }: StatTileProps) {
  return (
    <div data-slot="stat-tile" data-tone={tone} className={cn("flex min-w-0 flex-col gap-0.5 rounded-xl border border-border bg-surface-2 px-3 py-2", className)}>
      <span data-slot="stat-tile-label" className="text-caption text-muted-foreground">{label}</span>
      <span data-slot="stat-tile-value" className="text-[20px] font-semibold tracking-[-0.02em] tabular-nums [overflow-wrap:anywhere]" style={{ color: TONE_COLOR[tone] }}>
        {typeset(typeof value === "number" ? value.toLocaleString("en-US") : value)}
      </span>
      {detail ? <span data-slot="stat-tile-detail" className="text-caption text-muted-foreground">{detail}</span> : null}
    </div>
  );
}
