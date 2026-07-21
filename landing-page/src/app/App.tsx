import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import LandingPage from "../pages/LandingPage";
import Dashboard from "../pages/Dashboard";
import TerminalView from "../pages/TerminalView";
import DocsPage from "../pages/DocsPage";
import BlogPost from "../episodes/01-babysitting-agents-sucks/index";
import BlogIndex from "../pages/BlogIndex";
import AgentRubricPage from "../pages/AgentRubricPage";
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
        <Route path="/blog" element={<BlogIndex />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/agent-rubric" element={<AgentRubricPage />} />
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/terminal" element={<TerminalView />} />
        {/* Mock catch-all for terminal paths */}
        <Route path="/t/:machine/:session" element={<TerminalView />} />
      </Routes>
    </BrowserRouter>
  );
}