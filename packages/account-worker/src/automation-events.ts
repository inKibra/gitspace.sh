import { z } from 'zod';
import {
  AUTOMATION_GITHUB_EVENTS,
  AUTOMATION_START_LABELS,
  AutomationSubjectSchema,
  automationSubjectName,
  type AutomationGitHubEvent,
  type AutomationSubject,
  type AutomationTrigger,
} from '@gitspace/protocol/automations-contract';

/** Text fields (descriptions, comments, reviews) are kept up to this many characters. */
const MAX_TEXT = 4_000;
/** A pull request names the issues it closes with GitHub's closing keywords. */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/giu;

/** A GitHub delivery as automations read it: trimmed to the fields their conditions and instructions read. */
export const AutomationEventSchema = z.object({
  deliveryId: z.string(),
  receivedAt: z.number(),
  event: z.enum(AUTOMATION_GITHUB_EVENTS),
  action: z.string().nullable(),
  repository: z.string(),
  /** Whose trust decides whether it runs (docs/AUTOMATIONS-DESIGN.md §5): the author of a pull request or issue, the
   * commenter or reviewer, the pusher, or whoever labeled, closed or reopened it. Null for a check suite, which carries
   * only GitHub's result. */
  actor: z.string().nullable(),
  /** This account's GitHub App sent it: GitSpace acted. */
  fromApp: z.boolean(),
  /** The author conditions read: of the pull request or issue, the comment or review, or the push. */
  author: z.string().nullable(),
  /** What it is about, first the subject; a check suite names its pull requests, then its branch. */
  subjects: z.array(AutomationSubjectSchema),
  baseBranch: z.string().nullable(),
  headBranch: z.string().nullable(),
  branch: z.string().nullable(),
  draft: z.boolean().nullable(),
  labels: z.array(z.string()).nullable(),
  /** The label a `labeled` action added. */
  label: z.string().nullable(),
  /** A push's changed paths; a pull request's are read from GitHub when a condition needs them. */
  changedFiles: z.array(z.string()).nullable(),
  conclusion: z.string().nullable(),
  reviewState: z.string().nullable(),
  mentionsBot: z.boolean(),
  merged: z.boolean().nullable(),
  /** Issues a pull request's description closes ("Fixes #388"). */
  closes: z.array(z.number().int().positive()),
  /** Values instructions name in `{{…}}`. */
  fields: z.record(z.string(), z.string()),
});
export type AutomationEvent = z.infer<typeof AutomationEventSchema>;

const UserSchema = z.object({ login: z.string() }).nullish();
const LabelsSchema = z.array(z.object({ name: z.string() })).optional();
const PullRequestSchema = z.object({
  number: z.number().int().positive(), title: z.string(), html_url: z.string(), body: z.string().nullish(),
  draft: z.boolean().optional(), merged: z.boolean().nullish(), user: UserSchema,
  base: z.object({ ref: z.string() }), head: z.object({ ref: z.string() }), labels: LabelsSchema,
});
const IssueSchema = z.object({
  number: z.number().int().positive(), title: z.string(), html_url: z.string(), body: z.string().nullish(), user: UserSchema,
  labels: LabelsSchema, pull_request: z.object({}).optional(),
});
const CommentSchema = z.object({ html_url: z.string(), body: z.string().nullish(), user: UserSchema, path: z.string().optional() });
const ReviewSchema = z.object({ html_url: z.string(), body: z.string().nullish(), state: z.string(), user: UserSchema });
const CommonSchema = z.object({
  action: z.string().optional(),
  repository: z.object({ full_name: z.string(), html_url: z.string() }),
  sender: UserSchema,
  label: z.object({ name: z.string() }).optional(),
});
const PAYLOADS = {
  pull_request: CommonSchema.extend({ pull_request: PullRequestSchema }),
  pull_request_review: CommonSchema.extend({ pull_request: PullRequestSchema, review: ReviewSchema }),
  pull_request_review_comment: CommonSchema.extend({ pull_request: PullRequestSchema, comment: CommentSchema }),
  issues: CommonSchema.extend({ issue: IssueSchema }),
  issue_comment: CommonSchema.extend({ issue: IssueSchema, comment: CommentSchema }),
  push: CommonSchema.extend({
    ref: z.string(), after: z.string(), compare: z.string().optional(), deleted: z.boolean().optional(),
    head_commit: z.object({ message: z.string() }).nullish(),
    commits: z.array(z.object({ added: z.array(z.string()).optional(), modified: z.array(z.string()).optional(), removed: z.array(z.string()).optional() })).optional(),
  }),
  check_suite: CommonSchema.extend({
    check_suite: z.object({
      head_branch: z.string().nullable(), head_sha: z.string(), conclusion: z.string().nullable(),
      pull_requests: z.array(z.object({ number: z.number().int().positive(), head: z.object({ ref: z.string() }) })).optional(),
    }),
  }),
} satisfies Record<AutomationGitHubEvent, z.ZodType>;

