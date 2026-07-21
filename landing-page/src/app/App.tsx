import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import LandingPage from "../pages/LandingPage";
import Dashboard from "../pages/Dashboard";
import TerminalView from "../pages/TerminalView";
import DocsPage from "../pages/DocsPage";
import BlogPost from "../episodes/01-babysitting-agents-sucks/index";
import Episode02 from "../episodes/02-evidence-not-vibes/index";
import Episode03 from "../episodes/03-the-change-guide/index";
import Episode04 from "../episodes/04-the-workflow-and-the-goal/index";
import Episode05 from "../episodes/05-the-agent-change/index";
import Episode06 from "../episodes/06-goals-ship-in-order/index";
import Episode07 from "../episodes/07-shipped-isnt-done/index";
import BlogIndex from "../pages/BlogIndex";
import AgentRubricPage from "../pages/AgentRubricPage";
import EnterprisePage from "../pages/EnterprisePage";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// Scroll to hash on navigation
function ScrollToHash() {
  const { hash, pathname } = useLocation();

  useEffect(() => {
    if (hash) {
      const element = document.getElementById(hash.replace('#', ''));
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
      }
    } else {
      window.scrollTo(0, 0);
    }
  }, [hash, pathname]);

  return null;
}

// Placeholder for login page
function Login() {
  // Simulate login
  return <Navigate to="/dashboard" replace />;
}

export default function App() {
  // Add dark mode class to html element
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  return (
    <BrowserRouter>
      <ScrollToHash />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/blog/babysitting-agents-sucks" element={<BlogPost />} />
        <Route path="/blog/evidence-not-vibes" element={<Episode02 />} />
        <Route path="/blog/the-change-guide" element={<Episode03 />} />
        <Route path="/blog/the-workflow-and-the-goal" element={<Episode04 />} />
        <Route path="/blog/the-agent-change" element={<Episode05 />} />
        <Route path="/blog/goals-ship-in-order" element={<Episode06 />} />
        <Route path="/blog/shipped-isnt-done" element={<Episode07 />} />
        <Route path="/blog" element={<BlogIndex />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/agent-rubric" element={<AgentRubricPage />} />
        <Route path="/enterprise" element={<EnterprisePage />} />
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/terminal" element={<TerminalView />} />
        {/* Mock catch-all for terminal paths */}
        <Route path="/t/:machine/:session" element={<TerminalView />} />
      </Routes>
    </BrowserRouter>
  );
}