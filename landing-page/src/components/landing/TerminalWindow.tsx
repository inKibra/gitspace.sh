import React from 'react';
import { cn } from "../../lib/utils";

interface TerminalWindowProps {
  children: React.ReactNode;
  title?: string;
  className?: string;
}

export function TerminalWindow({ children, title = "bash", className }: TerminalWindowProps) {
  return (
    <div className={cn("rounded-lg overflow-hidden border border-zinc-800 bg-black/90 font-mono shadow-2xl", className)}>
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/50 border-b border-zinc-800">
        <div className="flex space-x-2">
          <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50" />
          <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50" />
        </div>
        <div className="text-xs text-zinc-500 font-medium">{title}</div>
        <div className="w-16" /> {/* Spacer for centering */}
      </div>
      <div className="p-4 text-sm md:text-base text-zinc-300 overflow-x-auto">
        {children}
      </div>
    </div>
  );
}
