type EventLevel = "info" | "warn" | "error";

type SampleEvent = {
  event: string;
  eventId: string;
  level: EventLevel;
  timestamp: string;
  message: string;
  requestId: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
};

type TaskDefinition = {
  name: string;
  startMessage: string;
  finishMessage: string;
  errorMessage: string;
};

type ScheduledEvent = {
  offsetMs: number;
  event: string;
  message: string;
  level?: EventLevel;
  spanId: string;
  parentSpanId?: string;
  durationMs?: number;
};

const TASKS: TaskDefinition[] = [
  {
    name: "auth.check",
    startMessage: "Validating token",
    finishMessage: "Token validated",
    errorMessage: "Token validation failed",
  },
  {
    name: "db.query",
    startMessage: "Querying primary database",
    finishMessage: "Query complete",
    errorMessage: "Database timeout",
  },
  {
    name: "cache.lookup",
    startMessage: "Cache lookup",
    finishMessage: "Cache response",
    errorMessage: "Cache lookup failed",
  },
  {
    name: "worker.dispatch",
    startMessage: "Dispatching queue worker",
    finishMessage: "Worker acknowledged",
    errorMessage: "Worker dispatch stalled",
  },
  {
    name: "billing.capture",
    startMessage: "Capturing payment",
    finishMessage: "Payment captured",
    errorMessage: "Payment capture failed",
  },
  {
    name: "inventory.reserve",
    startMessage: "Reserving inventory",
    finishMessage: "Inventory reserved",
    errorMessage: "Inventory reservation failed",
  },
  {
    name: "feature.flag",
    startMessage: "Evaluating feature flags",
    finishMessage: "Flags applied",
    errorMessage: "Flag evaluation failed",
  },
  {
    name: "webhook.emit",
    startMessage: "Emitting webhook",
    finishMessage: "Webhook delivered",
    errorMessage: "Webhook delivery failed",
  },
];

const REQUEST_DURATION_RANGE_MS = [6000, 18000] as const;
const REQUEST_INTERVAL_RANGE_MS = [2000, 4000] as const;
const TASK_COUNT_RANGE = [4, 8] as const;
const FAILURE_RATE = 0.22;

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomBetween(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickOne<T>(items: T[]): T {
  return items[randomBetween(0, items.length - 1)];
}

function emitEvent(payload: SampleEvent): void {
  console.log(`@event ${JSON.stringify(payload)}`);
}

function buildEvent(params: {
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  event: string;
  message: string;
  level?: EventLevel;
  durationMs?: number;
}): SampleEvent {
  const now = new Date();
  return {
    event: params.event,
    eventId: randomId("evt"),
    level: params.level ?? "info",
    timestamp: now.toISOString(),
    message: params.message,
    requestId: params.requestId,
    traceId: params.traceId,
    spanId: params.spanId,
    parentSpanId: params.parentSpanId,
    durationMs: params.durationMs,
  };
}

function scheduleEvents(params: {
  requestId: string;
  traceId: string;
  events: ScheduledEvent[];
}): void {
  const { requestId, traceId, events } = params;
  const sorted = [...events].sort((a, b) => a.offsetMs - b.offsetMs);
  for (const event of sorted) {
    setTimeout(() => {
      emitEvent(buildEvent({
        requestId,
        traceId,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        event: event.event,
        message: event.message,
        level: event.level,
        durationMs: event.durationMs,
      }));
    }, event.offsetMs);
  }
}

function emitRequestSequence(): void {
  const requestId = randomId("req");
  const traceId = randomId("trace");
  const rootSpanId = randomId("span");
  const totalDuration = randomBetween(...REQUEST_DURATION_RANGE_MS);
  const willFail = Math.random() < FAILURE_RATE;
  const failureOffset = willFail
    ? randomBetween(Math.floor(totalDuration * 0.4), Math.floor(totalDuration * 0.85))
    : totalDuration;
  const finalOffset = willFail
    ? failureOffset + randomBetween(120, 480)
    : totalDuration + randomBetween(200, 600);

  const scheduled: ScheduledEvent[] = [
    {
      offsetMs: 0,
      event: "request.start",
      message: "Request started",
      spanId: rootSpanId,
    },
  ];

  const taskCount = randomBetween(...TASK_COUNT_RANGE);
  const selectedTasks = shuffle(TASKS).slice(0, taskCount);
  const taskWindowEnd = Math.max(600, failureOffset - 600);

  for (const task of selectedTasks) {
    const spanId = randomId("span");
    const startOffset = randomBetween(200, taskWindowEnd);
    if (willFail && startOffset > failureOffset - 200) {
      continue;
    }

    const duration = randomBetween(400, 3200);
    const finishOffset = startOffset + duration;

    scheduled.push({
      offsetMs: startOffset,
      event: `${task.name}.start`,
      message: task.startMessage,
      spanId,
      parentSpanId: rootSpanId,
    });

    if (!willFail || finishOffset < failureOffset - 200) {
      scheduled.push({
        offsetMs: finishOffset,
        event: `${task.name}.finish`,
        message: task.finishMessage,
        spanId,
        parentSpanId: rootSpanId,
        durationMs: duration,
      });
    }
  }

  if (willFail) {
    const failureTask = pickOne(selectedTasks);
    const failureSpanId = randomId("span");
    const failureDetailOffset = Math.max(200, failureOffset - randomBetween(150, 400));

    scheduled.push({
      offsetMs: failureDetailOffset,
      event: `${failureTask.name}.error`,
      message: failureTask.errorMessage,
      spanId: failureSpanId,
      parentSpanId: rootSpanId,
      level: "error",
    });
  }

  scheduled.push({
    offsetMs: finalOffset,
    event: willFail ? "request.failed" : "request.complete",
    message: willFail ? "Request failed" : "Request completed",
    spanId: rootSpanId,
    level: willFail ? "error" : "info",
    durationMs: finalOffset,
  });

  scheduleEvents({ requestId, traceId, events: scheduled });
}

emitEvent(buildEvent({
  requestId: "bootstrap",
  traceId: randomId("trace"),
  spanId: randomId("span"),
  event: "sample.start",
  message: "Sample event emitter started",
  level: "info",
}));

function scheduleNextSequence(): void {
  const delay = randomBetween(...REQUEST_INTERVAL_RANGE_MS);
  setTimeout(() => {
    emitRequestSequence();
    scheduleNextSequence();
  }, delay);
}

scheduleNextSequence();
emitRequestSequence();
