import {
  changeGuideWorksheetSchema,
  submitChangeGuideInputSchema,
  type ChangeGuideDraft,
  type ChangeGuideWorksheet,
  type InspectorOverview,
  type JournalEntryView,
  type SubmitChangeGuideInput,
} from '@gitspace/protocol/inspector-contract';
import { analyzeReviewDiff } from './change-guide-analysis.js';

export class ChangeGuideGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeGuideGenerationError';
  }
}

export interface ChangeGuideAnalysisContext {
  projectId: string;
  spaceId: string;
  repositoryPath: string;
  generation: number;
  baseRef: string;
  overview: InspectorOverview;
  journal: readonly JournalEntryView[];
}

export function buildChangeGuideWorksheet(context: ChangeGuideAnalysisContext): ChangeGuideWorksheet {
  const analysis = analyzeReviewDiff(context.repositoryPath, context.baseRef);
  if (!analysis.covered) throw new ChangeGuideGenerationError('Change Guide analysis did not cover every changed file');
  const cached = new Map((context.overview.changeGuide?.sections ?? []).map((section) => [section.id, section]));
  return changeGuideWorksheetSchema.parse({
    projectId: context.projectId,
    spaceId: context.spaceId,
    headCommit: analysis.headSha,
    baseRef: analysis.baseRef,
    guideRevision: context.overview.changeGuide?.revision ?? 0,
    covered: analysis.covered,
    clusters: analysis.clusters.map((cluster) => {
      const files = new Set(cluster.files);
      const journal = context.journal.filter((entry) => entry.evidence.some((evidence) => evidence.kind === 'git' && files.has(evidence.path)));
      const cachedSection = cached.get(cluster.id) ?? null;
      return {
        id: cluster.id,
        contentHash: cluster.contentHash,
        kind: cluster.type,
        files: cluster.files,
        order: cluster.order,
        readingCost: cluster.signals.readingCost,
        stale: cachedSection?.contentHash !== cluster.contentHash,
        beat: cluster.signals.beat ? {
          component: cluster.signals.beat.component,
          sequence: cluster.signals.beat.seq,
          total: cluster.signals.beat.of,
        } : null,
        journal: journal.map((entry) => ({
          entryId: entry.id,
          phase: entry.phase || null,
          title: entry.title,
          body: entry.body,
          outcome: entry.outcome,
          decisions: entry.decisions,
          requirementsAdvanced: entry.delta?.requirementsAdvanced.map((requirement) => requirement.id) ?? [],
        })),
        cachedSection,
      };
    }),
  });
}

export function validateChangeGuideNarration(
  worksheet: ChangeGuideWorksheet,
  inputValue: SubmitChangeGuideInput,
): ChangeGuideDraft {
  const input = submitChangeGuideInputSchema.parse(inputValue);
  if (input.projectId !== worksheet.projectId || input.spaceId !== worksheet.spaceId) {
    throw new ChangeGuideGenerationError('Change Guide submission targets another space');
  }
  if (input.headCommit !== worksheet.headCommit || input.baseRef !== worksheet.baseRef) {
    throw new ChangeGuideGenerationError('Repository HEAD or base moved after Change Guide analysis');
  }
  if (input.expectedRevision !== worksheet.guideRevision) {
    throw new ChangeGuideGenerationError(`Change Guide revision moved from ${worksheet.guideRevision} to ${input.expectedRevision}`);
  }
  const submitted = new Map(input.sections.map((section) => [section.id, section]));
  const clusters = new Map(worksheet.clusters.map((cluster) => [cluster.id, cluster]));
  for (const section of input.sections) {
    const cluster = clusters.get(section.id);
    if (!cluster) throw new ChangeGuideGenerationError(`Section ${section.id} does not match an analyzed cluster`);
    if (section.contentHash !== cluster.contentHash) throw new ChangeGuideGenerationError(`Section ${section.id} was narrated against stale content`);
    const members = new Set(cluster.files);
    const stray = section.exhibits.find((exhibit) => !members.has(exhibit.path));
    if (stray) throw new ChangeGuideGenerationError(`Exhibit ${stray.path} is outside section ${section.id}`);
    const advanced = new Set(cluster.journal.flatMap((entry) => entry.requirementsAdvanced));
    const unsupported = section.requirementIds.find((requirementId) => !advanced.has(requirementId));
    if (unsupported) throw new ChangeGuideGenerationError(`Section ${section.id} claims requirement ${unsupported} without Journal evidence`);
  }
  const sections = worksheet.clusters
    .sort((left, right) => left.order - right.order)
    .map((cluster) => {
      const section = submitted.get(cluster.id);
      if (section) return section;
      if (!cluster.stale && cluster.cachedSection) return cluster.cachedSection;
      throw new ChangeGuideGenerationError(`Stale cluster ${cluster.id} requires narration`);
    });
  return {
    headCommit: input.headCommit,
    baseRef: input.baseRef,
    title: input.title,
    sections,
    createdBy: input.createdBy,
  };
}
