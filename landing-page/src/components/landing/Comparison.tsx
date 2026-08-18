import { SquareCheck, Square } from "lucide-react";

/** Product visual language: flat black, #1a1a1a hairlines, square corners. */
const C = {
  cell: "#050505",
  border: "#1a1a1a",
  borderMuted: "#111111",
  dim: "#6a6a6a",
  green: "#00ff66",
};

export function Comparison() {
  const sections = [
    {
      title: "WORKSPACES",
      items: [
        { text: "Git worktree management", checked: true },
        { text: "Instant branch switching", checked: true },
        { text: "Custom setup/select scripts", checked: true },
        { text: "Linear issue integration", checked: true },
        { text: "Interactive web UI", checked: true },
        { text: "Project templates", checked: true }
      ]
    },
    {
      title: "REMOTE ACCESS",
      items: [
        { text: "Access from any device", checked: true },
        { text: "End-to-end encryption", checked: true },
        { text: "Public subdomains on gitspace.sh", checked: true },
        { text: "Inbox tracks what you missed", checked: true },
        { text: "Self-host option", checked: true }
      ]
    },
    {
      title: "THE AGENT FLEET",
      items: [
        { text: "Agent sessions per workspace", checked: true },
        { text: "Fleet strip: running / idle / asked you", checked: true },
        { text: "Native ask forms for agent questions", checked: true },
        { text: "Goals & review rubrics", checked: true },
        { text: "Phase journal & change guides", checked: true }
      ]
    },
    {
      title: "INTEGRATIONS",
      items: [
        { text: "GitHub", checked: true },
        { text: "Linear", checked: true },
        { text: "Works with any AI agent", checked: true }
      ]
    }
  ];

  return (
    <section className="py-24 bg-black">
      <div className="container px-4 mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold mb-4">Everything you need</h2>
          <p className="text-zinc-400">Workspaces, remote access, and the agent fleet in one harness.</p>
        </div>

        <div
          className="grid md:grid-cols-2 lg:grid-cols-4 border-t border-l"
          style={{ borderColor: C.border }}
        >
          {sections.map((section, i) => (
            <div
              key={i}
              className="p-6 border-b border-r"
              style={{ background: C.cell, borderColor: C.border }}
            >
              <h3
                className="font-mono text-xs font-bold pb-3 mb-4 tracking-[0.18em]"
                style={{ color: C.dim, borderBottom: `1px solid ${C.borderMuted}` }}
              >
                {section.title}
              </h3>
              <ul className="space-y-3">
                {section.items.map((item, j) => (
                  <li key={j} className="flex items-start text-sm group">
                    {item.checked ? (
                      <SquareCheck className="w-4 h-4 mr-3 mt-0.5 shrink-0" style={{ color: C.green }} />
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
