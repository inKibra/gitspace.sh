import { Button } from "../../app/components/ui/button";
import { ArrowRight } from "lucide-react";

export function Credibility() {
  return (
    <>
      {/* ── CREDIBILITY: the agent factory, stated once ─────────────── */}
        <section className="py-24">
          <div className="container mx-auto px-4 max-w-4xl">
            <div className="border border-[#1a1a1a] bg-gradient-to-br from-green-500/5 to-transparent p-10">
              <div className="text-[13px] font-mono text-green-500/80 mb-4 uppercase tracking-widest">
                Why trust this
              </div>
              <h2 className="text-3xl md:text-4xl font-bold mb-5">Built to run a real agent factory.</h2>
              <p className="text-lg text-zinc-400 leading-relaxed mb-8">
                GitSpace comes from <a href="https://www.inkibra.com" className="text-white underline underline-offset-4 decoration-zinc-700 hover:decoration-green-500">inkibra</a> and runs the
                agent factory behind inkibra’s client work. Every feature exists because a real delivery needed it: the
                strip because someone missed an idle agent, the rubrics because “looks good” isn’t review, the ask forms
                because questions deserve better than buried terminal prompts. Enterprise rollout means that factory,
                stood up for your team.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <Button asChild size="lg" className="bg-white text-black hover:bg-gray-200 h-12 px-8 rounded-none">
                  <a href="mailto:contact@inkibra.com">
                    Talk to inkibra <ArrowRight className="ml-2 w-4 h-4" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="lg" className="h-12 px-8 border-white/10 hover:bg-white/5 rounded-none">
                  <a href="/notes">Read the notes</a>
                </Button>
              </div>
            </div>
          </div>
        </section>

    </>
  );
}
