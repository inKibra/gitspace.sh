import { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { DocsSidebar } from "../components/docs/DocsSidebar";
import { DocsContent } from "../components/docs/DocsContent";
import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Footer } from "../components/layout/Footer";
import { Menu, X } from "lucide-react";
import { Button } from "../app/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "../app/components/ui/sheet";

export default function DocsPage() {
  const location = useLocation();
  const [activeSection, setActiveSection] = useState("getting-started");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const section = params.get("section");
    if (section) {
      setActiveSection(section);
    }
  }, [location]);

  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30 flex flex-col">
      <LandingNavbar />
      
      <div className="flex-1 container mx-auto flex overflow-hidden">
        {/* Desktop Sidebar */}
        <DocsSidebar 
            activeSection={activeSection} 
            onSectionChange={setActiveSection}
            className="border-r border-zinc-800"
        />

        {/* Mobile Menu Trigger - Visible only on small screens */}
        <div className="lg:hidden fixed bottom-6 right-6 z-50">
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
                <SheetTrigger asChild>
                    <Button size="icon" className="h-12 w-12 rounded-full bg-green-500 hover:bg-green-600 text-black shadow-lg shadow-green-900/20">
                        <Menu className="h-6 w-6" />
                    </Button>
                </SheetTrigger>
                <SheetContent side="left" className="bg-black border-r border-zinc-800 p-0 w-80">
                    <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                        <span className="font-bold">Documentation</span>
                        {/* Close button is handled by Sheet automatically usually, but we can customize */}
                    </div>
                    <DocsSidebar 
                        activeSection={activeSection} 
                        onSectionChange={(section) => {
                            setActiveSection(section);
                            setMobileMenuOpen(false);
                        }}
                        className="w-full border-none"
                    />
                </SheetContent>
            </Sheet>
        </div>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto h-[calc(100vh-3.5rem)]">
          <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 md:py-16">
            <DocsContent section={activeSection} />
            
            {/* Simple footer within docs for "Next" navigation could go here */}
            <div className="mt-20 pt-8 border-t border-zinc-800 flex justify-between text-sm text-zinc-500">
               <a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer" className="hover:text-green-500 transition-colors">Improve these docs on GitHub</a>
            </div>
          </div>
          <div className="lg:hidden">
              <Footer />
          </div>
        </main>
      </div>
    </div>
  );
}