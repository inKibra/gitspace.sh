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
import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { useLocation } from "react-router-dom";

/** Published posts are imported statically — they ship, so there is nothing to hide. */
const PUBLISHED_POSTS: Record<string, ComponentType> = {
  "babysitting-agents-sucks": BlogPost,
};

/**
 * Draft posts, dev-only.
 *
 * This MUST stay a dynamic import behind an `import.meta.env.DEV` guard, and
 * drafts must never be imported at the top of this file. Vite replaces DEV with
 * the literal `false` in a production build, so Rollup treats this whole branch
 * as dead code and drops the chunks entirely.
 *
 * Filtering routes at runtime is NOT sufficient: a statically imported draft is
 * still inside the bundle, and anyone can read unpublished prose out of the JS
 * with devtools. Hiding the route only hides the door, not the room.
 */
const DRAFT_POSTS: Record<string, ComponentType> = import.meta.env.DEV
  ? {
      "evidence-not-vibes": lazy(() => import("../episodes/02-evidence-not-vibes/index")),
      "the-change-guide": lazy(() => import("../episodes/03-the-change-guide/index")),
      "shipped-isnt-done": lazy(() => import("../episodes/07-shipped-isnt-done/index")),
    }
  : {};

const POST_COMPONENTS: Record<string, ComponentType> = { ...PUBLISHED_POSTS, ...DRAFT_POSTS };

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
      {/* Suspense covers the lazily-loaded draft posts in dev; in production
          every mounted route is statically imported and never suspends. */}
      <Suspense fallback={null}>
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
      </Suspense>
    </BrowserRouter>
  );
}