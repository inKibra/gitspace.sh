import { Button } from "../../app/components/ui/button";
import { ArrowRight, Play, Check, Activity, Clock, Laptop, Smartphone, Github } from "lucide-react";
import { TerminalWindow } from "./TerminalWindow";
import { Badge } from "../../app/components/ui/badge";

export function Hero() {
  return (
    <section className="relative pt-32 pb-32 overflow-hidden px-4">
      
      <div className="pointer-events-none absolute inset-0 z-0 opacity-25">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(34,197,94,0.16),transparent_58%)]" />
        <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(34,197,94,0.16)_1px,transparent_1px),linear-gradient(90deg,rgba(34,197,94,0.16)_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.78)_72%,#000)]" />
      </div>

      <div className="container px-4 mx-auto text-center relative z-10">
        
        <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6 bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60">
          The developer environment<br />for the AI age.
        </h1>
        
        <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
          Parallel workspaces. Remote access. AI-assisted shipping.
        </p>
        
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-20">
          <Button asChild size="lg" className="bg-white text-black hover:bg-gray-200 h-12 px-8 text-base">
            <a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer">
              <Github className="w-5 h-5 mr-2" />
              Star on GitHub
            </a>
          </Button>
          <Button asChild variant="outline" size="lg" className="h-12 px-8 text-base border-white/10 hover:bg-white/5">
            <a href="/docs">
              Read the Docs <ArrowRight className="ml-2 w-4 h-4" />
            </a>
          </Button>
        </div>

        <div className="max-w-4xl mx-auto text-left relative group">
           <div className="absolute -inset-1 bg-gradient-to-b from-green-500/20 to-transparent blur-2xl opacity-50 rounded-[2rem] group-hover:opacity-75 transition duration-500" />
           
           <TerminalWindow title="gitspace" className="relative bg-black/90 backdrop-blur-xl">
              <div className="flex flex-col md:flex-row gap-8 p-2 font-mono text-sm md:text-base">
                
                {/* Left Column: Projects */}
                <div className="w-full md:w-1/3 border-r border-zinc-800 md:pr-4">
                  <div className="text-zinc-500 mb-2 uppercase text-xs tracking-wider">Projects</div>
                  <div className="h-px bg-zinc-800 mb-4" />
                  <ul className="space-y-2">
                    <li className="flex items-center text-green-400 font-bold bg-zinc-900/50 -mx-2 px-2 py-1 rounded">
                      <span className="mr-2">&gt;</span> gitspace
                    </li>
                    <li className="text-zinc-400 px-2">website</li>
                    <li className="text-zinc-400 px-2">relay-server</li>
                  </ul>
                </div>

                {/* Right Column: Workspaces */}
                <div className="w-full md:w-2/3">
                  <div className="text-zinc-500 mb-2 uppercase text-xs tracking-wider">Workspaces (gitspace)</div>
                  <div className="h-px bg-zinc-800 mb-4" />
                  
                  <ul className="space-y-3">
                    <li className="flex items-center justify-between group/item p-1 hover:bg-zinc-900/50 rounded cursor-pointer transition-colors">
                      <div className="flex items-center text-white">
                        <span className="text-green-500 mr-2">&gt;</span> feat-remote-acl
                      </div>
                      <div className="flex items-center text-xs text-zinc-500">
                         [main] *
                      </div>
                    </li>
                    
                    <li className="flex items-center justify-between group/item p-1 hover:bg-zinc-900/50 rounded cursor-pointer transition-colors">
                      <div className="flex items-center text-zinc-400">
                        <span className="w-3 mr-2"></span> fix-worktree-cleanup
                      </div>
                      <div className="flex items-center text-xs text-zinc-600">
                         [main]
                      </div>
                    </li>

                    <li className="flex items-center justify-between group/item p-1 hover:bg-zinc-900/50 rounded cursor-pointer transition-colors">
                      <div className="flex items-center text-zinc-400">
                        <span className="w-3 mr-2"></span> refactor-crypto
                      </div>
                      <div className="flex items-center text-xs text-zinc-600">
                         [dev-v2]
                      </div>
                    </li>
                  </ul>
                </div>

              </div>

              {/* Status Bar */}
              <div className="mt-8 pt-3 border-t border-zinc-800 text-xs text-zinc-500 flex flex-wrap gap-4">
                 <span><span className="text-zinc-300">[a]</span> add</span>
                 <span><span className="text-zinc-300">[s]</span> switch</span>
                 <span><span className="text-zinc-300">[r]</span> remove</span>
                 <span><span className="text-zinc-300">[i]</span> identity</span>
              </div>
           </TerminalWindow>

           {/* Device Labels */}
           <div className="flex justify-between mt-4 text-xs md:text-sm font-medium text-zinc-500 px-4">
              <div className="flex items-center gap-2">
                 <Laptop className="w-4 h-4" />
                 <span>On your Mac</span>
              </div>
              <div className="flex items-center gap-2 text-green-500/80 animate-pulse">
                 <Smartphone className="w-4 h-4" />
                 <span>Watching from phone</span>
              </div>
           </div>

        </div>
      </div>
      
      {/* Background Gradient */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[600px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-green-950/10 via-black/0 to-black/0 pointer-events-none" />
    </section>
  );
}