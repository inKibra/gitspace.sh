import { Check, X, Github } from "lucide-react";
import { Button } from "../../app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter, CardDescription } from "../../app/components/ui/card";
import { Badge } from "../../app/components/ui/badge";

export function Pricing() {
  const plans = [
    {
      name: "Open Source Preview",
      price: "Free",
      period: "today",
      description: "The whole harness, self-hosted. Open code you can read and run.",
      features: [
        "Unlimited workspaces & agents",
        "The full lifecycle: plan, build, review, ship",
        "Self-hosted relay & remote access",
        "TUI, web UI & CLI",
        "Linear integration"
      ],
      cta: "Star on GitHub",
      variant: "default",
      popular: true,
      link: "https://github.com/inkibra/gitspace.sh"
    },
    {
      name: "Cloud",
      price: "$100",
      period: "/user/month",
      description: "Managed relay and your fleet at yourname.gitspace.sh.",
      features: [
        "Everything in Open Source Preview",
        "Hosted relay, zero setup",
        "Your gitspace.sh subdomain",
        "Unlimited machines",
        "Inbox history"
      ],
      cta: "Coming Soon",
      variant: "outline",
      disabled: true
    },
    {
      name: "Enterprise Rollout",
      price: "Contact Us",
      period: "",
      description: "inkibra stands up an agent factory and runs it for your team.",
      features: [
        "Everything in Cloud",
        "Agent factory standup for your codebase",
        "Private or on-prem deployment",
        "Prescribed delivery flow, tuned to your team",
        "Run by the team that builds GitSpace"
      ],
      cta: "Talk to inkibra",
      variant: "outline",
      link: "/enterprise"
    }
  ];

  return (
    <section id="pricing" className="py-24 bg-zinc-950">
      <div className="container px-4 mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold mb-4">Simple Pricing</h2>
          <p className="text-zinc-400">Run it yourself for free, today. Managed cloud is coming. Enterprise means we build it with you.</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan, i) => (
            <Card key={i} className={`relative rounded-none bg-[#080808] border-[#1a1a1a] hover:border-zinc-700 transition-all ${plan.popular ? 'border-green-500/50 shadow-green-900/20 shadow-2xl' : ''}`}>
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-green-500 text-black hover:bg-green-600 rounded-none">Available Now</Badge>
                </div>
              )}
              
              <CardHeader>
                <CardTitle className="text-xl text-zinc-300">{plan.name}</CardTitle>
                <div className="flex items-baseline mt-4">
                  <span className="text-4xl font-bold text-white">{plan.price}</span>
                  <span className="text-zinc-500 ml-2">{plan.period}</span>
                </div>
                <CardDescription className="mt-2 text-zinc-400">
                    {plan.description}
                </CardDescription>
              </CardHeader>
              
              <CardContent>
                <ul className="space-y-4">
                  {plan.features.map((feature, j) => (
                    <li key={j} className="flex items-start">
                      <Check className="w-5 h-5 text-green-500 mr-3 shrink-0" />
                      <span className="text-sm text-zinc-300">{feature}</span>
                    </li>
                  ))}
                  {plan.notIncluded?.map((feature, j) => (
                    <li key={j} className="flex items-start opacity-50">
                      <X className="w-5 h-5 text-zinc-600 mr-3 shrink-0" />
                      <span className="text-sm text-zinc-500">{feature}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
              
              <CardFooter className="flex flex-col gap-4">
                {plan.link ? (
                  <Button
                      asChild
                      variant={plan.variant as "default" | "outline"}
                      className={`w-full rounded-none ${plan.variant === 'default' ? 'bg-white text-black hover:bg-gray-200' : 'border-zinc-700 text-white hover:bg-zinc-800'}`}
                  >
                    <a href={plan.link} {...(plan.link.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                      {plan.name === "Local" && <Github className="w-4 h-4 mr-2" />}
                      {plan.cta}
                    </a>
                  </Button>
                ) : (
                  <Button 
                      variant={plan.variant as "default" | "outline"} 
                      className={`w-full rounded-none ${plan.variant === 'default' ? 'bg-white text-black hover:bg-gray-200' : 'border-zinc-700 text-white hover:bg-zinc-800'}`}
                      disabled={plan.disabled}
                  >
                    {plan.cta}
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>

        <div className="text-center mt-12 text-zinc-500 text-sm">
            Self-host the relay? The code is open. Run it on your infra.
        </div>
      </div>
    </section>
  );
}