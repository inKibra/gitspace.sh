import { BrowserRouter, Routes, Route } from "react-router-dom";
import LandingPage from "../pages/LandingPage";
import DocsPage from "../pages/DocsPage";
import BlogPost from "../episodes/01-babysitting-agents-sucks/index";
import NotesIndex from "../pages/NotesIndex";
import AgentRubricPage from "../pages/AgentRubricPage";
import EnterprisePage from "../pages/EnterprisePage";
import NotFound from "../pages/NotFound";
import SpecsIndex from "../pages/SpecsIndex";
import { POSTS } from "../content/posts";
import { useEffect, type ComponentType } from "react";
import { useLocation } from "react-router-dom";

/** Published posts are imported statically — they ship, so there is nothing to hide. */
const PUBLISHED_POSTS: Record<string, ComponentType> = {
  "babysitting-agents-sucks": BlogPost,
};

const POST_COMPONENTS: Record<string, ComponentType> = PUBLISHED_POSTS;

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
        {POSTS.filter((p) => import.meta.env.DEV || p.status === "published").map((p) => {
          const Component = POST_COMPONENTS[p.slug];
          return Component ? (
            <Route key={p.slug} path={`/notes/${p.slug}`} element={<Component />} />
          ) : null;
        })}
        <Route path="/notes" element={<NotesIndex />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/specs" element={<SpecsIndex />} />
        <Route path="/agent-rubric" element={<AgentRubricPage />} />
        <Route path="/enterprise" element={<EnterprisePage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}