import { Link } from "react-router-dom";
import { Terminal } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-black py-12 text-sm">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
          <div className="space-y-4">
            <div className="flex items-center gap-2 font-semibold text-lg tracking-tight">
              <Terminal className="h-5 w-5 text-green-500" />
              <span>gitspace.sh</span>
            </div>
          </div>
          
          <div className="space-y-4">
            <h4 className="font-semibold">Product</h4>
            <ul className="space-y-2 text-muted-foreground">
              <li><Link to="/#features" className="hover:text-foreground">Features</Link></li>
              <li><Link to="/#pricing" className="hover:text-foreground">Pricing</Link></li>
              <li><Link to="/docs?section=security-notes" className="hover:text-foreground">Security</Link></li>
              <li><Link to="/#workflow" className="hover:text-foreground">Workflow</Link></li>
            </ul>
          </div>

          <div className="space-y-4">
            <h4 className="font-semibold">Resources</h4>
            <ul className="space-y-2 text-muted-foreground">
              <li><Link to="/docs" className="hover:text-foreground">Docs</Link></li>
              <li><a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">GitHub</a></li>
              <li><a href="https://discord.gg/kHRWYPnR" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Discord</a></li>
            </ul>
          </div>

          <div className="space-y-4">
            <h4 className="font-semibold">Company</h4>
            <ul className="space-y-2 text-muted-foreground">
              <li><a href="https://www.inkibra.com/ink" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">About</a></li>
              <li><a href="https://www.inkibra.com/ink/blog" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Blog</a></li>
            </ul>
          </div>
        </div>
        
        <div className="pt-8 border-t border-white/10 flex flex-col md:flex-row justify-between items-center gap-4 text-muted-foreground">
          <p>© 2026 inkibra, Inc.</p>
          <div className="flex gap-6">
            <a href="https://www.inkibra.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Privacy</a>
            <a href="https://www.inkibra.com/legal/terms-of-service" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Terms</a>
            <Link to="/docs?section=security-notes" className="hover:text-foreground">Security</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}