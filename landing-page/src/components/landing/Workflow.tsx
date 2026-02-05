import { Plus, Play, Smartphone, GitMerge, ArrowRight } from "lucide-react";

export function Workflow() {
  return (
    <section id="workflow" className="py-24 bg-zinc-950 relative overflow-hidden">
      <div className="container px-4 mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold mb-4">Built for how AI agents work</h2>
          <p className="text-zinc-400 max-w-2xl mx-auto">
            The old way: One branch. Wait for agent. Messy commits. Manual cleanup.<br />
            <span className="text-green-400">The GitSpace way: Parallel work. Remote monitoring. Secure relay.</span>
          </p>
        </div>

        <div className="relative">
          {/* Connecting Line (Desktop) */}
          <div className="hidden md:block absolute top-12 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-zinc-700 to-transparent" />

          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 relative z-10">
            <div className="flex flex-col items-center text-center group">
              <div className="w-24 h-24 rounded-2xl bg-black border border-zinc-800 flex items-center justify-center mb-6 shadow-xl group-hover:border-green-500/50 group-hover:shadow-green-500/10 transition-all duration-300 relative">
                  <Plus className="w-10 h-10 text-zinc-400 group-hover:text-green-400 transition-colors" />
                  <div className="absolute -bottom-3 bg-zinc-900 px-3 py-1 rounded-full text-xs font-bold border border-zinc-800 text-zinc-300">
                      CREATE
                  </div>
              </div>
              
              <code className="bg-black/50 px-3 py-1 rounded text-sm font-mono text-green-400/80 mb-2 border border-white/5 w-full md:w-auto truncate max-w-[200px]">
                  gssh add feature-x
              </code>
              
              <p className="text-zinc-500 text-sm">
                  Isolated workspace
              </p>

              {/* Mobile Arrow */}
              <ArrowRight className="md:hidden w-6 h-6 text-zinc-700 my-4" />
            </div>

            <div className="flex flex-col items-center text-center group">
              <div className="w-24 h-24 rounded-2xl bg-black border border-zinc-800 flex items-center justify-center mb-6 shadow-xl group-hover:border-green-500/50 group-hover:shadow-green-500/10 transition-all duration-300 relative">
                  <Play className="w-10 h-10 text-zinc-400 group-hover:text-green-400 transition-colors" />
                  <div className="absolute -bottom-3 bg-zinc-900 px-3 py-1 rounded-full text-xs font-bold border border-zinc-800 text-zinc-300">
                      RUN
                  </div>
              </div>
              
              <code className="bg-black/50 px-3 py-1 rounded text-sm font-mono text-green-400/80 mb-2 border border-white/5 w-full md:w-auto truncate max-w-[200px]">
                  claude "add auth system"
              </code>
              
              <p className="text-zinc-500 text-sm">
                  Agent runs for hours
              </p>

              {/* Mobile Arrow */}
              <ArrowRight className="md:hidden w-6 h-6 text-zinc-700 my-4" />
            </div>

            <div className="flex flex-col items-center text-center group">
              <div className="w-24 h-24 rounded-2xl bg-black border border-zinc-800 flex items-center justify-center mb-6 shadow-xl group-hover:border-green-500/50 group-hover:shadow-green-500/10 transition-all duration-300 relative">
                  <Smartphone className="w-10 h-10 text-zinc-400 group-hover:text-green-400 transition-colors" />
                  <div className="absolute -bottom-3 bg-zinc-900 px-3 py-1 rounded-full text-xs font-bold border border-zinc-800 text-zinc-300">
                      MONITOR
                  </div>
              </div>
              
              <code className="bg-black/50 px-3 py-1 rounded text-sm font-mono text-green-400/80 mb-2 border border-white/5 w-full md:w-auto truncate max-w-[200px]">
                  View live event timeline
              </code>
              
              <p className="text-zinc-500 text-sm">
                  See correlated events while agents run
              </p>

              {/* Mobile Arrow */}
              <ArrowRight className="md:hidden w-6 h-6 text-zinc-700 my-4" />
            </div>

            <div className="flex flex-col items-center text-center group">
              <div className="w-24 h-24 rounded-2xl bg-black border border-zinc-800 flex items-center justify-center mb-6 shadow-xl group-hover:border-green-500/50 group-hover:shadow-green-500/10 transition-all duration-300 relative">
                  <GitMerge className="w-10 h-10 text-zinc-400 group-hover:text-green-400 transition-colors" />
                  <div className="absolute -bottom-3 bg-zinc-900 px-3 py-1 rounded-full text-xs font-bold border border-zinc-800 text-zinc-300">
                      SHIP
                  </div>
              </div>
              
              <code className="bg-black/50 px-3 py-1 rounded text-sm font-mono text-green-400/80 mb-2 border border-white/5 w-full md:w-auto truncate max-w-[200px]">
                  gssh switch feature-x
              </code>
              
              <p className="text-zinc-500 text-sm">
                  Instant context switch
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
