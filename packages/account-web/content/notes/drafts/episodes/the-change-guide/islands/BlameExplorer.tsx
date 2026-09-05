import { useState } from "react";
import { Layers, MousePointerClick } from "lucide-react";
import { cn } from "../../../lib/utils";

/**
 * BlameExplorer — the one big demo of Nº 05.
 * A code panel where every line maps to the CONCEPTUAL CHANGE that owns it
 * (introduced / moved / refined), each backed by a phase-journal intent quote.
 * The x-ray toggle tints the whole file by concept.
 * Adapted from docs/agent-blame.html, reframed around concepts + the journal.
 */

type ConceptId = "bucket" | "contract" | "plans";
type Kind = "Introduced" | "Moved" | "Refined";

type Entry = {
  kind: Kind;
  goal: string;
  phase: string;
  when: string;
  ref: string;
  intent: string; // declared at phase-start, BEFORE the edit
};

type Concept = {
  id: ConceptId;
  name: string;
  dot: string;
  text: string;
  tint: string;
  tintActive: string;
  edge: string;
  entries: Entry[];
};

const CONCEPTS: Record<ConceptId, Concept> = {
  bucket: {
    id: "bucket",
    name: "Token-bucket limiter",
    dot: "bg-sky-400",
    text: "text-sky-300",
    tint: "bg-sky-400/[0.06]",
    tintActive: "bg-sky-400/15",
    edge: "border-l-sky-400",
    entries: [
      {
        kind: "Introduced",
        goal: "Rate-limit the public API",
        phase: "implement",
        when: "Jun 18 · 14:32",
        ref: "ph_0412 · phase-start",
        intent:
          "Add a token-bucket limiter in front of the public routes. Expect to touch server/api.ts and nothing else.",
      },
      {
        kind: "Moved",
        goal: "Rate-limit the public API",
        phase: "extract",
        when: "Jun 18 · 16:05",
        ref: "ph_0415 · phase-start",
        intent:
          "Pull the limiter out of api.ts into shared middleware. The partner routes need the same guard and I will not duplicate it.",
      },
    ],
  },
  contract: {
    id: "contract",
    name: "The 429 contract",
    dot: "bg-purple-400",
    text: "text-purple-300",
    tint: "bg-purple-400/[0.06]",
    tintActive: "bg-purple-400/15",
    edge: "border-l-purple-400",
    entries: [
      {
        kind: "Introduced",
        goal: "Rate-limit the public API",
        phase: "implement",
        when: "Jun 18 · 14:57",
        ref: "ph_0412 · phase-start",
        intent: "Reject over-limit requests hard. A dropped request beats a melted database.",
      },
      {
        kind: "Refined",
        goal: "Rate-limit the public API",
        phase: "review-fixes",
        when: "Jun 19 · 09:41",
        ref: "ph_0421 · phase-start",
        intent:
          "The reviewer is right: a 429 without Retry-After teaches clients to hammer us. Add the header and a typed error.",
      },
    ],
  },
  plans: {
    id: "plans",
    name: "Per-plan quotas",
    dot: "bg-orange-400",
    text: "text-orange-300",
    tint: "bg-orange-400/[0.06]",
    tintActive: "bg-orange-400/15",
    edge: "border-l-orange-400",
    entries: [
      {
        kind: "Introduced",
        goal: "Per-plan quotas",
        phase: "implement",
        when: "Jun 24 · 11:18",
        ref: "ph_0447 · phase-start",
        intent:
          "Wire limits from plan config. Free stays at 60 rpm, pro gets 600. No hardcoded numbers left behind.",
      },
    ],
  },
};

const KIND_TAG: Record<Kind, string> = {
  Introduced: "bg-blue-400/10 text-blue-300",
  Moved: "bg-orange-400/10 text-orange-300",
  Refined: "bg-purple-400/10 text-purple-300",
};

/* ── the file ───────────────────────────────────────────────────────────── */

type Seg = { t: string; c?: string };
type CodeLine = { segs: Seg[]; concept: ConceptId | null; star?: boolean };

const p = (t: string): Seg => ({ t });
const kw = (t: string): Seg => ({ t, c: "text-zinc-500" });
const st = (t: string): Seg => ({ t, c: "text-green-400/80" });
const fn = (t: string): Seg => ({ t, c: "text-zinc-100" });

