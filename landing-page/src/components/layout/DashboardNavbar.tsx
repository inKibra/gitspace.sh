import { Link } from "react-router-dom";
import { Terminal, Bell, ChevronDown } from "lucide-react";
import { Button } from "../../app/components/ui/button";

export function DashboardNavbar() {
  return (
    <nav className="border-b border-white/10 bg-black">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <Link to="/dashboard" className="flex items-center gap-2 font-semibold text-lg tracking-tight">
          <Terminal className="h-5 w-5 text-green-500" />
          <span>gitspace.sh</span>
        </Link>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm font-medium hover:bg-white/5 px-2 py-1.5 rounded-md cursor-pointer transition-colors">
            <div className="h-6 w-6 rounded-full bg-green-500/20 flex items-center justify-center text-green-500 text-xs">B</div>
            <span>brad</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </div>
          
          <div className="h-8 w-[1px] bg-white/10" />
          
          <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground">
            <Bell className="h-5 w-5" />
            <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-red-500 border-2 border-black" />
          </Button>
          
          <Link to="/">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
              Logout
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}
