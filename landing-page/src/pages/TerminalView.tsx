import { DashboardNavbar } from "../components/layout/DashboardNavbar";
import { MockTerminal, TerminalLine, AIZwResponse } from "../components/ui/mock-terminal";
import { 
  Breadcrumb, 
  BreadcrumbItem, 
  BreadcrumbLink, 
  BreadcrumbList, 
  BreadcrumbSeparator, 
  BreadcrumbPage 
} from "../app/components/ui/breadcrumb";
import { Button } from "../app/components/ui/button";
import { Share, ExternalLink, MonitorOff } from "lucide-react";
import { Link } from "react-router-dom";

export default function TerminalView() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30 flex flex-col">
       {/* Simple header for terminal view - maybe different from dashboard */}
       <header className="border-b border-white/10 bg-black px-4 h-14 flex items-center justify-between">
          <Breadcrumb>
            <BreadcrumbList className="text-sm font-mono">
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/dashboard" className="hover:text-white transition-colors">gitspace.sh</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/dashboard" className="hover:text-white transition-colors">brad-macbook</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="text-white">feature-auth</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          
          <div className="flex items-center gap-2">
             <Button variant="outline" size="sm" className="h-8 border-white/10 hover:bg-white/5 gap-2">
                <Share className="w-3 h-3" /> Share
             </Button>
             <Button variant="outline" size="sm" className="h-8 border-white/10 hover:bg-white/5 gap-2 text-red-400 hover:text-red-300">
                <MonitorOff className="w-3 h-3" /> Detach
             </Button>
          </div>
       </header>

       <main className="flex-1 p-4 md:p-6 flex flex-col">
          <div className="flex-1 bg-black rounded-lg border border-white/10 overflow-hidden flex flex-col relative shadow-2xl">
             {/* Mock Terminal Content - Reusing the component but tailored styling */}
             <div className="bg-white/5 px-4 py-2 border-b border-white/5 flex items-center justify-between">
                 <div className="flex gap-1.5 opacity-50 hover:opacity-100 transition-opacity">
                    <div className="w-3 h-3 rounded-full bg-red-500" />
                    <div className="w-3 h-3 rounded-full bg-amber-500" />
                    <div className="w-3 h-3 rounded-full bg-green-500" />
                 </div>
                 <div className="text-xs font-mono text-muted-foreground">zsh — 80x24</div>
             </div>
             
             <div className="p-4 font-mono text-sm md:text-base space-y-4 text-gray-300 flex-1 overflow-auto">
                <TerminalLine prefix="$">claude "add unit tests for the auth module"</TerminalLine>
                
                <AIZwResponse>
                   <p className="mb-2">I'll add comprehensive unit tests for the authentication module. Let me first examine the existing code structure...</p>
                   <div className="space-y-1 text-xs md:text-sm text-muted-foreground/80">
                      <div>Reading src/auth/login.ts</div>
                      <div>Reading src/auth/session.ts</div>
                      <div>Reading src/auth/middleware.ts</div>
                   </div>
                </AIZwResponse>

                <div className="mt-8 max-w-md">
                   <div className="flex justify-between text-xs mb-1.5 text-muted-foreground">
                      <span>Generating tests...</span>
                      <span>30%</span>
                   </div>
                   <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 w-[30%] rounded-full animate-pulse" />
                   </div>
                </div>
                
                <div className="animate-pulse">█</div>
             </div>

             <div className="bg-white/5 px-4 py-1.5 border-t border-white/5 text-xs text-muted-foreground flex justify-between items-center">
                <span className="flex items-center gap-2">
                   <LockIcon className="w-3 h-3" /> End-to-end encrypted
                </span>
                <span>Shift+Esc: exit</span>
             </div>
          </div>
       </main>
    </div>
  );
}

function LockIcon({ className }: { className?: string }) {
   return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
         <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
         <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
   )
}
