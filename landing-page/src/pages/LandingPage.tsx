import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Footer } from "../components/layout/Footer";
import { HomeHero } from "../components/landing/HomeHero";
import { BoardShot } from "../components/landing/ProductShots";
import { ProcessSection, AskSection } from "../components/landing/ProcessSection";
import { ChainKanbanShot } from "../components/landing/ChainKanbanShot";
import { SkillsSection } from "../components/landing/SkillsSection";
import { OmpSection } from "../components/landing/OmpSection";
import { Credibility } from "../components/landing/Credibility";
import { Comparison } from "../components/landing/Comparison";
import { Security } from "../components/landing/Security";
import { Pricing } from "../components/landing/Pricing";
import { CTA } from "../components/landing/CTA";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />
      <main>
        <HomeHero />

        {/* the product: the board, full width */}
        <section id="features" className="py-20 px-4">
          <div className="container mx-auto max-w-6xl">
            <div className="mb-10 max-w-3xl">
              <div className="text-[13px] font-mono text-green-500/80 mb-4 uppercase tracking-widest">The product</div>
              <h2 className="text-3xl md:text-5xl font-bold mb-4">Your whole fleet, one glance.</h2>
              <p className="text-lg text-zinc-400 leading-relaxed">
                The board and the strip carry the same signal: green is working, blue is waiting on you, amber asked
                you a question. No opening threads one by one to find out who needs you.
              </p>
            </div>
            <BoardShot />
            <div className="mt-4 text-center text-[12px] font-mono text-zinc-600">
              live mock · the real thing runs in your terminal and browser ·{" "}
              <a href="/blog/babysitting-agents-sucks" className="text-green-500 hover:text-green-400">try the interactive version →</a>
            </div>
          </div>
        </section>

        <ProcessSection />

        {/* chains: ordered goals across the board */}
        <section className="py-20 px-4">
          <div className="container mx-auto max-w-6xl">
            <div className="mb-10 max-w-3xl">
              <div className="text-[13px] font-mono text-green-500/80 mb-4 uppercase tracking-widest">Chains</div>
              <h2 className="text-3xl md:text-5xl font-bold mb-4">Goals ship in order.</h2>
              <p className="text-lg text-zinc-400 leading-relaxed">
                Big features do not fit in one branch. Chain the goals: they ship in order, and each goal gets a
                workspace only while an agent works it. Hover a card and its whole chain lights up across the board.
              </p>
            </div>
            <ChainKanbanShot />
            <div className="mt-4 text-center text-[12px] font-mono text-zinc-600">
              live mock · hover traces a chain · click pins it · blocked goals wait for their ancestor
            </div>
          </div>
        </section>

        <SkillsSection />
        <OmpSection />
        <AskSection />
        <Credibility />
        <Comparison />
        <Security />
        <Pricing />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
