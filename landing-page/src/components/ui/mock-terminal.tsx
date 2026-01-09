import { Terminal as TerminalIcon, Wifi, Battery, Command } from "lucide-react";
import { cn } from "../../lib/utils";
import { motion } from "motion/react";

interface MockTerminalProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
  status?: string;
}

export function MockTerminal({ title = "gitspace.sh", children, className, status }: MockTerminalProps) {
  return (
    <div className={cn("rounded-lg border border-white/10 bg-black/90 shadow-2xl overflow-hidden font-mono text-sm", className)}>
      {/* Title Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/5">
        <div className="flex items-center gap-2">
           <div className="flex gap-1.5">
             <div className="w-3 h-3 rounded-full bg-red-500/50" />
             <div className="w-3 h-3 rounded-full bg-amber-500/50" />
             <div className="w-3 h-3 rounded-full bg-green-500/50" />
           </div>
        </div>
        <div className="absolute left-1/2 -translate-x-1/2 text-xs text-muted-foreground font-medium flex items-center gap-1.5">
           <TerminalIcon className="w-3 h-3" />
           {title}
        </div>
        <div className="w-10" /> {/* Spacer */}
      </div>

      {/* Content */}
      <div className="p-4 min-h-[200px] text-gray-300 space-y-2">
        {children}
      </div>

      {/* Status Bar (optional) */}
      {status && (
        <div className="px-4 py-1.5 bg-green-500/10 border-t border-green-500/20 text-green-400 text-xs flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            {status}
          </span>
          <span className="opacity-70">via iPhone 15 Pro</span>
        </div>
      )}
    </div>
  );
}

export function TerminalLine({ children, prefix = "$" }: { children: React.ReactNode, prefix?: string }) {
  return (
    <div className="flex gap-3">
      <span className="text-green-500 shrink-0 select-none">{prefix}</span>
      <span>{children}</span>
    </div>
  );
}

export function AIZwResponse({ children }: { children: React.ReactNode }) {
  return (
    <div className="pl-4 border-l-2 border-white/10 my-2 py-1 ml-1">
      <div className="text-muted-foreground">{children}</div>
    </div>
  );
}
