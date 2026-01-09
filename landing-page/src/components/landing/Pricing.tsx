import { Check, X, Github } from "lucide-react";
import { Button } from "../../app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter, CardDescription } from "../../app/components/ui/card";
import { Badge } from "../../app/components/ui/badge";

export function Pricing() {
  const plans = [
    {
      name: "Local",
      price: "Free",
      period: "forever",
      description: "For individual developers working locally.",
      features: [
        "Unlimited workspaces",
        "TUI & CLI",
        "Setup scripts",
        "Linear integration",
        "Git Stack (when released)"
      ],
      notIncluded: [
        "Remote access"
      ],
      cta: "Star on GitHub",
      variant: "outline",
      link: "https://github.com/inkibra/gitspace.sh"
    },
    {
      name: "Pro",
      price: "$4.99",
      period: "/month",
      description: "Remote access and AI workflow superpowers.",
      features: [
        "Everything in Local",
        "Remote access",
        "Unlimited machines",
        "Session sharing",
        "90-day inbox history",
        "Priority support"
      ],
      cta: "Coming Soon",
      variant: "default",
      popular: true,
      disabled: true
    },
    {
      name: "Enterprise",
      price: "Contact Us",
      period: "",
      description: "For organizations with custom security and scale needs.",
      features: [
        "Everything in Pro",
        "Team sharing",
        "Shared inbox",
        "Audit logs",
        "SSO & SAML",
        "Dedicated support"
      ],
      cta: "Coming Soon",
      variant: "outline",
      disabled: true
    }
  ];

  return (
    <section id="pricing" className="py-24 bg-zinc-950">
      <div className="container px-4 mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold mb-4">Simple Pricing</h2>
          <p className="text-zinc-400">Local-only is always free. Pay for remote access.</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan, i) => (
            <Card key={i} className={`relative bg-zinc-900/50 border-zinc-800 hover:border-zinc-700 transition-all ${plan.popular ? 'border-green-500/50 shadow-green-900/20 shadow-2xl' : ''}`}>
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-green-500 text-black hover:bg-green-600">Most Popular</Badge>
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
                  <a href={plan.link} target="_blank" rel="noopener noreferrer" className="w-full">
                    <Button 
                        variant={plan.variant as "default" | "outline"} 
                        className={`w-full ${plan.variant === 'default' ? 'bg-white text-black hover:bg-gray-200' : 'border-zinc-700 text-white hover:bg-zinc-800'}`}
                    >
                      {plan.name === "Local" && <Github className="w-4 h-4 mr-2" />}
                      {plan.cta}
                    </Button>
                  </a>
                ) : (
                  <Button 
                      variant={plan.variant as "default" | "outline"} 
                      className={`w-full ${plan.variant === 'default' ? 'bg-white text-black hover:bg-gray-200' : 'border-zinc-700 text-white hover:bg-zinc-800'}`}
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
            Self-host the relay? It's open source. Run it on your infra.
        </div>
      </div>
    </section>
  );
}