const LINES: CodeLine[] = [
  { segs: [kw("import"), p(" { RateLimitError } "), kw("from"), st(' "./errors"'), p(";")], concept: null },
  { segs: [kw("import"), p(" { planLimits } "), kw("from"), st(' "../config/plans"'), p(";")], concept: "plans" },
  { segs: [], concept: null },
  { segs: [kw("const"), p(" WINDOW_MS = 60_000;")], concept: "bucket" },
  { segs: [kw("const"), p(" buckets = "), kw("new"), p(" Map<string, Bucket>();")], concept: "bucket" },
  { segs: [], concept: null },
  { segs: [kw("export function"), p(" "), fn("rateLimit"), p("(req: Req, res: Res, next: () => void) {")], concept: "bucket" },
  { segs: [p("  "), kw("const"), p(" key = req.auth?.orgId ?? req.ip;")], concept: "bucket" },
  { segs: [p("  "), kw("const"), p(" limit = planLimits[req.auth?.plan ?? "), st('"free"'), p("];")], concept: "plans" },
  { segs: [p("  "), kw("const"), p(" bucket = buckets.get(key) ?? "), fn("newBucket"), p("(limit);")], concept: "bucket" },
  { segs: [], concept: null },
  { segs: [p("  "), kw("if"), p(" (!bucket.take()) {")], concept: "bucket" },
  { segs: [p("    res.setHeader("), st('"Retry-After"'), p(", String(bucket.resetIn()));")], concept: "contract" },
  { segs: [p("    "), kw("throw new"), p(" "), fn("RateLimitError"), p("(key, bucket.resetIn());")], concept: "contract", star: true },
  { segs: [p("  }")], concept: "bucket" },
  { segs: [], concept: null },
  { segs: [p("  buckets.set(key, bucket);")], concept: "bucket" },
  { segs: [p("  next();")], concept: "bucket" },
  { segs: [p("}")], concept: "bucket" },
  { segs: [], concept: null },
  { segs: [kw("function"), p(" "), fn("newBucket"), p("(limit: number): Bucket {")], concept: "bucket" },
  { segs: [p("  "), kw("return"), p(" { tokens: limit, refilledAt: Date.now(), take, resetIn };")], concept: "bucket" },
  { segs: [p("}")], concept: "bucket" },
];

/* ── component ──────────────────────────────────────────────────────────── */

type Active = { type: "concept"; id: ConceptId } | { type: "empty" } | null;

