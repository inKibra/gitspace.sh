import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Footer } from "../components/layout/Footer";
import { ArrowRight } from "lucide-react";

/**
 * Rendered for any route the app does not know.
 *
 * The matching HTTP status comes from dist/404.html, which Cloudflare Pages
 * serves with a real 404 for unmatched paths. Both halves are needed: this one
 * handles client-side navigation, that one handles a cold request.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30 flex flex-col">
      <LandingNavbar />

      <main className="flex-1 container mx-auto px-4 py-28 max-w-3xl">
        <div className="font-mono text-[13px] text-green-500/80 uppercase tracking-widest mb-5">
          404 · no such page
        </div>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05] mb-6">
          That page isn’t here.
        </h1>
        <p className="text-lg text-zinc-400 mb-10 max-w-xl">
          It may have moved, or it may never have existed. Either way, the fleet is still running.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { href: "/", label: "Home", sub: "What gitspace is" },
            { href: "/notes", label: "Notes", sub: "Essays with working demos" },
            { href: "/docs", label: "Docs", sub: "Install and get running" },
          ].map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="group border border-zinc-800 bg-zinc-950 p-5 hover:border-zinc-600 transition-colors"
            >
              <div className="flex items-center gap-2 font-semibold mb-1">
                {l.label}
                <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity text-green-400" />
              </div>
              <div className="text-sm text-zinc-500">{l.sub}</div>
            </a>
          ))}
        </div>
      </main>

      <Footer />
    </div>
  );
}
