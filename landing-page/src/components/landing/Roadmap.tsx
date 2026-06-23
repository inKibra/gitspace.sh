import { Badge } from "../../app/components/ui/badge";
import { Terminal, Zap, Bug, PlayCircle } from "lucide-react";

export function Roadmap() {
  const plannedFeatures = [
    {
      title: "CI/CD via GitSpace",
      description: "Use a remote GitSpace as your CI/CD runner. If a build fails, you don't just get a log—you get a machine. SSH into the runner instantly to see exactly what happened and fix it in real-time.",
      icon: <Terminal className="w-5 h-5 text-green-500" />,
      tag: "Planned",
      status: "In Concept"
    },
    {
      title: "Dev & Preview Deploys",
      description: "Push a branch and see it running instantly as a GitSpace in a Firecracker VM. Only pay for what you use with sub-second startup times. Remote into the preview environment via GitSpace to debug live code.",
      icon: <Zap className="w-5 h-5 text-blue-500" />,
      tag: "Coming Soon",
      status: "In Development"
    }
  ];

  return (
    <section className="py-24 bg-zinc-950 border-y border-zinc-900">
      <div className="container px-4 mx-auto">
        <div className="max-w-4xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-mono mb-6">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            ROADMAP
          </div>
          
          <h2 className="text-3xl md:text-5xl font-bold mb-6">Building the future of dev-ops.</h2>
          <p className="text-xl text-zinc-400 mb-16 max-w-2xl leading-relaxed">
            GitSpace isn't just about local development. We're rethinking the entire lifecycle from commit to production.
          </p>

          <div className="grid md:grid-cols-2 gap-8">
            {plannedFeatures.map((feature, i) => (
              <div key={i} className="group p-8 rounded-2xl bg-black border border-zinc-800 hover:border-zinc-700 transition-all duration-300">
                <div className="flex items-start justify-between mb-6">
                  <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 group-hover:bg-zinc-800 transition-colors">
                    {feature.icon}
                  </div>
                  <Badge variant="outline" className="border-zinc-800 text-zinc-500 text-[10px] uppercase tracking-wider">
                    {feature.tag}
                  </Badge>
                </div>
                
                <h3 className="text-xl font-bold mb-3 group-hover:text-white transition-colors">
                  {feature.title}
                </h3>
                
                <p className="text-zinc-400 text-sm leading-relaxed mb-6">
                  {feature.description}
                </p>

                <div className="flex items-center gap-4 pt-4 border-t border-zinc-900">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                    STATUS: {feature.status}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-16 p-8 rounded-2xl bg-gradient-to-br from-green-500/5 to-transparent border border-green-500/10">
            <div className="flex flex-col md:flex-row items-center justify-between gap-8">
              <div>
                <h4 className="text-lg font-bold mb-2">Want to shape our roadmap?</h4>
                <p className="text-sm text-zinc-400">Join our Discord to suggest features and test new builds.</p>
              </div>
              <a
                href="https://discord.gg/kHRWYPnR"
                target="_blank"
                rel="noopener noreferrer"
                className="px-6 py-2.5 rounded-full bg-white text-black font-medium hover:bg-zinc-200 transition-colors shrink-0"
              >
                Join Discord
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}