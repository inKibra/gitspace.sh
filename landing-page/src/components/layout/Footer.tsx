import { Terminal } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-[#1a1a1a] bg-black py-12 text-sm">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
          <div className="space-y-4">
            <div className="flex items-center gap-2 font-semibold text-lg tracking-tight">
              <Terminal className="h-5 w-5 text-green-500" />
              <span>gitspace.sh</span>
            </div>
          </div>
          
          <div className="space-y-4">
            <h4 className="font-mono text-xs uppercase tracking-[0.18em] text-zinc-500">Product</h4>
            <ul className="space-y-2 text-muted-foreground">
              <li><a href="/#features" className="hover:text-foreground">Features</a></li>
              <li><a href="/#pricing" className="hover:text-foreground">Pricing</a></li>
              <li><a href="/docs?section=security-notes" className="hover:text-foreground">Security</a></li>
              <li><a href="/#workflow" className="hover:text-foreground">Workflow</a></li>
            </ul>
          </div>

          <div className="space-y-4">
            <h4 className="font-mono text-xs uppercase tracking-[0.18em] text-zinc-500">Resources</h4>
            <ul className="space-y-2 text-muted-foreground">
              <li><a href="/docs" className="hover:text-foreground">Docs</a></li>
              <li><a href="/agent-rubric" className="hover:text-foreground">Agent Rubric</a></li>
              <li><a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">GitHub</a></li>
              <li><a href="https://discord.gg/kHRWYPnR" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Discord</a></li>
            </ul>
          </div>

          <div className="space-y-4">
            <h4 className="font-mono text-xs uppercase tracking-[0.18em] text-zinc-500">Company</h4>
            <ul className="space-y-2 text-muted-foreground">
              <li><a href="https://www.inkibra.com/ink" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">About</a></li>
              <li><a href="/notes" className="hover:text-foreground">Notes</a></li>
            </ul>
          </div>
        </div>
        
        <div className="pt-8 border-t border-[#1a1a1a] flex flex-col md:flex-row justify-between items-center gap-4 text-muted-foreground">
          <p>© 2026 inkibra, Inc.</p>
          <div className="flex gap-6">
            <a href="https://www.inkibra.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Privacy</a>
            <a href="https://www.inkibra.com/legal/terms-of-service" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Terms</a>
            <a href="/docs?section=security-notes" className="hover:text-foreground">Security</a>
          </div>
        </div>
      </div>
    </footer>
  );
}