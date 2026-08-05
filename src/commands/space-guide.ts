/**
 * `gssh space guide` — review-guide worksheet + validated submission
 * (docs/REVIEW-GUIDE.md). The narrator agent runs analyze, narrates stale
 * clusters, and submits; validation and merging happen here, server-side.
 */
import { readFileSync } from 'fs';
import { buildGuideWorksheet, submitGuideSections, readReviewGuide, guideWorksheetPath, type GuideSection } from '../core/review-guide.js';
import { logger } from '../utils/logger.js';
import type { SpaceCommandContext } from './space-goals.js';

function printJson(value: unknown): void {
  logger.log(JSON.stringify(value, null, 2));
}

export async function guideAnalyze(ctx: SpaceCommandContext, options: { base?: string; json?: boolean }): Promise<void> {
  const worksheet = await buildGuideWorksheet(ctx.project, ctx.workspace, options.base);
  if (options.json) { printJson(worksheet); return; }
  const stale = worksheet.clusters.filter((c) => c.stale);
  logger.success(`Worksheet @ ${worksheet.headSha.slice(0, 7)}: ${worksheet.clusters.length} clusters — ${stale.length} to narrate, ${worksheet.cachedSections} cached.`);
  logger.log(`Worksheet committed to ${guideWorksheetPath(ctx.project, ctx.workspace)} — read it, narrate each stale cluster, then \`gssh space guide submit --file <sections.json>\`.`);
}

export async function guideSubmit(ctx: SpaceCommandContext, options: { file: string; json?: boolean }): Promise<void> {
  const payload = JSON.parse(readFileSync(options.file, 'utf8')) as {
    headSha: string; sections: GuideSection[]; specEvolution?: string;
  };
  const guide = await submitGuideSections(ctx.project, ctx.workspace, payload);
  if (options.json) { printJson({ headSha: guide.headSha, sections: guide.sections.length }); return; }
  logger.success(`Guide committed: ${guide.sections.length} sections @ ${guide.headSha.slice(0, 7)}.`);
}

export function guideShow(ctx: SpaceCommandContext, options: { json?: boolean }): void {
  const guide = readReviewGuide(ctx.project, ctx.workspace);
  if (options.json) { printJson(guide); return; }
  if (!guide) { logger.log('No guide yet — run `gssh space guide analyze`.'); return; }
  logger.log(`Guide @ ${guide.headSha.slice(0, 7)} (${guide.generatedAt}) — ${guide.sections.length} sections:`);
  for (const s of guide.sections) logger.log(`  ${s.kind.padEnd(10)} ${s.title}`);
}
