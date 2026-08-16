import { Link } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  Check,
  Code2,
  FileCheck2,
  GitCompareArrows,
  Gavel,
  Network,
  ShieldCheck,
  Terminal,
  Users,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Button } from "../app/components/ui/button";
import { Footer } from "../components/layout/Footer";
import { LandingNavbar } from "../components/layout/LandingNavbar";
import { TerminalWindow } from "../components/landing/TerminalWindow";

type TokenKind = "kw" | "fn" | "str" | "type" | "comment" | "prop" | "num" | "plain";

function Token({ kind, children }: { kind: TokenKind; children: string }) {
  const className = {
    kw: "text-purple-300",
    fn: "text-green-300",
    str: "text-amber-200",
    type: "text-blue-300",
    comment: "text-zinc-500",
    prop: "text-cyan-200",
    num: "text-orange-200",
    plain: "text-zinc-300",
  }[kind];

  return <span className={className}>{children}</span>;
}

function CodeLine({ children }: { children: ReactNode }) {
  return <div className="min-h-[1.5rem] whitespace-pre">{children}</div>;
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-4 inline-flex items-center gap-2 font-mono text-sm text-green-400">{children}</div>;
}

function SpecCodeBlock() {
  return (
    <TerminalWindow title="rubrics/web.goal-chain-ux.ts" className="bg-black/95">
      <pre className="font-mono text-[13px] leading-6 md:text-sm"><code>
        <CodeLine><Token kind="kw">const</Token><Token kind="plain"> clarity = </Token><Token kind="fn">dimension.score</Token><Token kind="plain">(</Token><Token kind="str">'interaction-clarity'</Token><Token kind="plain">, &#123;</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">label</Token><Token kind="plain">: </Token><Token kind="str">'Interaction clarity'</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">description</Token><Token kind="plain">: </Token><Token kind="str">'Can a user understand the next action?'</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">scale</Token><Token kind="plain">: &#123; </Token><Token kind="prop">type</Token><Token kind="plain">: </Token><Token kind="str">'ordinal'</Token><Token kind="plain">, </Token><Token kind="prop">min</Token><Token kind="plain">: </Token><Token kind="num">1</Token><Token kind="plain">, </Token><Token kind="prop">max</Token><Token kind="plain">: </Token><Token kind="num">5</Token><Token kind="plain">, </Token><Token kind="prop">higherIsBetter</Token><Token kind="plain">: </Token><Token kind="kw">true</Token><Token kind="plain"> &#125;,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">anchors</Token><Token kind="plain">: &#123; </Token><Token kind="num">1</Token><Token kind="plain">: </Token><Token kind="str">'confusing'</Token><Token kind="plain">, </Token><Token kind="num">3</Token><Token kind="plain">: </Token><Token kind="str">'usable with hesitation'</Token><Token kind="plain">, </Token><Token kind="num">5</Token><Token kind="plain">: </Token><Token kind="str">'immediately clear'</Token><Token kind="plain"> &#125;,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">passing</Token><Token kind="plain">: &#123; </Token><Token kind="prop">minimum</Token><Token kind="plain">: </Token><Token kind="num">4</Token><Token kind="plain"> &#125;,</Token></CodeLine>
        <CodeLine><Token kind="plain">&#125;);</Token></CodeLine>
        <CodeLine>{""}</CodeLine>
        <CodeLine><Token kind="kw">const</Token><Token kind="plain"> screenshot = </Token><Token kind="fn">proof.file</Token><Token kind="plain">(</Token><Token kind="str">'hover-screenshot'</Token><Token kind="plain">, &#123;</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">accepts</Token><Token kind="plain">: [</Token><Token kind="str">'image/png'</Token><Token kind="plain">],</Token></CodeLine>
        <CodeLine><Token kind="plain">&#125;);</Token></CodeLine>
        <CodeLine>{""}</CodeLine>
        <CodeLine><Token kind="kw">const</Token><Token kind="plain"> tests = </Token><Token kind="fn">proof.command</Token><Token kind="plain">(</Token><Token kind="str">'focused-tests'</Token><Token kind="plain">, &#123;</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">command</Token><Token kind="plain">: </Token><Token kind="str">'bun test src/components/...'</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">output</Token><Token kind="plain">: </Token><Token kind="fn">artifact.kind</Token><Token kind="plain">(</Token><Token kind="str">'proof.test-output'</Token><Token kind="plain">),</Token></CodeLine>
        <CodeLine><Token kind="plain">&#125;);</Token></CodeLine>
        <CodeLine>{""}</CodeLine>
        <CodeLine><Token kind="kw">const</Token><Token kind="plain"> visualReview = </Token><Token kind="fn">judge.llm</Token><Token kind="plain">(</Token><Token kind="str">'visual-review'</Token><Token kind="plain">, &#123;</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">inputs</Token><Token kind="plain">: &#123; screenshot, tests &#125;,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">dimensions</Token><Token kind="plain">: &#123; clarity &#125;,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">output</Token><Token kind="plain">: </Token><Token kind="fn">judgment.visualReview</Token><Token kind="plain">(&#123; </Token><Token kind="prop">scores</Token><Token kind="plain">: [clarity] &#125;),</Token></CodeLine>
        <CodeLine><Token kind="plain">&#125;);</Token></CodeLine>
        <CodeLine>{""}</CodeLine>
        <CodeLine><Token kind="kw">export default</Token><Token kind="plain"> </Token><Token kind="fn">rubric</Token><Token kind="plain">(</Token><Token kind="str">'web.goal-chain-ux'</Token><Token kind="plain">, &#123;</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">proof</Token><Token kind="plain">: [screenshot, tests],</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">judges</Token><Token kind="plain">: [visualReview],</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">final</Token><Token kind="plain">: visualReview.output,</Token></CodeLine>
        <CodeLine><Token kind="plain">&#125;);</Token></CodeLine>
      </code></pre>
    </TerminalWindow>
  );
}

function EnvelopeBlock() {
  return (
    <TerminalWindow title="artifact envelope" className="bg-black/95">
      <pre className="font-mono text-[13px] leading-6 md:text-sm"><code>
        <CodeLine><Token kind="plain">&#123;</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"id"</Token><Token kind="plain">: </Token><Token kind="str">"art_01h..."</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"kind"</Token><Token kind="plain">: </Token><Token kind="str">"judgment.visual-review"</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"status"</Token><Token kind="plain">: </Token><Token kind="str">"valid"</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"runId"</Token><Token kind="plain">: </Token><Token kind="str">"run_92b..."</Token><Token kind="plain">, </Token><Token kind="prop">"candidateId"</Token><Token kind="plain">: </Token><Token kind="str">"candidate-b"</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"createdAt"</Token><Token kind="plain">: </Token><Token kind="str">"2026-05-09T18:42:10Z"</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"rubricManifestDigest"</Token><Token kind="plain">: </Token><Token kind="str">"sha256:8f3..."</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"schema"</Token><Token kind="plain">: &#123; </Token><Token kind="prop">"id"</Token><Token kind="plain">: </Token><Token kind="str">"visual-review@1"</Token><Token kind="plain">, </Token><Token kind="prop">"digest"</Token><Token kind="plain">: </Token><Token kind="str">"sha256:91c..."</Token><Token kind="plain"> &#125;,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"producer"</Token><Token kind="plain">: &#123; </Token><Token kind="prop">"type"</Token><Token kind="plain">: </Token><Token kind="str">"llm"</Token><Token kind="plain">, </Token><Token kind="prop">"id"</Token><Token kind="plain">: </Token><Token kind="str">"visual-review"</Token><Token kind="plain"> &#125;,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"inputArtifactIds"</Token><Token kind="plain">: [</Token><Token kind="str">"art_screenshot_01"</Token><Token kind="plain">, </Token><Token kind="str">"art_tests_01"</Token><Token kind="plain">],</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"data"</Token><Token kind="plain">: &#123; </Token><Token kind="prop">"verdict"</Token><Token kind="plain">: </Token><Token kind="str">"pass"</Token><Token kind="plain">, </Token><Token kind="prop">"scores"</Token><Token kind="plain">: [&#123; </Token><Token kind="prop">"dimension"</Token><Token kind="plain">: </Token><Token kind="str">"interaction-clarity"</Token><Token kind="plain">, </Token><Token kind="prop">"value"</Token><Token kind="plain">: </Token><Token kind="num">4.7</Token><Token kind="plain"> &#125;] &#125;</Token></CodeLine>
        <CodeLine><Token kind="plain">&#125;</Token></CodeLine>
      </code></pre>
    </TerminalWindow>
  );
}

function ManifestBlock() {
  return (
    <TerminalWindow title="canonical manifest snapshot" className="bg-black/95">
      <pre className="font-mono text-[13px] leading-6 md:text-sm"><code>
        <CodeLine><Token kind="plain">&#123;</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"manifestVersion"</Token><Token kind="plain">: </Token><Token kind="str">"1.0"</Token><Token kind="plain">, </Token><Token kind="prop">"id"</Token><Token kind="plain">: </Token><Token kind="str">"web.goal-chain-ux"</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"digest"</Token><Token kind="plain">: </Token><Token kind="str">"sha256:8f3..."</Token><Token kind="plain">, </Token><Token kind="prop">"compat"</Token><Token kind="plain">: </Token><Token kind="str">"&gt;=1.0 &lt;2.0"</Token><Token kind="plain">,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"dimensions"</Token><Token kind="plain">: [&#123; </Token><Token kind="prop">"id"</Token><Token kind="plain">: </Token><Token kind="str">"interaction-clarity"</Token><Token kind="plain">, </Token><Token kind="prop">"scale"</Token><Token kind="plain">: </Token><Token kind="str">"ordinal-1-5"</Token><Token kind="plain"> &#125;],</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"schemas"</Token><Token kind="plain">: [&#123; </Token><Token kind="prop">"id"</Token><Token kind="plain">: </Token><Token kind="str">"proof.screenshot@1"</Token><Token kind="plain">, </Token><Token kind="prop">"digest"</Token><Token kind="plain">: </Token><Token kind="str">"sha256:4ad..."</Token><Token kind="plain"> &#125;],</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"nodes"</Token><Token kind="plain">: [&#123; </Token><Token kind="prop">"id"</Token><Token kind="plain">: </Token><Token kind="str">"screenshot"</Token><Token kind="plain">, </Token><Token kind="prop">"kind"</Token><Token kind="plain">: </Token><Token kind="str">"proof.file"</Token><Token kind="plain"> &#125;, &#123; </Token><Token kind="prop">"id"</Token><Token kind="plain">: </Token><Token kind="str">"visualReview"</Token><Token kind="plain">, </Token><Token kind="prop">"kind"</Token><Token kind="plain">: </Token><Token kind="str">"judge.llm"</Token><Token kind="plain"> &#125;],</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"edges"</Token><Token kind="plain">: [[</Token><Token kind="str">"screenshot.output"</Token><Token kind="plain">, </Token><Token kind="str">"visualReview.inputs.screenshot"</Token><Token kind="plain">]],</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"requires"</Token><Token kind="plain">: &#123; </Token><Token kind="prop">"capabilities"</Token><Token kind="plain">: [</Token><Token kind="str">"judge.llm.v1"</Token><Token kind="plain">, </Token><Token kind="str">"artifact.blob.v1"</Token><Token kind="plain">] &#125;,</Token></CodeLine>
        <CodeLine><Token kind="plain">  </Token><Token kind="prop">"final"</Token><Token kind="plain">: [</Token><Token kind="str">"visualReview.output"</Token><Token kind="plain">]</Token></CodeLine>
        <CodeLine><Token kind="plain">&#125;</Token></CodeLine>
      </code></pre>
    </TerminalWindow>
  );
}

const judgeRows = [
  ["Command", "Deterministic checks", "Playwright, test suites, benchmarks, scanners", "proof.test-output → judgment.test-pass", "Run focused tests and emit a pass/fail judgment with stdout/stderr attached."],
  ["LLM", "Semantic review", "screenshots, docs, diffs, prior judgments", "proof + dimensions → judgment.visual-review", "Score interaction clarity from screenshots and cite each evidence artifact used."],
  ["Human", "Taste and risk acceptance", "demos, notes, candidate comparisons", "evidence bundle → judgment.product-review", "Ask a product owner to approve the direction or request more proof."],
  ["Composite", "Policy and selection", "prior judgments from other lanes", "judgments → decision.release-readiness", "Block release if tests fail, rank survivors by clarity, escalate ties to a human."],
];

const whitepaperSections = [
  {
    id: "01",
    title: "Core model",
    summary: "Agent Rubric is a graph standard for evaluating candidate work, not a prompt format.",
    bullets: [
      "A candidate implementation produces proof artifacts: command output, screenshots, URLs, notes, traces, or files.",
      "Judge nodes consume artifacts and emit new typed artifacts: judgments, metrics, or final decisions.",
      "Judgments are durable artifacts, so later judges can rely on earlier conclusions without re-reading raw logs.",
    ],
    example: "Candidate B → proof.screenshot → judge.visual-review → judgment.visual-review",
    avoids: "Avoids ad hoc agent logs where evidence, interpretation, and final decision collapse into unstructured prose.",
  },
  {
    id: "02",
    title: "Dimensions",
    summary: "A dimension is a named quality axis a judge can score, not a loose string like behavior or clarity.",
    bullets: [
      "Each dimension carries an id, label, description, scale, anchors, and pass/fail guidance.",
      "LLM and human judges receive the dimension definitions as evaluation instructions.",
      "Composite judges can compare dimension scores across candidates because the score shape is typed.",
    ],
    example: "interaction-clarity: 1 means confusing; 5 means immediately clear from the UI alone.",
    avoids: "Avoids score names that look comparable but were judged against different hidden assumptions.",
  },
  {
    id: "03",
    title: "Artifacts",
    summary: "Proof, metrics, judgments, and decisions share one envelope with provenance and schema metadata.",
    bullets: [
      "The envelope records kind, candidate, producer, timestamp, input artifact ids, schema digest, and optional blob hash.",
      "The data payload is schema-specific: a screenshot, command result, scorecard, ranking, or release decision.",
      "Artifacts can be validated, redacted, stored, replayed, and passed between tools without losing their meaning.",
    ],
    example: "judgment.test-pass references proof.test-output as its input and stores verdict: pass | fail.",
    avoids: "Avoids brittle file names and screenshots with no record of who produced them or which rubric judged them.",
  },
  {
    id: "04",
    title: "Judges",
    summary: "Judges are typed artifact transformers with declared inputs, outputs, capabilities, and failure states.",
    bullets: [
      "Command judges run deterministic checks and emit normalized judgment artifacts, not just terminal text.",
      "LLM judges receive only declared artifacts and must return needs-more-proof when required inputs are missing.",
      "Human and composite judges produce artifacts too, which makes approvals and policy decisions auditable.",
    ],
    example: "judge.visual-review consumes proof.screenshot and judgment.test-pass, then emits judgment.visual-review.",
    avoids: "Avoids unbounded review prompts that silently use missing context or untracked evidence.",
  },
  {
    id: "05",
    title: "Harness",
    summary: "The harness is the runtime that resolves the graph and stores every produced artifact.",
    bullets: [
      "It validates existing artifacts, detects missing required inputs, schedules judges in dependency order, and caches reusable outputs.",
      "It isolates command execution, captures stdout/stderr as artifacts, and validates LLM/human outputs against schemas.",
      "For parallel work, it runs the same manifest against many candidates so judgments are comparable.",
    ],
    example: "produce(decision.release-readiness) recursively collects proof, runs test-pass, visual-review, then release policy.",
    avoids: "Avoids one-off scripts that cannot explain why candidate A beat candidate B.",
  },
  {
    id: "06",
    title: "Compatibility",
    summary: "The TypeScript SDK is authoring syntax; the canonical manifest is the standard.",
    bullets: [
      "Any SDK can compile to the manifest if it preserves graph nodes, edges, schemas, dimensions, judges, capabilities, and final outputs.",
      "Historical runs store manifest digests and schema digests, so old artifacts remain readable after SDK APIs change.",
      "A runtime can display unsupported historical artifacts even when it cannot re-run an obsolete judge capability.",
    ],
    example: "rubric.ts changes in v2, but a v1 run still points to manifest sha256:8f3 and schema sha256:91c.",
    avoids: "Avoids version drift where old judgments become meaningless because only executable SDK code defined their shape.",
  },
];

const mentalModel = [
  [FileCheck2, "Candidate", "One implementation branch, workspace, patch, or generated attempt."],
  [Terminal, "Proof", "Typed evidence produced by humans, tools, commands, browsers, or agents."],
  [Gavel, "Judge", "A command, LLM, human, or composite node that evaluates declared inputs."],
  [BrainCircuit, "Judgment", "A typed result artifact with scores, rationale, and evidence references."],
  [Network, "Decision", "A release gate, candidate ranking, promotion, or request for more proof."],
] as const;

const benefitStrip = [
  ["Who should care", "Harness, eval, or review teams comparing candidate work across runs or tools."],
  ["Compare N candidates", "Run one manifest across many agent outputs instead of rereading separate logs."],
  ["Preserve decisions", "Keep approvals, failures, and evidence links replayable after the run is over."],
  ["Smallest useful run", "Start with one candidate, two proof artifacts, one judge, and one final decision."],
] as const;

const glossaryTerms = [
  ["Proof", "Evidence produced by a candidate: a file, command result, screenshot, trace, URL, or note."],
  ["Typed", "Validated by an explicit schema and artifact kind, not only by TypeScript authoring types."],
  ["Dimension", "A typed quality axis with a scale, anchors, direction, and evaluation guidance."],
  ["Judge", "A graph node that consumes declared artifacts and emits one or more output artifacts."],
  ["Judgment", "A judge-produced artifact with verdict, scores, rationale, and evidence references."],
  ["Manifest", "The canonical JSON graph: dimensions, schemas, nodes, edges, capabilities, and final outputs."],
  ["Capability", "A versioned runtime feature such as judge.llm.v1 or artifact.blob.v1."],
  ["Canonical", "Serialized in a deterministic manifest shape so the same graph produces the same digest."],
] as const;

const conformanceItems = [
  ["Normative", "Manifest JSON, artifact envelope, schema digests, graph nodes/edges, capabilities, final outputs, judge output states."],
  ["Non-normative", "TypeScript SDK syntax, GitSpace page design, visual diagrams, and any one product runtime's UI."],
  ["Required runtime behavior", "Validate artifact schemas, respect declared inputs, record provenance, preserve manifest digests, and surface unsupported capabilities."],
] as const;

const authoringMapping = [
  ["clarity", "dimension id: interaction-clarity", "schema: ordinal score 1-5"],
  ["screenshot", "node id: screenshot", "kind: proof.file → proof.screenshot@1"],
  ["tests", "node id: tests", "kind: proof.command → proof.test-output@1"],
  ["visualReview", "node id: visualReview", "capability: judge.llm.v1"],
  ["visualReview.output", "final: judgment.visual-review", "edges: screenshot/tests → visualReview.inputs"],
] as const;

const statusStrip = [
  ["Audience", "agent harness authors, eval/runtime teams, engineering leads"],
  ["Draft", "open standard sketch, manifest v1 shape"],
  ["Normative artifact", "canonical manifest JSON + artifact envelope"],
  ["Conforming runtime", "reads manifests, validates artifacts, runs supported judges"],
] as const;

const pageContents = [
  ["Problem", "#why-not"],
  ["Draft spec", "#whitepaper"],
  ["Judge lanes", "#judge-lanes"],
  ["Failure states", "#failure-states"],
  ["SDK authoring", "#sdk"],
  ["Artifact envelope", "#artifact-envelope"],
  ["Compatibility", "#compatibility"],
  ["Adoption path", "#adoption-path"],
  ["Candidate search", "#candidate-search"],
] as const;

const alternativeRows = [
  ["CI logs", "Good for deterministic checks", "Weak for screenshots, human approval, and comparing agent candidates over time"],
  ["Eval prompts", "Good for quick qualitative scoring", "Weak without declared inputs, durable schemas, and replayable provenance"],
  ["JSON scorecards", "Good for local structure", "Weak without graph dependencies, capability versions, and artifact references"],
] as const;

const notForRows = [
  ["Single CI gate", "Use the existing test runner; no artifact graph needed."],
  ["Throwaway prototype", "Keep notes lightweight until decisions need to be replayed."],
  ["No retention need", "If evidence can disappear after review, envelopes may be overhead."],
  ["One local tool", "If nothing crosses harnesses, a local scorecard may be enough."],
] as const;

const failureStates = [
  ["needs-more-proof", "Required input artifact is missing or insufficient", "retry after collecting evidence"],
  ["failed", "Judge ran and evidence did not meet the dimension or gate", "terminal until candidate changes"],
  ["invalid-output", "Judge returned data that does not validate against its output schema", "retry or fix judge"],
  ["unsupported-capability", "Runtime cannot execute the required judge capability", "display-only unless adapter exists"],
  ["stale-schema", "Artifact data does not match the schema digest expected by this manifest", "migrate or mark unreadable"],
] as const;

const minimumContractRows = [
  ["manifest", "required", "manifestVersion, id, digest, dimensions, schemas, nodes, edges, requires.capabilities, final"],
  ["artifact envelope", "required", "id, kind, status, runId, createdAt, schema digest, producer, inputArtifactIds, data"],
  ["blob metadata", "optional", "media type, size, content hash, retention, redaction policy"],
  ["extension fields", "optional", "namespaced fields ignored by runtimes that do not understand them"],
] as const;

const canonicalRules = [
  "Canonical JSON uses UTF-8, sorted object keys, and significant array order.",
  "The digest field is excluded from its own hash.",
  "Schema digests use the same canonicalization rule as manifests.",
  "Unknown required capabilities are surfaced, not silently skipped.",
] as const;

const judgeAbiRows = [
  ["request", "declared artifact envelopes/blobs, dimension config, goal/candidate metadata"],
  ["ambient access", "none unless the manifest declares a capability such as command.exec or artifact.blob"],
  ["response", "valid artifact envelope or one defined failure state"],
  ["cache key", "judge id + manifest digest + input artifact ids + judge config digest"],
] as const;

const adoptionSteps = [
  ["1", "Wrap existing proof", "Keep your current CI command, screenshot, or review note, but store it as a typed artifact envelope."],
  ["2", "Emit one judgment", "Turn one existing gate into `judgment.test-pass` or `judgment.review` before adding more lanes."],
  ["3", "Add semantic review", "Introduce human or LLM judges only where logs alone no longer explain the decision."],
  ["4", "Compose decisions", "Add release or ranking policy after the artifact and judgment contract is already stable."],
] as const;

const adoptionCosts = [
  ["Schema owner", "Versions fields, deprecates old shapes, and decides what historical artifacts remain readable."],
  ["Storage owner", "Sets blob retention, redaction, and size limits; missing ownership risks leaking or losing evidence."],
  ["Judge owner", "Calibrates command/LLM/human judges and investigates drift, false passes, and ambiguous outputs."],
  ["Runtime owner", "Owns capability negotiation, migrations, and what happens when old runs become display-only."],
] as const;

const adoptionThreshold = [
  "more than one candidate generator or harness",
  "evidence must be retained after the run",
  "semantic review is repeated enough to justify codifying it",
  "multiple tools need to exchange judgments, not just raw logs",
] as const;


export default function AgentRubricPage() {
  useEffect(() => {
    document.title = "Agent Rubric - Open Standard for Typed Proof Graphs";
  }, []);

  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />
      <main>
        <section className="relative overflow-hidden px-4 pb-24 pt-28 md:pb-32 md:pt-36">
          <div className="absolute inset-0 opacity-30 [background:radial-gradient(ellipse_at_top,rgba(34,197,94,0.18),transparent_45%),radial-gradient(ellipse_at_bottom_right,rgba(59,130,246,0.08),transparent_35%)]" />
          <div className="container relative z-10 mx-auto">
            <div className="mx-auto max-w-4xl text-center">
              <Label><BookOpen className="h-4 w-4" /><span>AGENT RUBRIC / OPEN STANDARD DRAFT</span></Label>
              <h1 className="mb-6 bg-gradient-to-b from-white to-white/60 bg-clip-text text-4xl font-bold tracking-tight text-transparent md:text-6xl lg:text-7xl">
                Compare agent-generated work with the same evidence, judges, and decisions.
              </h1>
              <div className="mb-4 font-mono text-sm text-green-400">A canonical proof-and-judgment graph for agent work.</div>
              <p className="mx-auto max-w-2xl text-xl leading-relaxed text-muted-foreground md:text-2xl">
                Agent outputs are hard to compare when proof, scoring, and approvals live in screenshots, terminal logs, and chat. Agent Rubric makes evidence and judgment portable.
              </p>
              <div className="mx-auto mt-5 max-w-3xl rounded-lg border border-zinc-800 bg-black/60 p-4 text-left">
                <div className="font-mono text-xs uppercase tracking-wider text-green-400">Concrete example</div>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                  Example: run three agent-generated UI patches through the same screenshot proof, focused test proof, and visual-review judge, then promote the candidate whose typed judgments satisfy release policy.
                </p>
                <p className="mt-3 text-sm leading-6 text-zinc-500">
                  Instead of reading five separate agent logs, run one graph and get comparable proof, judgments, and final decisions.
                </p>
              </div>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-zinc-400">
                In plain English: Agent Rubric is a canonical manifest that tells a compatible harness what evidence to collect, which judges to run, and which typed artifacts decide or rank candidate work.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Button asChild size="lg" className="h-12 bg-white px-8 text-base text-black hover:bg-gray-200">
                  <a href="#whitepaper">Read the draft spec <ArrowRight className="ml-2 h-4 w-4" /></a>
                </Button>
                <Button asChild variant="outline" size="lg" className="h-12 border-white/10 px-8 text-base hover:bg-white/5">
                  <a href="#sdk">See SDK authoring</a>
                </Button>
              </div>
            </div>

            <div className="mx-auto mt-10 max-w-5xl rounded-lg border border-zinc-800 bg-black/70 p-5">
              <div className="mb-3 font-mono text-xs uppercase tracking-wider text-green-400">At a glance</div>
              <div className="grid gap-3 text-sm text-zinc-300 md:grid-cols-4">
                {benefitStrip.map(([title, description]) => (
                  <div key={title} className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                    <div className="font-mono text-zinc-100">{title}</div>
                    <p className="mt-2 leading-5 text-zinc-500">{description}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-sm leading-6 text-zinc-500">
                Smallest useful pilot: one proof artifact, one judgment artifact, one persisted manifest digest, and one replayed decision.
              </p>
            </div>

            <div className="mx-auto mt-16 grid max-w-5xl gap-3 md:grid-cols-5">
              {mentalModel.map(([Icon, title, description]) => (
                <div key={title} className="rounded-lg border border-zinc-800 bg-black/60 p-4 text-center shadow-xl">
                  <Icon className="mx-auto mb-3 h-5 w-5 text-green-500" />
                  <div className="font-mono text-sm text-zinc-200">{title}</div>
                  <p className="mt-2 text-xs leading-5 text-zinc-500">{description}</p>
                </div>
              ))}
            </div>

            <div className="mx-auto mt-12 max-w-5xl">
              <div className="pointer-events-none absolute -inset-1 rounded-[2rem] bg-gradient-to-b from-green-500/20 to-transparent opacity-40 blur-2xl" />
              <TerminalWindow title="agent-rubric graph" className="relative bg-black/90 backdrop-blur-xl">
                <div className="grid gap-4 font-mono text-sm lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:items-center">
                  <div className="rounded border border-zinc-800 bg-zinc-950/80 p-4">
                    <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">proof artifacts</div>
                    <div className="text-green-400">proof.screenshot</div>
                    <div className="text-green-400">proof.test-output</div>
                    <div className="text-green-400">metric.bundle-size</div>
                  </div>
                  <div className="flex justify-center text-zinc-600"><ArrowRight className="h-6 w-6" /></div>
                  <div className="rounded border border-zinc-800 bg-zinc-950/80 p-4">
                    <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">judge nodes</div>
                    <div className="text-blue-300">judge.command.test-pass</div>
                    <div className="text-blue-300">judge.llm.visual-review</div>
                    <div className="text-blue-300">judge.composite.release</div>
                  </div>
                  <div className="flex justify-center text-zinc-600"><ArrowRight className="h-6 w-6" /></div>
                  <div className="rounded border border-zinc-800 bg-zinc-950/80 p-4">
                    <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">typed outputs</div>
                    <div className="text-purple-300">judgment.test-pass</div>
                    <div className="text-purple-300">judgment.visual-review</div>
                    <div className="text-purple-300">decision.release-readiness</div>
                  </div>
                </div>
              </TerminalWindow>
            </div>
          </div>
        </section>

        <section id="why-not" className="border-y border-white/10 bg-zinc-950 py-20">
          <div className="container mx-auto px-4">
            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
              <div>
                <Label><ShieldCheck className="h-4 w-4" /><span>WHY A STANDARD?</span></Label>
                <h2 className="text-3xl font-bold md:text-5xl">Why not just use CI logs, eval prompts, or scorecards?</h2>
                <p className="mt-6 text-lg leading-8 text-zinc-400">
                  Those are good starting points. Agent Rubric becomes worth it when multiple agents or tools need to compare candidates, preserve evidence, replay decisions, and exchange judgments without sharing one runtime.
                </p>
                <p className="mt-4 text-sm leading-6 text-zinc-500">
                  Full adoption starts when retained evidence or cross-tool judgment exchange matters. Multiple candidates and repeated semantic review are accelerants, not substitutes.
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black font-mono text-sm">
                <div className="grid grid-cols-3 border-b border-zinc-800 px-4 py-3 text-xs uppercase tracking-wider text-zinc-600">
                  <div>alternative</div><div>works for</div><div>breaks down when</div>
                </div>
                {alternativeRows.map(([name, works, breaks]) => (
                  <div key={name} className="grid grid-cols-1 gap-2 border-b border-zinc-900 px-4 py-4 last:border-b-0 md:grid-cols-3">
                    <div className="text-green-400">{name}</div>
                    <div className="text-zinc-300">{works}</div>
                    <div className="text-zinc-500">{breaks}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-zinc-800 bg-black p-5">
                <div className="mb-4 font-mono text-sm text-green-400">DO NOT USE THIS WHEN</div>
                <div className="grid gap-3 text-sm md:grid-cols-2">
                  {[
                    ["Single CI gate", "Use the existing test runner; no artifact graph needed.", "Keep a normal CI job or test report."],
                    ["Throwaway prototype", "Keep notes lightweight until decisions need to be replayed.", "Use a short review note or temporary eval prompt."],
                    ["No retention need", "If evidence can disappear after review, envelopes may be overhead.", "Keep a local checklist or ephemeral review log."],
                    ["One local tool", "If nothing crosses harnesses, a local scorecard may be enough.", "Use a local JSON scorecard or tool-specific report."],
                  ].map(([name, copy, alt]) => (
                    <div key={name} className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                      <div className="font-mono text-zinc-200">{name}</div>
                      <p className="mt-2 leading-6 text-zinc-500">{copy}</p>
                      <p className="mt-2 text-xs leading-5 text-zinc-400">Recommended alternative: {alt}</p>
                    </div>
                  ))}
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-zinc-500">
                Pair this with the adoption threshold below: if your team cannot meet those conditions, keep the lighter-weight alternative.
              </p>
              <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-5">
                <div className="mb-4 font-mono text-sm text-green-400">ADOPT NOW / PILOT / DO NOT ADOPT</div>
                <div className="grid gap-3 text-sm md:grid-cols-3">
                  {[
                    ["Adopt now", "Cross-tool exchange or long-lived comparable judgments already matter.", "Run the standard end to end and make it the source of truth."],
                    ["Pilot", "You need replayable evidence but are still proving the workflow and owners.", "Wrap one existing proof source and one judgment before wider rollout."],
                    ["Do not adopt", "One local tool and disposable evidence still fit the problem.", "Stay on lighter-weight alternatives until retention or exchange becomes real."],
                  ].map(([title, copy, action]) => (
                    <div key={title} className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                      <div className="font-mono text-zinc-200">{title}</div>
                      <p className="mt-2 leading-6 text-zinc-500">{copy}</p>
                      <p className="mt-2 text-xs leading-5 text-zinc-400">Next step: {action}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        

        <section id="whitepaper" className="border-y border-white/10 bg-zinc-950 py-24">
          <div className="container mx-auto px-4">
            <div className="grid gap-12 lg:grid-cols-[280px_1fr]">
              <aside className="lg:sticky lg:top-24 lg:self-start">
                <div className="mb-4 font-mono text-sm text-green-400">DOCUMENT MAP</div>
                <nav className="space-y-3 text-sm text-zinc-400">
                  {pageContents.map(([title, href], index) => (
                    <a key={href} href={href} className="flex items-center gap-3 rounded border border-transparent px-3 py-2 transition hover:border-zinc-800 hover:bg-black/40 hover:text-white">
                      <span className="font-mono text-xs text-zinc-600">{String(index + 1).padStart(2, "0")}</span>
                      <span>{title}</span>
                    </a>
                  ))}
                </nav>
                <p className="mt-4 text-xs leading-6 text-zinc-500">
                  Reading for adoption? Start with Why a standard, Failure states, and Adoption path. Reading to implement? Start with Minimum V1 Contract, SDK Authoring, and Compatibility.
                </p>
                <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="mb-2 text-green-400">Spec subsections</div>
                  <div className="grid gap-2 text-zinc-500">
                    {[
                      ["Core model", "#section-01"],
                      ["Dimensions", "#section-02"],
                      ["Artifacts", "#section-03"],
                      ["Judges", "#section-04"],
                      ["Harness", "#section-05"],
                      ["Compatibility", "#section-06"],
                    ].map(([title, href]) => (
                      <a key={href} href={href} className="rounded border border-zinc-900 bg-zinc-950/70 px-3 py-2 hover:text-white">
                        {title}
                      </a>
                    ))}
                  </div>
                </div>
              </aside>

              <article className="space-y-16">
                <div className="border-b border-zinc-800 pb-10">
                  <div className="font-mono text-sm text-green-400">ABSTRACT</div>
                  <h2 className="mt-4 text-3xl font-bold md:text-5xl">The standard is a graph, not a checklist.</h2>
                  <p className="mt-6 max-w-3xl text-lg leading-8 text-zinc-400">
                    A rubric defines what quality means. Proof artifacts show what happened. Judges evaluate declared proof and produce typed judgment artifacts. The harness runs that graph over one or many candidates so teams can compare work, audit decisions, and gradually evolve taste into measurable checks.
                  </p>
                  <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-sm">
                    <div className="text-green-400">If you read only this</div>
                    <div className="mt-3 grid gap-3 text-zinc-500 md:grid-cols-4">
                      <div><span className="text-zinc-200">Artifacts</span><div className="mt-1">typed evidence and typed judgments are both first-class outputs</div></div>
                      <div><span className="text-zinc-200">Judges</span><div className="mt-1">consume only declared inputs and return portable outputs</div></div>
                      <div><span className="text-zinc-200">Manifest</span><div className="mt-1">is the normative cross-tool contract, not the SDK syntax</div></div>
                      <div><span className="text-zinc-200">Use it</span><div className="mt-1">when comparable candidate decisions matter across runs or tools</div></div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-black p-5">
                    <div className="mb-4 font-mono text-sm text-green-400">ONE RUN, END TO END</div>
                    <div className="grid gap-3 text-sm md:grid-cols-5">
                      {[
                        ["1", "Collect proof", "proof.screenshot + proof.test-output"],
                        ["2", "Validate", "check schema digests and required inputs"],
                        ["3", "Judge", "run command/LLM judge on declared artifacts"],
                        ["4", "Emit judgments", "store typed verdicts with provenance"],
                        ["5", "Decide", "promote, review, reject, or needs-more-proof"],
                      ].map(([step, title, copy]) => (
                        <div key={step} className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                          <div className="mb-2 flex h-6 w-6 items-center justify-center rounded border border-green-500/30 bg-green-500/10 font-mono text-[10px] text-green-400">{step}</div>
                          <div className="font-mono text-zinc-100">{title}</div>
                          <div className="mt-2 leading-6 text-zinc-500">{copy}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 border-b border-zinc-800 pb-10 md:grid-cols-2">
                  <div className="rounded-lg border border-zinc-800 bg-black p-5">
                    <div className="mb-4 font-mono text-sm text-green-400">NORMATIVE VOCABULARY</div>
                    <div className="grid gap-3 text-sm">
                      {glossaryTerms.map(([term, definition]) => (
                        <div key={term} className="grid gap-1 border-b border-zinc-900 pb-3 last:border-b-0">
                          <div className="font-mono text-zinc-200">{term}</div>
                          <div className="leading-6 text-zinc-500">{definition}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-black p-5">
                    <div className="mb-4 font-mono text-sm text-green-400">CONFORMANCE SURFACE</div>
                    <div className="space-y-4 text-sm">
                      {conformanceItems.map(([label, copy]) => (
                        <div key={label}>
                          <div className="font-mono text-zinc-200">{label}</div>
                          <p className="mt-1 leading-6 text-zinc-500">{copy}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="grid gap-4 border-b border-zinc-800 pb-10 md:grid-cols-2">
                  <div className="rounded-lg border border-zinc-800 bg-black p-5">
                    <div className="mb-4 font-mono text-sm text-green-400">STANDARD STATUS</div>
                    <div className="grid gap-3 text-sm md:grid-cols-2">
                      {statusStrip.map(([label, value]) => (
                        <div key={label} className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                          <div className="font-mono text-zinc-200">{label}</div>
                          <div className="mt-2 leading-6 text-zinc-500">{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-black p-5">
                    <div className="mb-4 font-mono text-sm text-green-400">MINIMUM V1 CONTRACT</div>
                    <div className="grid gap-3 text-sm">
                      {minimumContractRows.map(([area, required, fields]) => (
                        <div key={area} className="grid gap-2 border-b border-zinc-900 pb-3 last:border-b-0 md:grid-cols-[150px_90px_1fr]">
                          <div className="font-mono text-zinc-200">{area}</div>
                          <div className={required === "required" ? "text-green-400" : "text-zinc-500"}>{required}</div>
                          <div className="leading-6 text-zinc-500">{fields}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>


                <div className="rounded-lg border border-zinc-800 bg-black p-5">
                  <div className="mb-4 font-mono text-sm text-green-400">CONFORMING RUNTIME CHECKLIST</div>
                  <div className="grid gap-3 text-sm">
                    {[
                      "Parse the canonical manifest and reproduce its digest.",
                      "Validate artifact envelopes and schema digests before using them.",
                      "Refuse undeclared judge inputs and surface unsupported capabilities.",
                      "Preserve historical manifests and artifacts even when a judge cannot re-run.",
                    ].map((item) => (
                      <div key={item} className="flex items-start gap-3"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-500" /><span className="text-zinc-400">{item}</span></div>
                    ))}
                  </div>
                </div>

                {whitepaperSections.map(({ id, title, summary, bullets, example, avoids }) => (
                  <section id={`section-${id}`} key={id} className="scroll-mt-24 border-b border-zinc-900 pb-12 last:border-b-0">
                    <div className="mb-3 font-mono text-sm text-green-400">{id}</div>
                    <h3 className="text-2xl font-bold md:text-4xl">{title}</h3>
                    <p className="mt-4 max-w-3xl text-lg leading-8 text-zinc-400">{summary}</p>
                    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_280px]">
                      <ul className="space-y-3 text-zinc-300">
                        {bullets.map((bullet) => (
                          <li key={bullet} className="flex gap-3">
                            <Check className="mt-1 h-4 w-4 shrink-0 text-green-500" />
                            <span className="leading-7">{bullet}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="space-y-3 font-mono text-xs">
                        <div className="rounded border border-zinc-800 bg-black p-4">
                          <div className="mb-2 text-zinc-600">example</div>
                          <div className="leading-5 text-green-300">{example}</div>
                        </div>
                        <div className="rounded border border-zinc-800 bg-black p-4">
                          <div className="mb-2 text-zinc-600">avoids</div>
                          <div className="leading-5 text-zinc-400">{avoids}</div>
                        </div>
                      </div>
                    </div>
                  </section>
                ))}
              </article>
            </div>
          </div>
        </section>

        <section id="judge-lanes" className="py-24">
          <div className="container mx-auto px-4">
            <div className="mb-16 text-center">
              <Label><Gavel className="h-4 w-4" /><span>JUDGE LANES</span></Label>
              <h2 className="text-3xl font-bold md:text-5xl">Different questions deserve different judges.</h2>
              <div className="mx-auto mt-4 h-1 w-20 rounded-full bg-green-500" />
            </div>
            <p className="mx-auto mt-4 max-w-3xl text-sm leading-6 text-zinc-500">
              These lanes differ in who evaluates the evidence, but they should share one stable request/response contract so their outputs remain interchangeable.
            </p>
            <p className="mx-auto mt-3 max-w-3xl text-sm leading-6 text-zinc-500">
              Choose the cheapest lane that can validly transform the declared inputs into the artifact you need.
            </p>

            <div className="overflow-hidden rounded-lg border border-zinc-800 bg-black font-mono shadow-2xl">
              <div className="hidden grid-cols-5 border-b border-zinc-800 bg-zinc-900/50 px-4 py-3 text-xs uppercase tracking-wider text-zinc-500 md:grid">
                <div>judge</div><div>use when</div><div>inputs</div><div>output</div><div>example</div>
              </div>
              {judgeRows.map(([judge, use, inputs, output, example]) => (
                <div key={judge} className="grid grid-cols-1 gap-3 border-b border-zinc-900 px-4 py-4 text-sm last:border-b-0 md:grid-cols-5">
                  <div><span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600 md:hidden">judge</span><span className="text-green-400">{judge}</span></div>
                  <div><span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600 md:hidden">use when</span><span className="text-zinc-300">{use}</span></div>
                  <div><span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600 md:hidden">inputs</span><span className="text-zinc-500">{inputs}</span></div>
                  <div><span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600 md:hidden">output</span><span className="text-blue-300">{output}</span></div>
                  <div><span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600 md:hidden">example</span><span className="text-zinc-400">{example}</span></div>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="py-10">
          <div className="container mx-auto px-4">
            <p className="mx-auto max-w-3xl text-center text-sm leading-6 text-zinc-500">
              Judge lanes answer who should evaluate a declared input set. Failure states answer what a truthful runtime or judge is allowed to return when the evidence or execution path breaks down.
            </p>
          </div>
        </section>
        <section id="failure-states" className="border-y border-white/10 bg-zinc-950 py-20">
          <div className="container mx-auto px-4">
            <div className="mb-10 max-w-3xl">
              <Label><Gavel className="h-4 w-4" /><span>FAILURE STATES</span></Label>
              <h2 className="text-3xl font-bold md:text-5xl">Structured judgments should prevent false confidence.</h2>
              <p className="mt-5 text-lg leading-8 text-zinc-400">
                Missing evidence and runtime failures are first-class outcomes. A judge should not turn uncertainty into a pass/fail verdict just to keep a pipeline moving.
              </p>
              <p className="mt-3 text-sm leading-6 text-zinc-500">
                Treat these as typed judge or harness outcomes. Do not hide them as transport errors or silent retries.
              </p>
              <p className="mt-3 text-sm leading-6 text-zinc-500">
                In practice: <span className="text-zinc-300">status</span> tells you whether the artifact is usable; <span className="text-zinc-300">verdict</span> tells you what the evidence means.
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-black font-mono text-sm">
              <div className="hidden grid-cols-3 border-b border-zinc-800 px-4 py-3 text-xs uppercase tracking-wider text-zinc-600 md:grid">
                <div>state</div><div>meaning</div><div>next action</div>
              </div>
              {failureStates.map(([state, meaning, action]) => (
                <div key={state} className="grid grid-cols-1 gap-2 border-b border-zinc-900 px-4 py-4 last:border-b-0 md:grid-cols-3">
                  <div><span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600 md:hidden">state</span><span className="text-green-400">{state}</span></div>
                  <div><span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600 md:hidden">meaning</span><span className="text-zinc-300">{meaning}</span></div>
                  <div><span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600 md:hidden">next action</span><span className="text-zinc-500">{action}</span></div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
              <div className="text-green-400">Example</div>
              <p className="mt-2 leading-6 text-zinc-500">
                A missing screenshot should produce <span className="text-zinc-300">needs-more-proof</span>, not a failing UX score. A bad screenshot can still produce <span className="text-zinc-300">failed</span>.
              </p>
            </div>
          </div>
        </section>

        <section id="sdk" className="border-y border-white/10 bg-zinc-950 py-24">
          <div className="container mx-auto px-4">
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <div>
                <Label><Code2 className="h-4 w-4" /><span>SDK AUTHORING</span></Label>
                <h2 className="text-3xl font-bold md:text-5xl">Variables in code. Digests in history.</h2>
                <p className="mt-6 text-lg leading-8 text-zinc-400">
                  Authors wire graphs with object references, not strings. The SDK compiles those references into a canonical manifest with stable ids, graph edges, schema digests, and required runtime capabilities.
                </p>
                <div className="mt-8 grid gap-3 text-sm text-zinc-300">
                  {[
                    "Define dimensions as typed quality axes with scoring guidance.",
                    "Declare proof units that produce structured artifacts or content-addressed blobs.",
                    "Create judge units that consume artifact variables and emit typed judgment variables.",
                    "Expose final outputs that the harness can produce, cache, replay, and compare.",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-3"><Check className="mt-0.5 h-5 w-5 shrink-0 text-green-500" /><span>{item}</span></div>
                  ))}
                </div>

                <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="text-green-400">Notice</div>
                  <p className="mt-2 leading-6 text-zinc-500">
                    Object references in SDK code become graph edges in the manifest; authors do not hand-write edge strings.
                  </p>
                </div>
              </div>
              <SpecCodeBlock />
            </div>

            <div className="mt-10 rounded-lg border border-zinc-800 bg-black p-5 font-mono text-sm">
              <div className="mb-4 text-xs uppercase tracking-wider text-green-400">authoring reference → manifest contract</div>
              <div className="grid gap-3 md:grid-cols-4">
                {authoringMapping.map(([source, identity, compiled]) => (
                  <div key={source} className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                    <div className="text-zinc-100">{source}</div>
                    <div className="mt-2 leading-5 text-blue-300">{identity}</div>
                    <div className="mt-1 leading-5 text-zinc-500">{compiled}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-5 font-mono text-sm">
              <div className="mb-4 text-xs uppercase tracking-wider text-green-400">stable judge ABI</div>
              <div className="grid gap-3 md:grid-cols-4">
                {judgeAbiRows.map(([part, contract]) => (
                  <div key={part} className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                    <div className="text-zinc-100">{part}</div>
                    <div className="mt-2 leading-5 text-zinc-500">{contract}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
              <div className="text-green-400">What this proves</div>
              <p className="mt-2 leading-6 text-zinc-500">
                SDK syntax can be ergonomic and language-specific, while the manifest, ABI, and artifact envelopes remain the portable contract.
              </p>
            </div>
          </div>
        </section>

        <section id="artifact-envelope" className="py-24">
          <div className="container mx-auto px-4">
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <EnvelopeBlock />
              <div>
                <Label><FileCheck2 className="h-4 w-4" /><span>ARTIFACT ENVELOPE</span></Label>
                <h2 className="text-3xl font-bold md:text-5xl">Every proof and judgment keeps its context.</h2>
                <p className="mt-6 text-lg leading-8 text-zinc-400">
                  The envelope is the portability layer. It tells another harness what the artifact is, which candidate produced it, which schema validates it, what inputs it depended on, and which judge or human created it.
                </p>
                <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="text-green-400">Field guide</div>
                  <div className="mt-3 grid gap-3">
                    <div><span className="text-zinc-200">identity/provenance:</span> <span className="text-zinc-500">id, run, candidate, producer, createdAt</span></div>
                    <div><span className="text-zinc-200">schema/digest:</span> <span className="text-zinc-500">schema id, schema digest, manifest digest</span></div>
                    <div><span className="text-zinc-200">payload:</span> <span className="text-zinc-500">proof data, metric value, judgment score, or decision</span></div>
                  </div>
                </div>
                <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="text-green-400">Same envelope, different payloads</div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                      <div className="text-zinc-200">proof.screenshot</div>
                      <div className="mt-2 text-zinc-500">`data` contains raw evidence the runtime can display or pass to judges.</div>
                    </div>
                    <div className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                      <div className="text-zinc-200">judgment.visual-review</div>
                      <div className="mt-2 text-zinc-500">`data` contains an interpretation of declared evidence, with verdict and scores.</div>
                    </div>
                  </div>
                </div>

                <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="text-green-400">Security and privacy boundary</div>
                  <ul className="mt-3 space-y-2 text-zinc-500">
                    {[
                      "Command judges get only declared capabilities, not ambient secrets or network access by default.",
                      "Large files and screenshots should be referenced as blobs with retention and redaction policy, not copied blindly into judgment payloads.",
                      "LLM and human judges should receive only declared artifacts and should record prompt/input provenance alongside outputs.",
                    ].map((rule) => (
                      <li key={rule} className="flex gap-2"><span className="text-green-500">›</span><span>{rule}</span></li>
                    ))}
                  </ul>
                </div>
                <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="text-green-400">Envelope boundary</div>
                  <p className="mt-2 leading-6 text-zinc-500">
                    Everything outside <span className="text-zinc-300">data</span> is portable provenance and validation metadata; <span className="text-zinc-300">data</span> is the schema-specific payload.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="compatibility" className="border-y border-white/10 bg-zinc-950 py-24">
          <div className="container mx-auto px-4">
            <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
              <div>
                <Label><ShieldCheck className="h-4 w-4" /><span>VERSION COMPATIBILITY</span></Label>
                <h2 className="text-3xl font-bold md:text-5xl">Avoid SDK drift by making the manifest the standard.</h2>
                <p className="mt-6 text-lg leading-8 text-zinc-400">
                  SDK syntax is non-normative. The manifest is normative. GitSpace persists the compiled manifest, schemas, digests, inputs, and outputs used for each run. Old artifacts stay inspectable even when newer SDKs change their APIs.
                </p>
                <div className="mt-8 grid gap-4 sm:grid-cols-2">
                  {["Manifest snapshots", "Capability negotiation", "Stable judge ABI", "Artifact provenance"].map((item) => (
                    <div key={item} className="rounded-lg border border-zinc-800 bg-black p-4 font-mono text-sm text-zinc-300">
                      <GitCompareArrows className="mb-3 h-5 w-5 text-green-500" />
                      {item}
                    </div>
                  ))}
                </div>

                <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="mb-3 uppercase tracking-wider text-zinc-600">canonicalization rule</div>
                  <ul className="space-y-2 text-zinc-500">
                    {canonicalRules.map((rule) => (
                      <li key={rule} className="flex gap-2"><span className="text-green-500">›</span><span>{rule}</span></li>
                    ))}
                  </ul>
                </div>

                <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="mb-3 uppercase tracking-wider text-zinc-600">compatibility layers</div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      ["manifestVersion", "render + validate graph shape"],
                      ["schema digest", "validate existing artifact data"],
                      ["capability version", "decide whether a judge can re-run"],
                    ].map(([layer, rule]) => (
                      <div key={layer} className="rounded border border-zinc-900 bg-zinc-950/70 p-3">
                        <div className="text-green-300">{layer}</div>
                        <div className="mt-2 leading-5 text-zinc-500">{rule}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <ManifestBlock />
            </div>
          </div>
        </section>

        <section id="adoption-path" className="border-y border-white/10 bg-zinc-950 py-20">
          <div className="container mx-auto px-4">
            <div className="mb-10 max-w-3xl">
              <Label><BookOpen className="h-4 w-4" /><span>ADOPTION PATH</span></Label>
              <h2 className="text-3xl font-bold md:text-5xl">Adopt the graph gradually.</h2>
              <p className="mt-5 text-lg leading-8 text-zinc-400">
                Teams do not need composite candidate search on day one. Start with the artifacts you already produce, then promote repeated review decisions into judges.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-4">
              {adoptionSteps.map(([step, title, copy]) => (
                <div key={step} className="rounded-lg border border-zinc-800 bg-black p-5">
                  <div className="mb-4 flex h-8 w-8 items-center justify-center rounded border border-green-500/30 bg-green-500/10 font-mono text-green-400">{step}</div>
                  <div className="font-mono text-zinc-100">{title}</div>
                  <p className="mt-3 text-sm leading-6 text-zinc-500">{copy}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-5">
              <div className="mb-4 font-mono text-sm text-green-400">PILOT CHECKLIST</div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-3 font-mono text-xs uppercase tracking-wider text-zinc-600">Pilot entry</div>
                  <div className="grid gap-2 text-sm text-zinc-500">
                    {[
                      "one existing CI command or screenshot wrapped as a proof artifact",
                      "one schema-validated judgment emitted from that proof",
                      "one manifest digest persisted so the run can be reopened later",
                    ].map((item) => (
                      <div key={item} className="flex gap-2 rounded border border-zinc-900 bg-zinc-950/70 px-3 py-3"><span className="text-green-500">›</span><span>{item}</span></div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-3 font-mono text-xs uppercase tracking-wider text-zinc-600">Pilot exit gate</div>
                  <div className="grid gap-2 text-sm text-zinc-500">
                    {[
                      "one real decision was easier to audit than the old process",
                      "one missing-proof or unsupported-capability case surfaced correctly",
                      "one historical run reopened from its manifest digest and artifacts",
                    ].map((item) => (
                      <div key={item} className="flex gap-2 rounded border border-zinc-900 bg-zinc-950/70 px-3 py-3"><span className="text-green-500">›</span><span>{item}</span></div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-5">
              <div className="mb-4 font-mono text-sm text-green-400">MINIMUM TEAM OWNERSHIP MODEL</div>
              <div className="grid gap-3 text-sm md:grid-cols-[170px_1fr_1fr]">
                {[
                  ["Schema owner", "approve field changes and back-compat policy", "without this, historical artifacts become untrustworthy"],
                  ["Storage/privacy owner", "set retention, redaction, and blob limits", "without this, evidence may leak or disappear"],
                  ["Judge owner", "calibrate command/LLM/human lanes and investigate drift", "without this, typed judgments still become unreliable"],
                  ["Runtime owner", "own capability negotiation, migrations, and display-only fallbacks", "without this, old runs break silently"],
                ].map(([owner, responsibility, consequence]) => (
                  <div key={owner} className="contents">
                    <div className="rounded border border-zinc-900 bg-zinc-950/70 p-3 font-mono text-zinc-200">{owner}</div>
                    <div className="rounded border border-zinc-900 bg-zinc-950/70 p-3 text-zinc-500">{responsibility}</div>
                    <div className="rounded border border-zinc-900 bg-zinc-950/70 p-3 text-zinc-500">{consequence}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-5">
              <div className="mb-4 font-mono text-sm text-green-400">WHO MUST SAY YES BEFORE PILOT</div>
              <p className="text-sm leading-6 text-zinc-500">
                Before rollout, one person may temporarily cover multiple roles, but schema ownership, storage/privacy ownership, and runtime ownership must be explicit. Judge ownership becomes mandatory as soon as judgments influence promote or reject decisions.
              </p>
            </div>
            <div className="mt-6 rounded-lg border border-zinc-800 bg-black p-5">
              <div className="mb-4 font-mono text-sm text-green-400">ADOPT THIS ONLY IF AT LEAST TWO ARE TRUE</div>
              <div className="grid gap-2 text-sm text-zinc-500 md:grid-cols-2">
                {adoptionThreshold.map((item) => (
                  <div key={item} className="flex gap-2 rounded border border-zinc-900 bg-zinc-950/70 px-3 py-3"><span className="text-green-500">›</span><span>{item}</span></div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="candidate-search" className="py-24">
          <div className="container mx-auto px-4">
            <div className="rounded-lg border border-zinc-800 bg-black p-8 md:p-12">
              <div className="grid gap-8 lg:grid-cols-[1fr_420px] lg:items-center">
                <div>
                  <Label><Network className="h-4 w-4" /><span>CANDIDATE SEARCH</span></Label>
                  <h2 className="text-3xl font-bold md:text-5xl">From “I need to see it” to “the system can search it.”</h2>
                  <p className="mt-6 max-w-3xl text-lg leading-8 text-zinc-400">
                    Run five or ten implementations in parallel once the artifact contract is stable. Candidate comparison is valid only when candidates use the same manifest digest, required proof set, compatible judge versions, and equivalent execution environments.
                  </p>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-950/80 font-mono text-xs">
                  <div className="border-b border-zinc-800 px-3 py-2 text-zinc-500">same manifest, comparable judgments</div>
                  <div className="grid grid-cols-5 border-b border-zinc-800 px-3 py-2 uppercase tracking-wider text-zinc-600"><div>candidate</div><div>tests</div><div>clarity</div><div>decision</div><div>reason</div></div>
                  {[
                    ["A", "fail", "—", "reject", "gate failed"],
                    ["B", "pass", "4.7", "promote", "highest score"],
                    ["C", "pass", "3.9", "review", "ambiguous UX"],
                  ].map(([candidate, tests, clarity, decision, reason]) => (
                    <div key={candidate} className="grid grid-cols-5 border-b border-zinc-900 px-3 py-2 last:border-b-0">
                      <div className="text-zinc-300">{candidate}</div>
                      <div className={tests === "pass" ? "text-green-400" : "text-red-300"}>{tests}</div>
                      <div className="text-blue-300">{clarity}</div>
                      <div className="text-purple-300">{decision}</div>
                      <div className="text-zinc-500">{reason}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="mb-3 text-green-400">comparability checklist</div>
                  <div className="grid gap-2 text-zinc-500 md:grid-cols-2">
                    {[
                      "same manifest digest",
                      "same required proof set",
                      "same dimension ids and scales",
                      "compatible judge capability versions",
                      "equivalent execution environment",
                      "no missing required judgments",
                    ].map((item) => (
                      <div key={item} className="flex gap-2"><span className="text-green-500">›</span><span>{item}</span></div>
                    ))}
                  </div>
                </div>
                <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="text-green-400">Do not rank when</div>
                  <p className="mt-2 leading-6 text-zinc-500">
                    Do not rank candidates when manifest digests differ, required proof is missing, execution environments differ, or a judge/version change makes the scores no longer comparable.
                  </p>
                </div>
                <div className="mt-4 rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs">
                  <div className="text-green-400">Why candidate A has no clarity score</div>
                  <p className="mt-2 leading-6 text-zinc-500">
                    The failed command gate rejects A before semantic scoring, so the missing clarity value is intentional rather than unknown.
                  </p>
                </div>
              </div>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <Button asChild size="lg" className="h-12 bg-white px-8 text-base text-black hover:bg-gray-200">
                    <a href="#section-06">Read manifest boundary</a>
                  </Button>
                  <Button asChild variant="outline" size="lg" className="h-12 border-white/10 px-8 text-base hover:bg-white/5">
                    <a href="#sdk">Start with SDK authoring</a>
                  </Button>
                </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
