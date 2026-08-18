import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Footer } from "../components/layout/Footer";
import { ArrowRight } from "lucide-react";
import { SPECS, type Spec } from "../content/site";

/**
 * The shelf for design docs and open standards.
 *
 * This page is indexed; the specs on it are not (see site.ts). That split is
 * deliberate — the shelf should be findable, while unsettled thinking should not
 * outrank the real docs.
 */

const STAGE_STYLES: Record<Spec["stage"], string> = {
  Draft: "border-amber-400/40 text-amber-300 bg-amber-400/5",
  Proposed: "border-blue-400/40 text-blue-300 bg-blue-400/5",
  Stable: "border-green-500/40 text-green-400 bg-green-500/5",
};

export default function SpecsIndex() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />

      <header className="border-b border-white/10">
        <div className="container mx-auto px-4 pt-20 pb-14 max-w-4xl">
          <div className="text-[13px] font-mono text-green-500/80 mb-4 uppercase tracking-widest">
            Specs
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            Built in the open, before they’re settled.
          </h1>
          <p className="text-lg text-zinc-400 mt-4 max-w-2xl">
            Design docs and standards we’re still working on. Published because a standard nobody can
            read is a standard nobody implements. Each one says how settled it is.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-14 max-w-4xl">
        <div className="grid gap-6">
          {SPECS.map((s) => (
            <a
              key={s.path}
              href={s.path}
              className="group border border-zinc-800 bg-zinc-950 p-6 hover:border-zinc-600 transition-colors"
            >
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <h2 className="text-2xl font-bold tracking-tight">{s.name}</h2>
                <span
                  className={`font-mono text-[11px] uppercase tracking-widest border px-2 py-0.5 ${STAGE_STYLES[s.stage]}`}
                >
                  {s.stage}
                </span>
                <span className="ml-auto font-mono text-[12px] text-zinc-600">
                  updated {s.updated}
                </span>
              </div>
              <p className="text-zinc-400 leading-relaxed">{s.summary}</p>
              <div className="mt-4 flex items-center gap-1 text-sm text-green-400 opacity-0 group-hover:opacity-100 transition-opacity">
                Read the spec <ArrowRight className="w-4 h-4" />
              </div>
            </a>
          ))}
        </div>

        <p className="text-sm text-zinc-600 mt-10 font-mono">
          Comments and objections: <a href="mailto:contact@inkibra.com" className="text-green-400 hover:text-green-300">contact@inkibra.com</a>
        </p>
      </main>

      <Footer />
    </div>
  );
}
