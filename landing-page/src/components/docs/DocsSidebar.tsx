import { cn } from "../../lib/utils";
import { Button } from "../../app/components/ui/button";
import { ScrollArea } from "../../app/components/ui/scroll-area";
import { ChevronRight, Terminal, Book, Server, Layers, Settings, Shield, Zap, Globe, Key, Users, FileCode, HelpCircle, Link, Activity } from "lucide-react";

interface DocsSidebarProps extends React.HTMLAttributes<HTMLDivElement> {
  activeSection: string;
  onSectionChange: (section: string) => void;
}

export function DocsSidebar({ className, activeSection, onSectionChange }: DocsSidebarProps) {
  const sections = [
    {
      title: "Getting Started",
      items: [
        { id: "overview", label: "Overview", icon: Book },
        { id: "quick-start", label: "Quick Start", icon: Zap },
        { id: "installation", label: "Installation", icon: Terminal },
      ]
    },
    {
      title: "Local Workflow",
      items: [
        { id: "tui-interface", label: "TUI Interface", icon: Layers },
        { id: "cli-commands", label: "CLI Commands", icon: Terminal },
        { id: "custom-scripts", label: "Custom Scripts", icon: FileCode },
        { id: "repo-bundles", label: "Repo Config Bundles", icon: FileCode },
      ]
    },
    {
      title: "Remote Access",
      items: [
        { id: "gitspace-managed", label: "gitspace.sh (Managed)", icon: Globe },
        { id: "process-hosting", label: "Process Hosting", icon: Globe },
        { id: "self-hosted-relay", label: "Self-Hosted Relay", icon: Server },
        { id: "identity-management", label: "Identity Management", icon: Key },
        { id: "access-control", label: "Access Control", icon: Users },
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
        { id: "wide-events", label: "Wide Events", icon: Activity },
        { id: "configuration", label: "Configuration", icon: Settings },
        { id: "troubleshooting", label: "Troubleshooting", icon: HelpCircle },
        { id: "security", label: "Security", icon: Shield },
        { id: "glossary", label: "Glossary", icon: Book },
      ]
    }
  ];

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
                {section.items.map((item) => (
                  <Button
                    key={item.id}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "w-full justify-start font-normal h-8",
                      activeSection === item.id 
                        ? "bg-zinc-800 text-white font-medium" 
                        : "text-zinc-400 hover:text-white hover:bg-zinc-900"
                    )}
                    onClick={() => onSectionChange(item.id)}
                  >
                    <item.icon className="mr-2 h-4 w-4" />
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
