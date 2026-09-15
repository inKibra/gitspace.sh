import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils";

/**
 * The one big demo: a change-guide explorer over the checkout_v2 flag
 * removal. Left: clusters in build order with beat badges. Right: the
 * narrated beat (guide prose grounded in the phase journal, files touched,
 * a mini diff). A contrast toggle shows the same change as the flat
 * alphabetical 14-file list a normal PR page gives you.
 */

type DiffLine = { t: "hunk" | "ctx" | "add" | "del"; s: string };
type ChangedFile = { path: string; adds: number; dels: number; status: "M" | "D" | "A" };

type Beat = {
  stage: string;
  title: string;
  seq: number;
  of: number;
  files: ChangedFile[];
  prose: string[];
  journal: { phase: string; quote: string };
  diffFile: string;
  diff: DiffLine[];
};

const COMPONENT = "checkout_v2 removal";

const BEATS: Beat[] = [
  {
    stage: "FOUNDATIONS",
    title: "The flag registry",
    seq: 1,
    of: 4,
    files: [
      { path: "flags/registry.ts", adds: 0, dels: 7, status: "M" },
      { path: "flags/definitions/checkout.ts", adds: 2, dels: 31, status: "M" },
      { path: "flags/types.ts", adds: 1, dels: 2, status: "M" },
    ],
    prose: [
      "The flag dies at its source. checkout_v2 leaves the registry and the FlagName union, so every remaining consumer becomes a type error.",
      "Nothing else in this change depends on these files being read first, but everything that follows depends on this deletion. That is why the analyzer puts it in beat 1.",
    ],
    journal: {
      phase: "build · phase 1",
      quote: "Retire the flag at the definition first. The compiler will list every consumer for us.",
    },
    diffFile: "flags/registry.ts",
    diff: [
      { t: "hunk", s: "@@ -41,13 +41,6 @@ export const REGISTRY = {" },
      { t: "ctx", s: "  search_ranking_v3: { default: false }," },
      { t: "del", s: "  checkout_v2: {" },
      { t: "del", s: "    default: true," },
      { t: "del", s: '    description: "New checkout path",' },
      { t: "del", s: '    owners: ["payments"],' },
      { t: "del", s: '    rolledOutAt: "2026-05-14",' },
      { t: "del", s: "  }," },
      { t: "ctx", s: "  invoice_pdf: { default: false }," },
    ],
  },
  {
    stage: "WIRING",
    title: "Three guards, one per transport",
    seq: 2,
    of: 4,
    files: [
      { path: "api/middleware/flag-guard.ts", adds: 4, dels: 38, status: "M" },
      { path: "web/src/hooks/useCheckoutFlag.ts", adds: 0, dels: 54, status: "D" },
      { path: "worker/jobs/checkout-sync.ts", adds: 6, dels: 22, status: "M" },
    ],
    prose: [
      "Three guards read the flag, one per transport. Each collapses to its v2 branch: the api middleware stops routing, the web hook is deleted whole, the worker stops double-writing carts.",
      "Same edit three times. Read the api guard closely, then skim the other two.",
    ],
    journal: {
      phase: "build · phase 2",
      quote: "Canary: api first, watch errors 10m. Then web and worker.",
    },
    diffFile: "api/middleware/flag-guard.ts",
    diff: [
      { t: "hunk", s: "@@ -12,10 +12,7 @@ export async function routeCheckout(req: Request) {" },
      { t: "ctx", s: "  const session = await getSession(req);" },
      { t: "del", s: '  if (await flags.get("checkout_v2", session)) {' },
      { t: "del", s: "    return handleCheckoutV2(req, session);" },
      { t: "del", s: "  }" },
      { t: "del", s: "  return handleCheckoutV1(req, session);" },
      { t: "add", s: "  return handleCheckoutV2(req, session);" },
      { t: "ctx", s: "}" },
    ],
  },
  {
    stage: "SURFACES",
    title: "The checkout path",
    seq: 3,
    of: 4,
    files: [
      { path: "web/src/checkout/CheckoutPage.tsx", adds: 9, dels: 41, status: "M" },
      { path: "web/src/checkout/LegacyCheckout.tsx", adds: 0, dels: 312, status: "D" },
      { path: "api/routes/checkout.ts", adds: 5, dels: 27, status: "M" },
      { path: "web/src/checkout/analytics.ts", adds: 2, dels: 9, status: "M" },
    ],
    prose: [
      "This is the beat a user could feel. LegacyCheckout (312 lines) is deleted outright, CheckoutPage stops branching, and the api route drops its version param.",
      "Slow read here. Beats 1 and 2 converge on this path; if the removal breaks anything, it breaks on this page.",
    ],
    journal: {
      phase: "build · phase 3",
      quote: "Legacy path had zero sessions for 14 days. Deleting, not archiving.",
    },
    diffFile: "web/src/checkout/CheckoutPage.tsx",
    diff: [
      { t: "hunk", s: "@@ -1,9 +1,6 @@" },
      { t: "del", s: 'import { LegacyCheckout } from "./LegacyCheckout";' },
      { t: "del", s: 'import { useCheckoutFlag } from "../hooks/useCheckoutFlag";' },
      { t: "ctx", s: 'import { CheckoutV2 } from "./CheckoutV2";' },
      { t: "hunk", s: "@@ -18,9 +15,7 @@ export function CheckoutPage({ cart }: Props) {" },
      { t: "del", s: "  const v2 = useCheckoutFlag();" },
      { t: "del", s: "  if (!v2) return <LegacyCheckout cart={cart} />;" },
      { t: "ctx", s: "  return <CheckoutV2 cart={cart} />;" },
      { t: "ctx", s: "}" },
    ],
  },
  {
    stage: "TESTS",
    title: "Tests trail the beats they guard",
    seq: 4,
    of: 4,
    files: [
      { path: "api/routes/checkout.test.ts", adds: 18, dels: 64, status: "M" },
      { path: "web/src/checkout/CheckoutPage.test.tsx", adds: 12, dels: 88, status: "M" },
      { path: "worker/jobs/checkout-sync.test.ts", adds: 9, dels: 17, status: "M" },
      { path: "e2e/checkout.spec.ts", adds: 14, dels: 52, status: "M" },
    ],
    prose: [
      "The off-flag suites disappear and one new e2e run pins the only path that still exists.",
      "The check worth making: the deleted cases have v2 equivalents, not just deletions. The e2e spec guards beat 3, the riskiest one.",
    ],
    journal: {
      phase: "build · phase 4",
      quote: "Ported the two legacy regression cases to v2 before dropping the suite.",
    },
    diffFile: "e2e/checkout.spec.ts",
    diff: [
      { t: "hunk", s: "@@ -30,18 +30,6 @@" },
      { t: "del", s: 'test.describe("checkout with checkout_v2 off", () => {' },
      { t: "del", s: '  test("legacy path renders", async ({ page }) => {' },
      { t: "del", s: '    await setFlag(page, "checkout_v2", false);' },
      { t: "del", s: '    await expect(page.getByTestId("checkout-legacy")).toBeVisible();' },
      { t: "del", s: "  });" },
      { t: "del", s: "});" },
      { t: "add", s: 'test("checkout serves v2 to every session", async ({ page }) => {' },
      { t: "add", s: '  await page.goto("/checkout");' },
      { t: "add", s: '  await expect(page.getByTestId("checkout-v2")).toBeVisible();' },
      { t: "add", s: "});" },
    ],
  },
];

