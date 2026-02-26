import { Quote, Star } from "lucide-react";
import { Card, CardContent } from "../../app/components/ui/card";

export function UseCases() {
  const testimonials = [
    {
      quote: "I run 3-4 Claude agents in parallel now. Each in its own space. I check progress from my phone while making dinner. Context switching between tasks is instant.",
      author: "Solo founder",
      role: "Shipping 3x faster",
      stars: 5
    },
    {
      quote: "We recover the same owner identity on phone and laptop. I can check long-running agents from anywhere without breaking encryption boundaries. Game changer for debugging.",
      author: "Tech lead",
      role: "8-person startup",
      stars: 5
    },
    {
      quote: "No more 'hold on, let me stash my changes.' I have 6 workspaces open right now. Context switching is instant.",
      author: "Senior engineer",
      role: "Enterprise",
      stars: 5
    }
  ];

  return (
    <section className="py-24 bg-zinc-900/20">
      <div className="container px-4 mx-auto">
        <h2 className="text-3xl md:text-5xl font-bold text-center mb-16">How developers use GitSpace</h2>
        
        <div className="grid md:grid-cols-3 gap-8">
          {testimonials.map((item, i) => (
            <Card key={i} className="bg-black/40 border-zinc-800 hover:border-zinc-700 transition-colors">
              <CardContent className="pt-6">
                <div className="flex gap-1 mb-4">
                  {[...Array(item.stars)].map((_, i) => (
                    <Star key={i} className="w-4 h-4 fill-green-500 text-green-500" />
                  ))}
                </div>
                <Quote className="w-8 h-8 text-zinc-700 mb-4" />
                <p className="text-zinc-300 leading-relaxed mb-6 italic">
                  "{item.quote}"
                </p>
                <div className="border-t border-zinc-800 pt-4">
                  <p className="font-bold text-white">{item.author}</p>
                  <p className="text-sm text-zinc-500">{item.role}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
