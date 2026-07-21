import { Button } from "../../app/components/ui/button";
import { ArrowRight, BookOpen, Github } from "lucide-react";

export function CTA() {
  return (
    <section className="py-24 bg-black relative overflow-hidden">
      <div className="container px-4 mx-auto relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 items-center max-w-5xl mx-auto">
            <div>
                <h2 className="text-3xl md:text-5xl font-bold mb-6">Ready to run a fleet?</h2>
                <p className="text-xl text-zinc-400 mb-8">
                    Stop babysitting agents. Keep your fleet green.
                </p>
                <div className="flex flex-col sm:flex-row gap-4">
                    <Button asChild size="lg" className="rounded-none bg-white text-black hover:bg-gray-200 h-12 px-8 w-full sm:w-auto">
                        <a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer">
                            <Github className="w-5 h-5 mr-2" />
                            Star on GitHub
                        </a>
                    </Button>
                    <Button asChild variant="outline" size="lg" className="rounded-none h-12 px-8 border-zinc-700 hover:bg-zinc-800 w-full sm:w-auto">
                        <a href="/docs">
                            Read the Docs <BookOpen className="ml-2 w-4 h-4" />
                        </a>
                    </Button>
                </div>
            </div>

            <div>
                <div className="border border-[#1a1a1a] bg-[#050505] p-5 overflow-x-auto">
                    <div className="space-y-2 font-mono text-sm">
                        <div className="flex">
                            <span className="text-green-500 mr-2">$</span>
                            <span className="text-white">npm install -g gitspace</span>
                        </div>
                        <div className="text-zinc-500 text-xs py-1">...</div>
                        <div className="flex">
                            <span className="text-green-500 mr-2">$</span>
                            <span className="text-white">gssh project add</span>
                        </div>
                        <div className="flex">
                            <span className="text-green-500 mr-2">$</span>
                            <span className="text-white">gssh workspace add feature-x --project my-project</span>
                        </div>
                        <br />
                        <div className="text-green-400 font-bold"># You're ready.</div>
                    </div>
                </div>
            </div>
        </div>
      </div>
    </section>
  );
}
