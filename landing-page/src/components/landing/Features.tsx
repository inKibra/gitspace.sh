import { TerminalWindow } from "./TerminalWindow";
import { GitBranch, Globe, ArrowRight, Shield, Smartphone, Laptop } from "lucide-react";

export function Features() {
  return (
    <section id="features" className="py-24 bg-black relative">
      <div className="container px-4 mx-auto">
        <div className="text-center mb-20">
            <h2 className="text-3xl md:text-5xl font-bold mb-4">One tool. Two superpowers.</h2>
            <div className="h-1 w-20 bg-green-500 mx-auto rounded-full" />
        </div>

        <div className="space-y-32">
            
            {/* SPACES */}
            <div className="grid lg:grid-cols-2 gap-12 items-center">
                <div>
                    <div className="inline-flex items-center gap-2 text-green-400 font-mono text-sm mb-4">
                        <GitBranch className="w-5 h-5" />
                        <span>SPACES</span>
                    </div>
                    <h3 className="text-3xl md:text-4xl font-bold mb-6">Work on everything at once.</h3>
                    <p className="text-lg text-zinc-400 leading-relaxed mb-8">
                        Git worktrees let you have multiple branches checked out simultaneously. No more stashing. No more "let me finish this first." Jump between features instantly.
                    </p>
                    <ul className="space-y-3 text-zinc-300">
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-green-500 mr-3 shrink-0 mt-0.5" />
                            <span>Each workspace is a full git worktree</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-green-500 mr-3 shrink-0 mt-0.5" />
                            <span>Run different branches simultaneously</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-green-500 mr-3 shrink-0 mt-0.5" />
                            <span>Custom setup scripts per project</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-green-500 mr-3 shrink-0 mt-0.5" />
                            <span>Integrates with Linear issues</span>
                        </li>
                    </ul>
                </div>
                <div>
                    <TerminalWindow title="bash">
                        <div className="space-y-2 font-mono text-sm">
                            <div className="text-zinc-500"># Install</div>
                            <div className="text-zinc-400">$ npm install -g gitspace</div>
                            <br />
                            <div className="text-zinc-500"># Launch the TUI</div>
                            <div className="text-zinc-400">$ gssh</div>
                            <br />
                            <div className="text-zinc-500"># Or use commands</div>
                            <div className="text-zinc-400">$ gssh project add</div>
                            <div className="text-green-400">✓ Added project: my-api</div>
                            <div className="text-zinc-400">$ gssh workspace add feature-auth --project my-api</div>
                            <div className="text-green-400">✓ Created workspace: feature-auth</div>
                        </div>
                    </TerminalWindow>
                </div>
            </div>

            {/* REMOTE */}
            <div className="grid lg:grid-cols-2 gap-12 items-center lg:flex-row-reverse">
                 <div className="lg:order-2">
                    <div className="inline-flex items-center gap-2 text-blue-400 font-mono text-sm mb-4">
                        <Globe className="w-5 h-5" />
                        <span>REMOTE</span>
                    </div>
                    <h3 className="text-3xl md:text-4xl font-bold mb-6">Your terminal, from anywhere.</h3>
                    <p className="text-lg text-zinc-400 leading-relaxed mb-8">
                        Start an AI agent on a big task. Close your laptop. Check in from your phone. 
                        Get notified when it's done. End-to-end encrypted - we can't see your terminal.
                    </p>
                    <ul className="space-y-3 text-zinc-300">
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-blue-500 mr-3 shrink-0 mt-0.5" />
                            <span>Encrypted access from your phone or any device</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-blue-500 mr-3 shrink-0 mt-0.5" />
                            <div className="flex flex-col">
                                <span className="text-zinc-300">Public subdomains & port forwarding</span>
                                <span className="text-xs font-semibold text-blue-500 mt-1 uppercase tracking-wider">Coming Soon</span>
                            </div>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-blue-500 mr-3 shrink-0 mt-0.5" />
                            <span>End-to-end encrypted relay — we can't see your data</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-blue-500 mr-3 shrink-0 mt-0.5" />
                            <span>Owner-only access across devices recovered from your mnemonic</span>
                        </li>
                        <li className="flex items-start">
                            <ArrowRight className="w-5 h-5 text-blue-500 mr-3 shrink-0 mt-0.5" />
                            <span>Inbox tracks what happened while you were away</span>
                        </li>
                    </ul>
                </div>
                <div className="lg:order-1">
                    <TerminalWindow title="Connection Architecture">
                        <div className="flex justify-between items-center text-center text-xs md:text-sm p-4">
                            <div className="flex flex-col items-center gap-2">
                                <Laptop className="w-8 h-8 text-zinc-300" />
                                <span className="font-bold">Your Mac</span>
                                <span className="text-green-500 text-[10px] border border-green-500/30 px-1 rounded bg-green-500/10">Has Keys</span>
                            </div>
                            
                            <div className="flex-1 px-4 relative">
                                <div className="h-px bg-zinc-700 absolute top-1/2 left-0 right-0 -z-10" />
                                <div className="bg-black px-2 relative z-10 inline-block">
                                    <Shield className="w-5 h-5 text-green-500 mx-auto mb-1" />
                                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider block bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">End-to-End Encrypted</span>
                                </div>
                            </div>

                            <div className="flex flex-col items-center gap-2">
                                <Smartphone className="w-8 h-8 text-zinc-300" />
                                <span className="font-bold">Your Phone</span>
                                <span className="text-green-500 text-[10px] border border-green-500/30 px-1 rounded bg-green-500/10">Has Keys</span>
                            </div>
                        </div>
                        <div className="text-center mt-4 pt-4 border-t border-zinc-800">
                             <div className="text-zinc-500 text-xs mb-1">gitspace.sh Relay</div>
                             <div className="text-zinc-600 text-[10px] italic">Blind relay - cannot read data</div>
                        </div>
                    </TerminalWindow>
                </div>
            </div>

        </div>
      </div>
    </section>
  );
}
