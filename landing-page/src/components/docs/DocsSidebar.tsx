import { cn } from "../../lib/utils";
import { Button } from "../../app/components/ui/button";
import { ScrollArea } from "../../app/components/ui/scroll-area";
import { ChevronRight, Terminal, Book, Server, Layers, Settings, Shield, Zap, Globe, Key, Users, FileCode, HelpCircle, Link } from "lucide-react";

interface DocsSidebarProps extends React.HTMLAttributes<HTMLDivElement> {
  activeSection: string;
  onSectionChange: (section: string) => void;
}

export function DocsSidebar({ className, activeSection, onSectionChange }: DocsSidebarProps) {
  const sections = [
    {
      title: "Start here",
      items: [
        { id: "getting-started", label: "Getting Started", icon: Zap },
      ]
    },
    {
      // The product is the web app. These five are the whole of normal use, and
      // deliberately mention the CLI only where a person genuinely has to type
      // something. CLI reference lives under Reference, below.
      title: "Using GitSpace",
      items: [
        { id: "the-board", label: "The Board", icon: Layers },
        { id: "workspaces-and-agents", label: "Workspaces and Agents", icon: Terminal },
        { id: "reviewing-changes", label: "Reviewing Changes", icon: FileCode },
        { id: "goals-and-chains", label: "Goals and Chains", icon: Link },
        { id: "artifacts-ops", label: "Artifacts and Operations", icon: Server },
      ]
    },
    {
      title: "Machines and Access",
      items: [
        { id: "machines-access", label: "Machines and Access", icon: Globe },
      ]
    },
    {
      title: "Integrations",
      items: [
        { id: "linear-integration", label: "Linear", icon: Link },
      ]
    },
    {
      title: "Reference",
      items: [
        { id: "cli-commands", label: "CLI Commands", icon: Terminal },
        { id: "custom-scripts", label: "Custom Scripts", icon: FileCode },
        { id: "repo-bundles", label: "Repo Config Bundles", icon: FileCode },
        { id: "configuration", label: "Configuration", icon: Settings },
        { id: "troubleshooting", label: "Troubleshooting", icon: HelpCircle },
        { id: "security", label: "Security", icon: Shield },
        { id: "glossary", label: "Glossary", icon: Book },
      ]
    },
    {
      // Design docs that are public on purpose but still moving. They are
      // separate routes rather than doc sections, and they are noindex'd and
      // kept out of the sitemap until promoted — see src/content/site.ts.
      // Promoting one means changing its status there and moving it up a group.
      title: "In development",
      items: [
        { id: "agent-rubric", label: "Agent Rubric", icon: Shield, href: "/agent-rubric" },
      ]
    }
  ] satisfies ReadonlyArray<{
    title: string;
    items: ReadonlyArray<{ id: string; label: string; icon: typeof Book; href?: string }>;
  }>;

  return (
    <div className={cn("pb-12 w-64 border-r border-zinc-800 bg-black hidden lg:block", className)}>
      <ScrollArea className="h-screen py-6 pl-4 pr-6">
        <div className="space-y-6">
          {sections.map((section, i) => (
            <div key={i} className="px-3 py-2">
              <h2 className="mb-2 px-4 text-xs font-semibold tracking-tight text-zinc-500 uppercase">
                {section.title}
              </h2>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const classes = cn(
                    "w-full justify-start font-normal h-8",
                    activeSection === item.id
                      ? "bg-zinc-800 text-white font-medium"
                      : "text-zinc-400 hover:text-white hover:bg-zinc-900"
                  );
                  // An item with an href is its own route, not a section of this
                  // page, so it navigates instead of swapping the content pane.
                  return item.href ? (
                    <Button key={item.id} asChild variant="ghost" size="sm" className={classes}>
                      <a href={item.href}>
                        <item.icon className="mr-2 h-4 w-4" />
                        {item.label}
                      </a>
                    </Button>
                  ) : (
                    <Button
                      key={item.id}
                      variant="ghost"
                      size="sm"
                      className={classes}
                      onClick={() => onSectionChange(item.id)}
                    >
                      <item.icon className="mr-2 h-4 w-4" />
                      {item.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}