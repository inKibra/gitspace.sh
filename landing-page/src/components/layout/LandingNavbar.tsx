import { Button } from "../../app/components/ui/button";
import { Terminal, Menu, X, Github } from "lucide-react";
import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";

export function LandingNavbar() {
  const [isOpen, setIsOpen] = useState(false);

  const navLinks = [
    { name: "Features", href: "/#features" },
    { name: "Pricing", href: "/#pricing" },
    { name: "Notes", href: "/notes" },
    { name: "Docs", href: "/docs" },
    { name: "Specs", href: "/specs" },
  ];

  return (
    <nav className="border-b border-[#1a1a1a] bg-black/50 backdrop-blur-md sticky top-0 z-50">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2 font-semibold text-lg tracking-tight z-50">
          <Terminal className="h-5 w-5 text-green-500" />
          <span>gitspace.sh</span>
        </a>
        
        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-6 text-sm font-mono text-muted-foreground">
          {navLinks.map((link) => (
            <a key={link.name} href={link.href} className="hover:text-foreground transition-colors">
              {link.name}
            </a>
          ))}
          <Button asChild size="sm" className="rounded-none bg-white text-black hover:bg-gray-200">
            <a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer">
              <Github className="w-4 h-4 mr-2" />
              Star on GitHub
            </a>
          </Button>
        </div>

        {/* Mobile Menu Toggle */}
        <button 
          className="md:hidden z-50 p-2 text-zinc-400 hover:text-white"
          onClick={() => setIsOpen(!isOpen)}
        >
          {isOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {/* Mobile Nav Overlay */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 md:hidden bg-black/95 backdrop-blur-xl pt-24 px-6 flex flex-col gap-8"
          >
            <div className="flex flex-col gap-6 text-xl font-mono text-zinc-400">
              {navLinks.map((link) => (
                <a
                  key={link.name}
                  href={link.href}
                  onClick={() => setIsOpen(false)}
                  className="hover:text-white transition-colors"
                >
                  {link.name}
                </a>
              ))}
            </div>
            
            <Button asChild size="lg" className="w-full rounded-none bg-white text-black hover:bg-gray-200 text-base py-6">
              <a href="https://github.com/inkibra/gitspace.sh" target="_blank" rel="noopener noreferrer" onClick={() => setIsOpen(false)} className="mt-auto mb-12">
                <Github className="w-5 h-5 mr-2" />
                Star on GitHub
              </a>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}