/** Pull request and issue actions where the person acting, not the author, decides whether the event runs. */
const SENDER_ACTIONS: Readonly<Record<string, true>> = { labeled: true, unlabeled: true, closed: true, reopened: true };

function isAutomationEvent(event: string): event is AutomationGitHubEvent {
  return AUTOMATION_GITHUB_EVENTS.some(name => name === event);
}

function text(value: string | null | undefined): string {
  if (!value) return '';
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function mentions(body: string, slug: string | null): boolean {
  if (slug === null) return false;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9-])@${escaped}(?![A-Za-z0-9-])`, 'iu').test(body);
}

function pullRequestSubject(pull: z.infer<typeof PullRequestSchema>): AutomationSubject {
  return { kind: 'pullRequest', number: pull.number, branch: pull.head.ref, title: pull.title, url: pull.html_url };
}

function pullRequestFields(pull: z.infer<typeof PullRequestSchema>): Record<string, string> {
  return {
    'pull_request.html_url': pull.html_url, 'pull_request.title': pull.title, 'pull_request.number': String(pull.number),
    'pull_request.user.login': pull.user?.login ?? '', 'pull_request.base.ref': pull.base.ref, 'pull_request.head.ref': pull.head.ref,
  };
}

/** A delivery as automations read it, or null when automations do not start on its event or it does not parse. `slug`
 * is the App's: its bot is `@<slug>` in text and `<slug>[bot]` as a sender. */
export function automationEvent(input: { event: string; deliveryId: string; payload: unknown; slug: string | null; receivedAt: number }): AutomationEvent | null {
  const { event, slug } = input;
  if (!isAutomationEvent(event)) return null;
  const base = CommonSchema.safeParse(input.payload);
  if (!base.success) return null;
  const common = base.data;
  const action = common.action ?? null;
  const sender = common.sender?.login ?? null;
  const shared = {
    deliveryId: input.deliveryId, receivedAt: input.receivedAt, event, action, repository: common.repository.full_name,
    fromApp: slug !== null && sender !== null && sender.toLowerCase() === `${slug.toLowerCase()}[bot]`,
    baseBranch: null, headBranch: null, branch: null, draft: null, labels: null, label: common.label?.name ?? null, changedFiles: null,
    conclusion: null, reviewState: null, mentionsBot: false, merged: null, closes: [],
  };
  const fieldsOf = (subject: AutomationSubject | undefined, specific: Record<string, string>): Record<string, string> => ({
    action: action ?? '', 'sender.login': sender ?? '', 'repository.full_name': common.repository.full_name,
    'subject.title': subject ? subject.title || automationSubjectName(subject) : '', 'subject.url': subject?.url ?? '',
    ...(common.label ? { 'label.name': common.label.name } : {}),
    ...specific,
  });
  switch (event) {
    case 'pull_request': {
      const parsed = PAYLOADS.pull_request.safeParse(input.payload);
      if (!parsed.success) return null;
      const pull = parsed.data.pull_request;
      const author = pull.user?.login ?? null;
      const subject = pullRequestSubject(pull);
      const body = text(pull.body);
      return {
        ...shared, actor: action !== null && SENDER_ACTIONS[action] ? sender : author, author, subjects: [subject],
        baseBranch: pull.base.ref, headBranch: pull.head.ref, draft: pull.draft ?? false, labels: (pull.labels ?? []).map(label => label.name),
        merged: pull.merged ?? false, closes: [...new Set([...body.matchAll(CLOSES)].map(match => Number(match[1])).filter(number => number > 0))],
        fields: fieldsOf(subject, { ...pullRequestFields(pull), 'pull_request.body': body }),
      };
    }
    case 'pull_request_review': {
      const parsed = PAYLOADS.pull_request_review.safeParse(input.payload);
      if (!parsed.success) return null;
      const { pull_request: pull, review } = parsed.data;
      const reviewer = review.user?.login ?? null;
      const subject = pullRequestSubject(pull);
      const body = text(review.body);
      return {
        ...shared, actor: reviewer, author: reviewer, subjects: [subject], baseBranch: pull.base.ref, headBranch: pull.head.ref,
        reviewState: review.state.toLowerCase(), mentionsBot: mentions(body, slug),
        fields: fieldsOf(subject, { ...pullRequestFields(pull), 'review.html_url': review.html_url, 'review.user.login': reviewer ?? '', 'review.state': review.state.toLowerCase(), 'review.body': body }),
      };
    }
    case 'pull_request_review_comment': {
      const parsed = PAYLOADS.pull_request_review_comment.safeParse(input.payload);
      if (!parsed.success) return null;
      const { pull_request: pull, comment } = parsed.data;
      const commenter = comment.user?.login ?? null;
      const subject = pullRequestSubject(pull);
      const body = text(comment.body);
      return {
        ...shared, actor: commenter, author: commenter, subjects: [subject], baseBranch: pull.base.ref, headBranch: pull.head.ref, mentionsBot: mentions(body, slug),
        fields: fieldsOf(subject, { ...pullRequestFields(pull), 'comment.html_url': comment.html_url, 'comment.user.login': commenter ?? '', 'comment.body': body, 'comment.path': comment.path ?? '' }),
      };
    }
    case 'issues': {
      const parsed = PAYLOADS.issues.safeParse(input.payload);
      if (!parsed.success) return null;
      const { issue } = parsed.data;
      const author = issue.user?.login ?? null;
      const subject: AutomationSubject = { kind: 'issue', number: issue.number, branch: null, title: issue.title, url: issue.html_url };
      return {
        ...shared, actor: action !== null && SENDER_ACTIONS[action] ? sender : author, author, subjects: [subject], labels: (issue.labels ?? []).map(label => label.name),
        fields: fieldsOf(subject, { 'issue.html_url': issue.html_url, 'issue.title': issue.title, 'issue.number': String(issue.number), 'issue.user.login': author ?? '', 'issue.body': text(issue.body) }),
      };
    }
    case 'issue_comment': {
      const parsed = PAYLOADS.issue_comment.safeParse(input.payload);
      if (!parsed.success) return null;
      const { issue, comment } = parsed.data;
      const commenter = comment.user?.login ?? null;
      const subject: AutomationSubject = { kind: issue.pull_request ? 'pullRequest' : 'issue', number: issue.number, branch: null, title: issue.title, url: issue.html_url };
      const body = text(comment.body);
      return {
        ...shared, actor: commenter, author: commenter, subjects: [subject], labels: (issue.labels ?? []).map(label => label.name), mentionsBot: mentions(body, slug),
        fields: fieldsOf(subject, { 'comment.html_url': comment.html_url, 'comment.user.login': commenter ?? '', 'comment.body': body, 'issue.html_url': issue.html_url, 'issue.title': issue.title, 'issue.number': String(issue.number) }),
      };
    }
    case 'push': {
      const parsed = PAYLOADS.push.safeParse(input.payload);
      if (!parsed.success) return null;
      const push = parsed.data;
      const branch = push.ref.startsWith('refs/heads/') ? push.ref.slice('refs/heads/'.length) : null;
      const subject: AutomationSubject | undefined = branch === null ? undefined : { kind: 'branch', number: null, branch, title: branch, url: `${common.repository.html_url}/tree/${branch}` };
      const changed = push.commits ? [...new Set(push.commits.flatMap(commit => [...commit.added ?? [], ...commit.modified ?? [], ...commit.removed ?? []]))] : null;
      return {
        ...shared, actor: sender, author: sender, subjects: subject ? [subject] : [], branch, changedFiles: changed,
        fields: fieldsOf(subject, { ref: push.ref, after: push.after, compare: push.compare ?? '', 'head_commit.message': text(push.head_commit?.message) }),
      };
    }
    case 'check_suite': {
      const parsed = PAYLOADS.check_suite.safeParse(input.payload);
      if (!parsed.success) return null;
      const suite = parsed.data.check_suite;
      const pulls: AutomationSubject[] = (suite.pull_requests ?? []).map(pull => ({ kind: 'pullRequest', number: pull.number, branch: pull.head.ref, title: '', url: `${common.repository.html_url}/pull/${pull.number}` }));
      const branch: AutomationSubject[] = suite.head_branch === null ? [] : [{ kind: 'branch', number: null, branch: suite.head_branch, title: suite.head_branch, url: `${common.repository.html_url}/tree/${suite.head_branch}` }];
      const subjects = [...pulls, ...branch];
      return {
        ...shared, actor: null, author: null, subjects, branch: suite.head_branch, conclusion: suite.conclusion,
        fields: fieldsOf(subjects[0], { 'check_suite.head_branch': suite.head_branch ?? '', 'check_suite.head_sha': suite.head_sha, 'check_suite.conclusion': suite.conclusion ?? '' }),
      };
    }
  }
}

/** The GitHub event and action, as runs and tests name it: `pull_request.opened`, `push`. */
export function automationEventName(event: Pick<AutomationEvent, 'event' | 'action'>): string {
  return event.action === null ? event.event : `${event.event}.${event.action}`;
}

/** Whether a trigger starts on the event. A label trigger starts when a `gitspace:` mode label is added. */
export function triggerMatches(trigger: AutomationTrigger, event: AutomationEvent): boolean {
  if (trigger.kind === 'label') return (event.event === 'issues' || event.event === 'pull_request') && event.action === 'labeled' && event.label !== null && AUTOMATION_START_LABELS[event.label] !== undefined;
  if (trigger.kind !== 'github') return false;
  return trigger.events.some(entry => entry.event === event.event && (entry.actions.length === 0 || (event.action !== null && entry.actions.includes(event.action))));
}

/** One line for an event in runs, links and tests: "Review comment from @dana on PR #1140 · Bounded history". */
export function describeAutomationEvent(event: AutomationEvent): string {
  const subject = event.subjects[0];
  const named = subject ? `${automationSubjectName(subject)}${subject.title && subject.kind !== 'branch' ? ` · ${subject.title}` : ''}` : event.repository;
  const by = (login: string | null) => login === null ? '' : ` by @${login}`;
  switch (event.event) {
    case 'pull_request':
    case 'issues': {
      const action = event.action === 'labeled' && event.label !== null ? `labeled ${event.label}` : event.action === 'closed' && event.merged ? 'merged' : event.action ?? 'changed';
      return `${named} ${action}${by(event.actor)}`;
    }
    case 'pull_request_review': return `Review (${(event.reviewState ?? '').replaceAll('_', ' ')}) from @${event.author ?? 'someone'} on ${named}`;
    case 'pull_request_review_comment': return `Review comment from @${event.author ?? 'someone'} on ${named}`;
    case 'issue_comment': return `Comment from @${event.author ?? 'someone'} on ${named}`;
    case 'push': return `Push to ${event.branch ?? event.fields.ref ?? 'a ref'}${by(event.author)}`;
    case 'check_suite': return `Checks ${event.conclusion ?? event.action ?? 'changed'} on ${event.branch ?? named}`;
  }
}

/** A glob for branches, paths and logins: `*` within one path segment, `**` across segments. */
export function globMatches(pattern: string, value: string, caseless: boolean): boolean {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index] ?? '';
    if (character === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index++;
      if (pattern[index + 1] === '/') { source += '/?'; index++; }
    } else if (character === '*') source += '[^/]*';
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, caseless ? 'iu' : 'u').test(value);
}
