import { DashboardNavbar } from "../components/layout/DashboardNavbar";
import { Card, CardHeader, CardTitle, CardContent } from "../app/components/ui/card";
import { Button } from "../app/components/ui/button";
import { Plus, CheckCircle2, XCircle, AlertTriangle, Terminal, Bell } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "../app/components/ui/badge";

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <DashboardNavbar />
      
      <main className="container mx-auto px-4 py-8 space-y-8">
        
        {/* Machines Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Terminal className="w-5 h-5 text-muted-foreground" />
              Machines
            </h2>
          </div>
          
          <Card className="bg-white/5 border-white/10">
            <CardContent className="p-0 divide-y divide-white/5">
              
              {/* Machine 1 */}
              <div className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors group">
                <div className="flex items-start gap-4">
                  <div className="mt-1 h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                  <div>
                    <div className="font-mono font-medium text-lg text-green-400 group-hover:underline cursor-pointer">
                      <Link to="/terminal">brad-macbook</Link>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1 flex items-center gap-3">
                       <span>3 sessions</span>
                       <span className="w-1 h-1 rounded-full bg-white/20" />
                       <span>Connected 2m ago</span>
                    </div>
                  </div>
                </div>
                <div className="text-sm font-mono text-muted-foreground">
                  <span className="px-2 py-1 rounded bg-white/5 border border-white/10">v1.2.4</span>
                </div>
              </div>

              {/* Machine 2 */}
              <div className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors opacity-60">
                <div className="flex items-start gap-4">
                  <div className="mt-1 h-2 w-2 rounded-full bg-red-500" />
                  <div>
                    <div className="font-mono font-medium text-lg text-gray-400">work-laptop</div>
                    <div className="text-sm text-muted-foreground mt-1">
                       Last seen 3 days ago
                    </div>
                  </div>
                </div>
                <div className="text-sm font-mono text-muted-foreground">
                   Offline
                </div>
              </div>

              {/* Add New */}
              <div className="p-3 bg-white/[0.02] hover:bg-white/5 transition-colors cursor-pointer text-center">
                <Button variant="ghost" className="text-muted-foreground hover:text-white w-full h-auto py-2">
                  <Plus className="w-4 h-4 mr-2" /> Link New Machine
                </Button>
              </div>

            </CardContent>
          </Card>
        </section>

        {/* Inbox Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Bell className="w-5 h-5 text-muted-foreground" />
              Recent Inbox
            </h2>
          </div>

          <Card className="bg-white/5 border-white/10">
             <CardContent className="p-0 divide-y divide-white/5">
                
                {/* Item 1 */}
                <div className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors">
                  <div className="flex items-center gap-4">
                     <CheckCircle2 className="w-5 h-5 text-green-500" />
                     <div>
                       <div className="font-medium text-gray-200">feature-auth: Claude finished</div>
                       <div className="text-sm text-muted-foreground font-mono mt-0.5">exit 0</div>
                     </div>
                  </div>
                  <span className="text-sm text-muted-foreground">5m ago</span>
                </div>

                {/* Item 2 */}
                <div className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors">
                  <div className="flex items-center gap-4">
                     <XCircle className="w-5 h-5 text-red-500" />
                     <div>
                       <div className="font-medium text-gray-200">api-refactor: npm test failed</div>
                       <div className="text-sm text-muted-foreground font-mono mt-0.5">exit 1</div>
                     </div>
                  </div>
                  <span className="text-sm text-muted-foreground">20m ago</span>
                </div>

                {/* Item 3 */}
                 <div className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors">
                  <div className="flex items-center gap-4">
                     <AlertTriangle className="w-5 h-5 text-amber-500" />
                     <div>
                       <div className="font-medium text-gray-200">main: Process went idle</div>
                       <div className="text-sm text-muted-foreground font-mono mt-0.5">Waiting for input</div>
                     </div>
                  </div>
                  <span className="text-sm text-muted-foreground">1h ago</span>
                </div>
                
                <div className="p-3 bg-white/[0.02] hover:bg-white/5 transition-colors cursor-pointer text-center">
                   <span className="text-sm text-muted-foreground hover:text-white transition-colors">View All →</span>
                </div>

             </CardContent>
          </Card>
        </section>

      </main>
    </div>
  );
}
