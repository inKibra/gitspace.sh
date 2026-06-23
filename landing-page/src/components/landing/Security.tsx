import { Lock, Github, Server, FileCode, ShieldCheck, Eye, ArrowRight } from "lucide-react";
import { Button } from "../../app/components/ui/button";

export function Security() {
  return (
    <section id="security" className="py-24 bg-black relative">
      <div className="container px-4 mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold mb-6">Open source. Self-hostable. <span className="text-green-500">Actually secure.</span></h2>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
            
            {/* Open Source Card */}
            <div className="bg-zinc-900/30 border border-zinc-800 rounded-2xl p-8 hover:border-zinc-700 transition-colors">
                <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center border border-blue-500/20 mb-6">
                    <Github className="w-6 h-6 text-blue-400" />
                </div>
                <h3 className="text-2xl font-bold mb-4">Fully Open Source</h3>
                <p className="text-zinc-400 mb-8 leading-relaxed">
                    The CLI, the relay, the protocol. All MIT licensed. 
                    Run it yourself or use our managed service. We have nothing to hide.
                </p>
                
                <div className="space-y-4">
                    <div className="flex items-start gap-3">
                        <Server className="w-5 h-5 text-zinc-500 mt-1" />
                        <div>
                            <h4 className="font-bold text-white">Self-Host Everything</h4>
                            <p className="text-sm text-zinc-500">Don't trust us? Don't have to. Run your own relay. Same security. Your infrastructure.</p>
                        </div>
                    </div>
                </div>

                <div className="mt-8 pt-8 border-t border-zinc-800">
                    <Button asChild variant="outline" className="text-blue-400 border-blue-500/20 hover:bg-blue-500/10 hover:text-blue-300 w-full justify-between group">
                        <a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer">
                            View on GitHub
                            <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </a>
                    </Button>
                </div>
            </div>

            {/* Security Card */}
            <div className="bg-zinc-900/30 border border-zinc-800 rounded-2xl p-8 hover:border-zinc-700 transition-colors">
                <div className="w-12 h-12 rounded-lg bg-green-500/10 flex items-center justify-center border border-green-500/20 mb-6">
                    <Lock className="w-6 h-6 text-green-400" />
                </div>
                <h3 className="text-2xl font-bold mb-4">End-to-End Encrypted</h3>
                <p className="text-zinc-400 mb-8 leading-relaxed">
                    Your encryption keys never leave your devices. We route bytes but can't read them. 
                    Even if our servers are compromised, your data is safe.
                </p>
                
                <div className="space-y-4">
                    <div className="flex items-start gap-3">
                        <Eye className="w-5 h-5 text-zinc-500 mt-1" />
                        <div>
                            <h4 className="font-bold text-white">Auditable Protocol</h4>
                            <p className="text-sm text-zinc-500">The crypto is standard. The protocol is documented. Third party audits coming.</p>
                        </div>
                    </div>
                </div>

                <div className="mt-8 pt-8 border-t border-zinc-800">
                    <Button asChild variant="outline" className="text-green-400 border-green-500/20 hover:bg-green-500/10 hover:text-green-300 w-full justify-between group">
                        <a href="/docs?section=security-notes">
                            Read Security Docs
                            <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </a>
                    </Button>
                </div>
            </div>

        </div>
      </div>
    </section>
  );
}