export function BlameExplorer() {
  const [pinned, setPinned] = useState<Active>(null);
  const [hovered, setHovered] = useState<Active>(null);
  const [xray, setXray] = useState(false);

  const active = pinned ?? hovered;
  const activeConcept = active?.type === "concept" ? CONCEPTS[active.id] : null;

  function clickLine(line: CodeLine) {
    if (!line.concept) {
      setPinned(null);
      return;
    }
    setPinned((prev) =>
      prev?.type === "concept" && prev.id === line.concept ? null : { type: "concept", id: line.concept! }
    );
  }

  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">
        demo · gssh blame shared/api/rate-limit.ts
      </div>

      <div className="border border-[#1a1a1a] bg-[#050505] overflow-hidden">
        {/* toolbar */}
        <div className="px-4 py-2.5 border-b border-[#1a1a1a] flex items-center gap-3">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 bg-[#1f1f1f]" />
            <span className="h-2.5 w-2.5 bg-[#1f1f1f]" />
            <span className="h-2.5 w-2.5 bg-[#1f1f1f]" />
          </div>
          <span className="font-mono text-[12px] text-zinc-500 truncate">
            <span className="text-zinc-300">shared/api/rate-limit.ts</span> · main · 9f31c2d
          </span>
          <button
            onClick={() => setXray((v) => !v)}
            className={cn(
              "ml-auto flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono border transition-colors",
              xray
                ? "border-green-500/60 text-green-400 bg-green-500/10"
                : "border-[#2a2a2a] text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
            )}
          >
            <Layers className="w-3 h-3" /> x-ray {xray ? "on" : "off"}
          </button>
        </div>

        {/* task hint */}
        {!pinned && (
          <div className="px-4 py-2 border-b border-[#1a1a1a] bg-blue-500/5 text-[12px] text-zinc-300 flex items-center gap-2">
            <MousePointerClick className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>
              Click a line to see the change behind it. Then flip <span className="text-green-400">x-ray</span> and find
              line 14: two changes deep.
            </span>
          </div>
        )}

        <div className="grid md:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          {/* code panel */}
          <div className="py-3 overflow-x-auto" onMouseLeave={() => setHovered(null)}>
            {LINES.map((line, i) => {
              const concept = line.concept ? CONCEPTS[line.concept] : null;
              const isActive = concept != null && activeConcept?.id === concept.id;
              return (
                <div
                  key={i}
                  onMouseEnter={() => setHovered(concept ? { type: "concept", id: concept.id } : { type: "empty" })}
                  onClick={() => clickLine(line)}
                  className={cn(
                    "flex items-center min-w-max pr-4 font-mono text-[13px] leading-6 cursor-pointer border-l-2 border-transparent transition-colors",
                    xray && concept && [concept.tint, concept.edge],
                    isActive && concept && [concept.tintActive, concept.edge],
                    !concept && "cursor-default"
                  )}
                >
                  <span className="w-10 shrink-0 pr-3 text-right text-[11px] text-zinc-700 select-none">{i + 1}</span>
                  <span className="whitespace-pre text-zinc-300">
                    {line.segs.length === 0
                      ? " "
                      : line.segs.map((s, j) => (
                          <span key={j} className={s.c}>
                            {s.t}
                          </span>
                        ))}
                  </span>
                  {line.star && (
                    <span className="ml-4 px-1.5 text-[10px] font-mono text-purple-300/80 bg-purple-400/10 select-none">
                      ×2
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* provenance panel */}
          <div className="border-t md:border-t-0 md:border-l border-[#1a1a1a] p-4 min-h-[220px]">
            {!active && (
              <div className="h-full flex items-center justify-center text-center px-4">
                <p className="font-mono text-[12px] text-zinc-600">
                  Hover or click a line.
                  <br />
                  Not who typed it: which change put it there.
                </p>
              </div>
            )}

            {active?.type === "empty" && (
              <div className="h-full flex items-center justify-center text-center px-4">
                <p className="font-mono text-[12px] text-zinc-600">
                  No conceptual change recorded here.
                  <br />
                  Imports and whitespace carry no concept.
                </p>
              </div>
            )}

            {activeConcept && (
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn("h-2.5 w-2.5 shrink-0", activeConcept.dot)} />
                  <span className={cn("font-medium text-[15px]", activeConcept.text)}>{activeConcept.name}</span>
                </div>
                <div className="font-mono text-[11px] text-zinc-600 mb-3">
                  {activeConcept.entries.length} change{activeConcept.entries.length > 1 ? "s" : ""} · goal:{" "}
                  {activeConcept.entries[0].goal}
                </div>

                <div>
                  {activeConcept.entries.map((e, i) => (
                    <div key={i} className={cn("py-3", i > 0 && "border-t border-[#161616]")}>
                      <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <span className={cn("px-1.5 py-0.5 text-[10px] font-mono", KIND_TAG[e.kind])}>{e.kind}</span>
                        <span className="font-mono text-[11px] text-zinc-500">
                          phase: <span className="text-zinc-300">{e.phase}</span>
                        </span>
                        <span className="font-mono text-[11px] text-zinc-600">{e.when}</span>
                      </div>
                      <p className="text-[13px] leading-relaxed text-zinc-300 italic">“{e.intent}”</p>
                      <div className="mt-1.5 font-mono text-[10px] text-zinc-600">
                        journal: {e.ref} · declared before the edit
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* legend + footer */}
        <div className="px-4 py-3 border-t border-[#1a1a1a] flex flex-wrap items-center gap-x-5 gap-y-2">
          {Object.values(CONCEPTS).map((c) => (
            <button
              key={c.id}
              onClick={() =>
                setPinned((prev) => (prev?.type === "concept" && prev.id === c.id ? null : { type: "concept", id: c.id }))
              }
              className={cn(
                "flex items-center gap-2 font-mono text-[11px] transition-colors",
                activeConcept?.id === c.id ? c.text : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              <span className={cn("h-2 w-2", c.dot)} />
              {c.name}
              <span className="text-zinc-700">{c.entries.map((e) => e.kind.toLowerCase()).join(" → ")}</span>
            </button>
          ))}
          <span className="ml-auto font-mono text-[11px] text-zinc-600">3 concepts · 2 goals · 5 journal entries</span>
        </div>
      </div>
    </div>
  );
}
