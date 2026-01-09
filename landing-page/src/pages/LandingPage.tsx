import { LandingNavbar } from "../components/layout/LandingNavbar";
import { Hero } from "../components/landing/Hero";
import { Features } from "../components/landing/Features";
import { Workflow } from "../components/landing/Workflow";
import { Comparison } from "../components/landing/Comparison";
import { Security } from "../components/landing/Security";
import { UseCases } from "../components/landing/UseCases";
import { Pricing } from "../components/landing/Pricing";
import { Roadmap } from "../components/landing/Roadmap";
import { CTA } from "../components/landing/CTA";
import { Footer } from "../components/layout/Footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-green-500/30">
      <LandingNavbar />
      <main>
        <Hero />
        <Features />
        <Workflow />
        <Comparison />
        <UseCases />
        <Security />
        <Roadmap />
        <Pricing />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}