const DIFF_STYLE: Record<DiffLine["t"], string> = {
  hunk: "text-zinc-600",
  ctx: "text-zinc-500",
  add: "text-green-400",
  del: "text-red-400",
};
const DIFF_PREFIX: Record<DiffLine["t"], string> = { hunk: "", ctx: "  ", add: "+ ", del: "- " };

function FileRow({ f, dim = false }: { f: ChangedFile; dim?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-[12px] font-mono">
      <span className={cn("w-3 flex-none", f.status === "D" ? "text-red-400/80" : "text-zinc-500")}>{f.status}</span>
      <span className={cn("truncate", dim ? "text-zinc-400" : "text-zinc-300")}>{f.path}</span>
      <span className="ml-auto flex-none tabular-nums text-green-500/80">+{f.adds}</span>
      <span className="flex-none tabular-nums text-red-400/80">−{f.dels}</span>
    </div>
  );
}

export function ChangeGuideExplorer() {
  const [beat, setBeat] = useState(0);
  const [alpha, setAlpha] = useState(false);

  const b = BEATS[beat];
  const allFiles = useMemo(
    () => BEATS.flatMap((x) => x.files).sort((x, y) => x.path.localeCompare(y.path)),
    []
  );

  function step(d: number) {
    setBeat((i) => Math.min(BEATS.length - 1, Math.max(0, i + d)));
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={(e) => {
        if (alpha) return;
        if (e.key === "ArrowRight") step(1);
        if (e.key === "ArrowLeft") step(-1);
      }}
      className="outline-none focus-visible:ring-1 focus-visible:ring-green-500/40"
    >
      <div className="text-[11px] font-mono uppercase tracking-widest text-green-500/70 mb-2">
        demo · the change-guide explorer
      </div>
      <div className="border border-[#1a1a1a] bg-[#050505] overflow-hidden">
        {/* header */}
        <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center gap-3">
          <span className="text-[12px] text-zinc-400">
            {alpha ? "The same change, the way a PR page shows it." : "One change, four beats. Step through it in build order."}
          </span>
          <label className="ml-auto flex items-center gap-2 text-[12px] text-zinc-400 cursor-pointer select-none whitespace-nowrap">
            <input type="checkbox" checked={alpha} onChange={(e) => setAlpha(e.target.checked)} className="accent-green-500" />
            alphabetical file list
          </label>
        </div>

        {alpha ? (
          /* the contrast: a flat 14-file wall */
          <div className="p-4">
            <div className="border border-[#161616] bg-[#0a0a0a] divide-y divide-[#111111]">
              {allFiles.map((f) => (
                <div key={f.path} className="px-3 py-2">
                  <FileRow f={f} dim />
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <span className="text-[12px] text-zinc-500">
                14 files, sorted by name. The registry that explains everything is file six. Where do you start?
              </span>
              <button
                onClick={() => setAlpha(false)}
                className="ml-auto text-[12px] px-3 py-1.5 border border-green-500/40 text-green-400 hover:bg-green-500/10 transition-colors whitespace-nowrap"
              >
                show me the order
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid md:grid-cols-[230px_1fr]">
              {/* cluster list, build order */}
              <div className="border-b md:border-b-0 md:border-r border-[#1a1a1a] p-2 flex md:flex-col gap-1 overflow-x-auto">
                {BEATS.map((x, i) => (
                  <button
                    key={x.title}
                    onClick={() => setBeat(i)}
                    className={cn(
                      "text-left px-3 py-2.5 border transition-colors flex-none md:flex-auto min-w-[170px] md:min-w-0",
                      i === beat
                        ? "border-green-500/50 bg-[#0c0c0c]"
                        : "border-transparent hover:border-[#222222] hover:bg-[#0a0a0a]"
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={cn(
                          "h-4 w-4 flex items-center justify-center text-[10px] font-mono flex-none",
                          i === beat ? "bg-green-500 text-black" : "bg-[#141414] text-zinc-500"
                        )}
                      >
                        {x.seq}
                      </span>
                      <span className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-600">{x.stage}</span>
                      <span className="ml-auto text-[10px] font-mono text-zinc-600 tabular-nums">
                        {x.seq}/{x.of}
                      </span>
                    </div>
                    <div className={cn("text-[13px] leading-tight", i === beat ? "text-zinc-100" : "text-zinc-400")}>
                      {x.title}
                    </div>
                    <div className="text-[10px] font-mono text-zinc-600 mt-0.5">
                      {x.files.length} file{x.files.length > 1 ? "s" : ""}
                    </div>
                  </button>
                ))}
              </div>

              {/* the narrated beat */}
              <div className="p-4 md:p-5">
                <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-600 mb-3">
                  {COMPONENT} · beat {b.seq} of {b.of} · {b.stage.toLowerCase()}
                </div>

                {b.prose.map((p) => (
                  <p key={p} className="text-[14px] text-zinc-300 leading-relaxed mb-2.5">
                    {p}
                  </p>
                ))}

                {/* grounding: the phase journal quote */}
                <div className="border-l-2 border-green-500/50 pl-3 py-1 my-4">
                  <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-green-500/70 mb-1">
                    grounding · journal · {b.journal.phase}
                  </div>
                  <div className="text-[13px] text-zinc-400 italic">“{b.journal.quote}”</div>
                </div>

                {/* files in this cluster */}
                <div className="space-y-1.5 mb-4">
                  {b.files.map((f) => (
                    <FileRow key={f.path} f={f} />
                  ))}
                </div>

                {/* mini diff */}
                <div className="border border-[#161616] bg-[#0a0a0a]">
                  <div className="px-3 py-1.5 border-b border-[#111111] text-[10px] font-mono text-zinc-500">
                    {b.diffFile}
                  </div>
                  <div className="px-3 py-2 text-[11.5px] font-mono leading-[1.6] overflow-x-auto whitespace-pre">
                    {b.diff.map((l, i) => (
                      <div key={i} className={DIFF_STYLE[l.t]}>
                        {DIFF_PREFIX[l.t]}
                        {l.s}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* progress rail + stepper */}
            <div className="px-4 py-3 border-t border-[#1a1a1a] flex items-center gap-3">
              <button
                onClick={() => step(-1)}
                disabled={beat === 0}
                className="flex items-center gap-1 text-[12px] text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:hover:text-zinc-400"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> prev
              </button>
              <div className="flex-1 flex gap-1">
                {BEATS.map((x, i) => (
                  <div
                    key={x.title}
                    className={cn("h-1 flex-1 transition-colors duration-300", i <= beat ? "bg-green-500" : "bg-[#161616]")}
                    style={i === beat ? { boxShadow: "0 0 8px rgba(34,197,94,0.5)" } : undefined}
                  />
                ))}
              </div>
              <span className="text-[11px] font-mono text-zinc-500 tabular-nums">beat {b.seq}/{b.of}</span>
              <button
                onClick={() => step(1)}
                disabled={beat === BEATS.length - 1}
                className="flex items-center gap-1 text-[12px] text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:hover:text-zinc-400"
              >
                next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
