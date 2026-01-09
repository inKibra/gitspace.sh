import { SquareCheck, Square } from "lucide-react";

export function Comparison() {
  const sections = [
    {
      title: "WORKSPACES",
      items: [
        { text: "Git worktree management", checked: true },
        { text: "Instant branch switching", checked: true },
        { text: "Custom setup/select scripts", checked: true },
        { text: "Linear issue integration", checked: true },
        { text: "Interactive TUI", checked: true },
        { text: "Project templates", checked: true }
      ]
    },
    {
      title: "REMOTE ACCESS",
      items: [
        { text: "Access from any device", checked: true },
        { text: "End-to-end encryption", checked: true },
        { text: "Session sharing (view/write)", checked: true },
        { text: "Inbox notifications", checked: true },
        { text: "Public subdomains (planned)", checked: false },
        { text: "Self-host option", checked: true }
      ]
    },
    {
      title: "GIT STACK (Coming)",
      items: [
        { text: "AI commit analysis", checked: false },
        { text: "Automatic PR splitting", checked: false },
        { text: "Dependency detection", checked: false },
        { text: "Stacked PR creation", checked: false },
        { text: "Interactive editing", checked: false },
        { text: "Explanation of reasoning", checked: false }
      ]
    },
    {
      title: "INTEGRATIONS",
      items: [
        { text: "GitHub", checked: true },
        { text: "Linear", checked: true },
        { text: "Works with any AI agent", checked: true },
        { text: "VS Code extension (planned)", checked: false },
        { text: "Slack notifications (planned)", checked: false }
      ]
    }
  ];

  return (
    <section className="py-24 bg-black">
      <div className="container px-4 mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold mb-4">Everything you need</h2>
          <p className="text-zinc-400">A complete platform, not just a tool.</p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {sections.map((section, i) => (
            <div key={i} className="space-y-6">
              <h3 className="font-mono text-sm font-bold text-zinc-500 border-b border-zinc-800 pb-2 mb-4 tracking-wider">
                {section.title}
              </h3>
              <ul className="space-y-3">
                {section.items.map((item, j) => (
                  <li key={j} className="flex items-start text-sm group">
                    {item.checked ? (
                      <SquareCheck className="w-4 h-4 text-green-500 mr-3 mt-0.5 shrink-0" />
                    ) : (
                      <Square className="w-4 h-4 text-zinc-700 mr-3 mt-0.5 shrink-0" />
                    )}
                    <span className={item.checked ? "text-zinc-300 group-hover:text-white transition-colors" : "text-zinc-600"}>
                      {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}