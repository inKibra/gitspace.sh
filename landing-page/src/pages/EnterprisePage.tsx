import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Footer } from "../components/layout/Footer";

const CAL_URL = "https://calendar.app.google/Y7NokskGxYFULAzeA";

const ROLLOUT_BLOCKS = [
  {
    num: "01",
    title: "Standup on your codebase",
    body: "Goals, rubrics, workflows, and skills written for your repos, not a template. The factory learns your conventions, your test suite, and your definition of done before the first agent runs.",
  },
  {
    num: "02",
    title: "Private or on-prem",
    body: "Self-hosted relay on your infrastructure, E2E encrypted end to end. Your code and your terminal traffic never route through servers you don't control.",
  },
  {
    num: "03",
    title: "The Fleet Green flow, adapted",
    body: "Plan, context, implement, review, operate: the same flow GitSpace prescribes, mapped onto how your team already ships. Your branch strategy, your review gates, your release cadence.",
  },
  {
    num: "04",
    title: "Run by the team that builds GitSpace",
    body: "inkibra operates the factory with you and keeps evolving it as the tool moves. You get the upstream roadmap applied to your deployment, not a fork that rots.",
  },
];

const STEPS = [
  {
    num: "01",
    title: "Intro call",
    body: "You walk us through the codebase and how work ships today. We tell you honestly whether a rollout fits.",
  },
  {
    num: "02",
    title: "Workflow audit",
    body: "We map your delivery process onto the flow, write the first goals and rubrics, and pick a real piece of work to start with.",
  },
  {
    num: "03",
    title: "First goal shipped",
    body: "A real change goes through the factory: planned, built by agents, reviewed with evidence, merged by your team.",
  },
];

export default function EnterprisePage() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />

      {/* Hero */}
      <header className="border-b border-[#1a1a1a]">
        <div className="container mx-auto px-4 pt-24 pb-16 max-w-4xl">
          <div className="text-[12px] font-mono text-green-500/80 uppercase tracking-widest mb-5">
            Enterprise Rollout
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05]">
            Get an agent factory without spending a year building one.
          </h1>
          <p className="text-lg md:text-xl text-zinc-400 mt-6 max-w-2xl leading-relaxed">
            An Enterprise Rollout is an engagement with inkibra, the company
            behind GitSpace. We stand up the factory on your infrastructure,
            tune it to your codebase, and run it with your team.
          </p>
          <div className="flex flex-wrap items-center gap-5 mt-10">
            <a
              href={CAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-6 py-3 bg-green-500 text-black font-mono text-sm font-semibold hover:bg-green-400 transition-colors"
            >
              Book an intro call →
            </a>
            <a
              href="mailto:contact@inkibra.com"
              className="font-mono text-sm text-zinc-400 hover:text-white transition-colors underline underline-offset-4 decoration-zinc-700"
            >
              or email contact@inkibra.com
            </a>
          </div>
        </div>
      </header>

      {/* What a rollout is */}
      <section className="border-b border-[#1a1a1a]">
        <div className="container mx-auto px-4 py-20 max-w-4xl">
          <div className="text-[12px] font-mono text-green-500/80 uppercase tracking-widest mb-4">
            What a rollout is
          </div>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            The whole harness, stood up for you.
          </h2>
          <p className="text-zinc-400 max-w-2xl mb-12">
            Not a license and a wiki page. inkibra does the setup work that
            makes agents useful on a real codebase, then stays on to run it.
          </p>
          <div className="grid md:grid-cols-2 border-t border-l border-[#1a1a1a]">
            {ROLLOUT_BLOCKS.map((b) => (
              <div
                key={b.num}
                className="border-b border-r border-[#1a1a1a] bg-[#080808] p-7"
              >
                <div className="font-mono text-[11px] text-zinc-600 mb-3">
                  {b.num}
                </div>
                <h3 className="text-lg font-semibold mb-2">{b.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{b.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it starts */}
      <section className="border-b border-[#1a1a1a]">
        <div className="container mx-auto px-4 py-20 max-w-4xl">
          <div className="text-[12px] font-mono text-green-500/80 uppercase tracking-widest mb-4">
            How it starts
          </div>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-12">
            Three steps, no ceremony.
          </h2>
          <div className="grid md:grid-cols-3 border-t border-l border-[#1a1a1a]">
            {STEPS.map((s) => (
              <div
                key={s.num}
                className="border-b border-r border-[#1a1a1a] p-7"
              >
                <div className="font-mono text-[11px] text-green-500/80 mb-3">
                  STEP {s.num}
                </div>
                <h3 className="text-lg font-semibold mb-2">{s.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Credibility */}
      <section className="border-b border-[#1a1a1a]">
        <div className="container mx-auto px-4 py-20 max-w-4xl">
          <div className="border border-[#1a1a1a] bg-[#080808] p-8 md:p-10">
            <div className="text-[12px] font-mono text-green-500/80 uppercase tracking-widest mb-4">
              Why us
            </div>
            <p className="text-xl md:text-2xl leading-relaxed text-zinc-200 max-w-3xl">
              No logo wall here. The honest credential is that inkibra built
              GitSpace to run its own agent factory for client work, and runs
              it every day. The factory we stand up for you is the one we
              depend on ourselves.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section>
        <div className="container mx-auto px-4 py-24 max-w-4xl text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            Start with a conversation.
          </h2>
          <p className="text-zinc-400 max-w-xl mx-auto mb-10">
            Thirty minutes about your codebase and how your team ships. If a
            rollout doesn't fit, we'll say so.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-5">
            <a
              href={CAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-8 py-4 bg-green-500 text-black font-mono text-sm font-semibold hover:bg-green-400 transition-colors"
            >
              Book an intro call →
            </a>
            <a
              href="mailto:contact@inkibra.com"
              className="font-mono text-sm text-zinc-400 hover:text-white transition-colors underline underline-offset-4 decoration-zinc-700"
            >
              or email contact@inkibra.com
            </a>
          </div>
          <p className="mt-12 text-sm text-zinc-600 font-mono">
            Enterprise Rollout is delivered by{" "}
            <a
              href="https://www.inkibra.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-500 hover:text-white transition-colors underline underline-offset-4 decoration-zinc-700"
            >
              inkibra
            </a>
            . AI systems built for control.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
