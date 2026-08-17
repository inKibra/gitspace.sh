import FaultyTerminal from "./FaultyTerminal";
import { Button } from "../../app/components/ui/button";
import { Github, ArrowDown } from "lucide-react";

const DOTS = [
  ["bg-green-500", "working"],
  ["bg-blue-500", "idle · waiting on you"],
  ["bg-amber-400", "asked you a question"],
];

export function HomeHero() {
  return (
    <section className="relative pt-28 pb-24 px-4 overflow-hidden border-b border-[#1a1a1a]">
      {/* the shader — the site's signature texture */}
      <div className="absolute inset-0 w-full h-full z-0 opacity-[0.13]">
        <FaultyTerminal
          scale={2}
          gridMul={[2, 1]}
          digitSize={1.2}
          timeScale={0.4}
          pause={false}
          scanlineIntensity={0.3}
          glitchAmount={1}
          flickerAmount={1}
          noiseAmp={1}
          chromaticAberration={0}
          dither={1}
          curvature={0}
          tint="#22c55e"
          mouseReact={false}
          pageLoadAnimation={false}
          brightness={0.4}
        />
      </div>
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.78)_72%,#000)]" />

      <div className="container mx-auto text-center relative z-10 max-w-5xl">
        <div className="text-[13px] font-mono text-green-500/80 mb-6 uppercase tracking-widest">
          An independent engineering harness · by inkibra
        </div>
        <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6 bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60">
          Run a fleet of coding agents<br />through a real delivery lifecycle.
        </h1>
        <p className="text-xl md:text-2xl text-zinc-400 max-w-3xl mx-auto mb-4 leading-relaxed">
          Planning, context, implementation, review, and shipped-goal operations: one harness, agents under control.
        </p>
        <p className="text-lg font-mono text-green-400 mb-10">Keep your fleet green.</p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
          <Button asChild size="lg" className="bg-white text-black hover:bg-gray-200 h-12 px-8 text-base rounded-none">
            <a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer">
              <Github className="w-5 h-5 mr-2" /> Star on GitHub
            </a>
          </Button>
          <Button asChild variant="outline" size="lg" className="h-12 px-8 text-base border-white/10 hover:bg-white/5 rounded-none">
            <a href="#flow">
              The Fleet Green flow <ArrowDown className="ml-2 w-4 h-4" />
            </a>
          </Button>
        </div>

        <div className="relative group max-w-4xl mx-auto">
          <div className="absolute -inset-1 bg-gradient-to-b from-green-500/20 to-transparent blur-2xl opacity-50 group-hover:opacity-75 transition duration-500" />
          <video
            controls
            playsInline
            preload="metadata"
            poster="/notes/fleet-green-poster.jpg"
            className="relative w-full border border-[#1a1a1a] bg-black"
          >
            <source src="/notes/fleet-green.mp4" type="video/mp4" />
          </video>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mt-4 text-[12px] font-mono text-zinc-500">
            {DOTS.map(([c, l]) => (
              <span key={l} className="flex items-center gap-2">
                <span className={`h-2 w-2 ${c}`} /> {l}
              </span>
            ))}
            <a href="/notes/babysitting-agents-sucks" className="text-green-400 hover:text-green-300">
              the story behind this → Nº 01: “Babysitting agents sucks.”
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
