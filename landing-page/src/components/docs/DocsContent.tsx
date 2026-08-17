import { Terminal, Copy, Check } from "lucide-react";
import { highlightBash, highlightJson } from "./highlight";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../../app/components/ui/badge";

/**
 * Copy control shared by both block types.
 *
 * The visible glyph is 14px, so the button is padded out to a 40x40 hit area —
 * below that it is genuinely hard to hit on a trackpad. It stays at low opacity
 * rather than hidden until hover, because a control that appears only on hover
 * is undiscoverable on touch.
 */
function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className="grid h-10 w-10 place-items-center text-zinc-500 hover:text-zinc-200 opacity-60 group-hover:opacity-100 active:scale-[0.96] transition-[color,opacity,scale] duration-150"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Terminal chrome: a label bar over a black body, matching the code style used in Notes. */
function Chrome({ label, code, children }: { label: string; code: string; children: React.ReactNode }) {
  return (
    <div className="group mt-4 mb-6 border border-[#1a1a1a] bg-[#0c0c0c]">
      <div className="flex items-center gap-2.5 border-b border-[#1a1a1a] px-3 py-1.5">
        <span className="h-2 w-2 bg-green-500" />
        <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-600">{label}</span>
        <span className="ml-auto -my-1.5 -mr-2">
          <CopyButton code={code} />
        </span>
      </div>
      <div className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function CodeBlock({ code, language = "bash", multiLine = false }: { code: string; language?: string; multiLine?: boolean }) {
  const lines = multiLine ? code.split("\n") : [code];
  const isShell = language === "bash";

  return (
    <Chrome label={isShell ? "terminal" : language} code={code}>
      {lines.map((line, i) => {
        const isComment = line.startsWith("#") || line.startsWith("//");
        // Blank lines separate stanzas; keep the height, drop the prompt.
        if (!line.trim()) return <div key={i}>&nbsp;</div>;
        return (
          <div key={i} className="flex">
            {isShell && !isComment && <span className="mr-2 select-none text-zinc-700">$</span>}
            <span className="min-w-0 whitespace-pre">{isShell ? highlightBash(line) : line}</span>
          </div>
        );
      })}
    </Chrome>
  );
}

function JsonBlock({ code }: { code: string }) {
  return (
    <Chrome label="json" code={code}>
      <pre className="text-zinc-300">{highlightJson(code)}</pre>
    </Chrome>
  );
}

export function DocsContent({ section }: { section: string }) {
  switch (section) {
    case "overview":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Overview</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">
            GitSpace is a CLI tool for managing GitHub repository workspaces using git worktrees, with optional secure remote terminal access.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Local Development</h3>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Work on multiple branches simultaneously without stashing</li>
            <li>Convention-based scripts for automation, read from <code className="text-zinc-300">.gitspace/scripts/</code> in the workspace</li>
            <li>Team onboarding via repo config bundles</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Two Surfaces</h3>
          <p className="text-zinc-400 mb-4">
            Everything is driven from the CLI. The interactive surface is the web app, not a terminal UI. Running <code className="text-zinc-300">gssh</code> with no arguments prints help.
          </p>
          <CodeBlock code={`gssh --help          # every command group
        gssh project list    # projects on this machine
        gssh web             # start the local relay + web stack`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4 mt-12">Remote Access</h3>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>E2E encrypted terminal access from a browser or the CLI</li>
            <li>The relay routes traffic but cannot decrypt content</li>
            <li>Identity-based auth using Ed25519 signing and X25519 key exchange keys</li>
            <li>Hosting on a gitspace.sh subdomain you reserve with <code className="text-zinc-300">gssh user host reserve</code></li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Command Groups</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400 mb-8">
              <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
                <tr>
                  <th className="px-4 py-3">Group</th>
                  <th className="px-4 py-3">What it covers</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh project</td>
                  <td className="px-4 py-3">Manage projects</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh workspace</td>
                  <td className="px-4 py-3">Manage workspaces within a project</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh machine</td>
                  <td className="px-4 py-3">Manage this machine as a remote-accessible host</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh invite</td>
                  <td className="px-4 py-3">Create and manage machine enrollment invites</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh client</td>
                  <td className="px-4 py-3">Connect to remote machines as a client</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh user</td>
                  <td className="px-4 py-3">User identity, authentication, and settings</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh cloud</td>
                  <td className="px-4 py-3">Cloud workspace management</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh relay</td>
                  <td className="px-4 py-3">Manage relay server and registered machines</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh artifacts</td>
                  <td className="px-4 py-3">Project artifacts repo (branch per workspace, roll-up to main)</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh status</td>
                  <td className="px-4 py-3">Show status of all gitspace daemons</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">gssh web</td>
                  <td className="px-4 py-3">Start the local relay + serve web stack on this machine</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      );

    case "quick-start":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Quick Start</h1>

          <h3 className="text-xl font-semibold text-white mb-4">5-Minute Setup with gitspace.sh</h3>
          <CodeBlock code={`# 1. Install (pick your package manager)
npm install -g gitspace
# or: bun install -g gitspace
# or: pnpm install -g gitspace

# 2. Create identity
gssh user identity init

# 3. Login to gitspace.sh
gssh user auth login

# 4. Reserve your subdomain
gssh user host reserve yourname

# 5. Start serving
gssh machine serve start --foreground

# 6. Access from browser: https://yourname.gitspace.sh`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4 mt-12">Local-Only Quick Start</h3>
          <CodeBlock code={`# Install
npm install -g gitspace

# Authenticate GitHub (needed for repo discovery)
gh auth login

# See what is available
gssh --help

gssh project add    # Add a GitHub repo
gssh workspace add my-feature --project my-project # Create a workspace`} multiLine />
        </div>
      );

    case "installation":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Installation</h1>

          <h3 className="text-xl font-semibold text-white mb-4">Prerequisites</h3>
          <p className="text-zinc-400 mb-4">Git is the only hard requirement. GitHub CLI is needed for the GitHub flows:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><a href="https://git-scm.com/" className="text-green-400 hover:underline">Git</a> - Version control</li>
            <li><a href="https://cli.github.com/" className="text-green-400 hover:underline">GitHub CLI</a> - needed to discover and clone GitHub repos; run <code className="text-zinc-300">gh auth login</code> first</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Install GitSpace</h3>
          <CodeBlock code={`# npm
npm install -g gitspace

# bun
bun install -g gitspace

# pnpm
pnpm install -g gitspace

# yarn
yarn global add gitspace`} multiLine />
          <CodeBlock code="gssh --version" />

          <h3 className="text-xl font-semibold text-white mb-4">Authenticate GitHub CLI</h3>
          <CodeBlock code="gh auth login" />
        </div>
      );

    case "web-app":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Web App</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">The web app is how you work with GitSpace. One command starts the relay and the machine daemon on this machine, then opens your browser already enrolled.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Start it</h3>
          <p className="text-zinc-400 mb-4">Run <code className="text-zinc-300">gssh web</code>. It starts a local relay, starts <code className="text-zinc-300">machine serve</code> against that relay, mints a one-time browser enrollment, and opens the URL for you.</p>
          <CodeBlock code={`gssh web`} multiLine />
          <p className="text-zinc-400 mb-8">The relay it starts listens on port <code className="text-zinc-300">4480</code> by default, bound to <code className="text-zinc-300">127.0.0.1</code>, and the browser opens at <code className="text-zinc-300">http://127.0.0.1:4480/?enroll=&lt;token&gt;</code>. The <code className="text-zinc-300">enroll</code> token is single use: it hands the browser a device identity signed by your user root identity, so you never paste a key by hand. If the browser cannot be opened, the URL is printed for you to open yourself.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Flags</h3>
          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Flag</th>
                <th className="px-4 py-3">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-4 py-3 font-mono text-green-400">--port &lt;port&gt;</td>
                <td className="px-4 py-3">Local relay/web port. Default <code className="text-zinc-300">4480</code>.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-green-400">--relay</td>
                <td className="px-4 py-3">Start a hosted relay with a cloudflared tunnel to your gitspace.sh subdomain.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-green-400">-y, --yes</td>
                <td className="px-4 py-3">Auto-confirm prompts.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-green-400">--takeover</td>
                <td className="px-4 py-3">Reclaim the local relay and serve daemons for the current identity: clear persisted owner/control state and forget any stale relay trust pin before starting. Use when recovering from mismatched ownership or trust pins.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-green-400">--password-stdin</td>
                <td className="px-4 py-3">Read the local device identity password from stdin and pass it through to machine serve.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-green-400">-h, --help</td>
                <td className="px-4 py-3">Show help.</td>
              </tr>
            </tbody>
          </table>

          <h3 className="text-xl font-semibold text-white mb-4">What you need first</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">gssh web</code> checks three things before it starts anything, and tells you which one is missing:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Built web UI assets. If they are missing, run <code className="text-zinc-300">bun run build:web</code>.</li>
            <li>A user root identity. Create one with <code className="text-zinc-300">gssh user identity init</code>, or restore one with <code className="text-zinc-300">gssh user identity recover</code>.</li>
            <li>A local device identity, plus its password. The password is prompted once up front and piped to the serve child, so you are not asked again halfway through startup. It is also unlocked up front, so a wrong password fails before anything else starts.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Local vs. gitspace.sh</h3>
          <p className="text-zinc-400 mb-4">Without <code className="text-zinc-300">--relay</code>, the relay binds to loopback only and the app is reachable from this machine at <code className="text-zinc-300">http://127.0.0.1:4480</code>.</p>
          <p className="text-zinc-400 mb-4">With <code className="text-zinc-300">--relay</code>, the relay starts in hosted mode behind a cloudflared tunnel and the browser URL becomes <code className="text-zinc-300">https://&lt;subdomain&gt;.gitspace.sh/?enroll=&lt;token&gt;</code>, so you can reach the same stack from another device. That path needs <code className="text-zinc-300">cloudflared</code> installed and a reserved subdomain:</p>
          <CodeBlock code={`gssh user auth login
        gssh user host reserve <name>
        gssh web --relay`} multiLine />
          <p className="text-zinc-400 mb-8">If you have more than one subdomain and the terminal is interactive, <code className="text-zinc-300">gssh web --relay</code> asks which one to use. If it is not interactive, it picks the first one and warns you.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Reusing what is already running</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">gssh web</code> is not a second copy of the stack. If a local relay is already up on the same port and bound to your identity, it reuses it. If the machine daemon is already serving that same relay, it reuses that too and waits for the relay connection to come up.</p>
          <p className="text-zinc-400 mb-4">It refuses to guess when the state does not line up, and says what to do:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>A hosted relay is running but you asked for local only. Stop it with <code className="text-zinc-300">gssh relay stop</code>, or use <code className="text-zinc-300">gssh web --relay</code>.</li>
            <li>Any relay is running and you asked for <code className="text-zinc-300">--relay</code>. Stop it first, because the hosted path has to start its own relay with the enrollment payload pre-configured.</li>
            <li>The relay is on a different port, has no owner identity bound, or is bound to a different user root identity. Stop it, or rerun with the matching <code className="text-zinc-300">--port</code>.</li>
            <li>The machine daemon is serving a different relay. Run <code className="text-zinc-300">gssh machine serve stop</code> first.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Stopping</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">gssh web</code> runs in the foreground. Press Ctrl+C to stop it. It only shuts down the pieces it started itself, so a relay or daemon you had running before stays running.</p>
          <p className="text-zinc-400 mb-4">To manage the pieces directly:</p>
          <CodeBlock code={`gssh status
        gssh relay status
        gssh machine serve status
        gssh machine serve stop
        gssh relay stop`} multiLine />
        </div>
      );

    case "cli-commands":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">CLI Commands</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">The binary is <code className="text-zinc-300">gssh</code>. Most commands are grouped under a top-level noun: project, workspace, machine, invite, client, user, cloud, relay, artifacts. Run <code className="text-zinc-300">gssh &lt;command&gt; --help</code> at any depth to see the real flags.</p>

          <CodeBlock code={`gssh --help
        gssh workspace --help
        gssh workspace session new --help`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Top level</h3>
          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">What it does</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project</td><td className="px-4 py-3">Manage projects</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace</td><td className="px-4 py-3">Manage workspaces within a project</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine</td><td className="px-4 py-3">Manage this machine as a remote-accessible host</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh invite</td><td className="px-4 py-3">Create and manage machine enrollment invites</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh client</td><td className="px-4 py-3">Connect to remote machines as a client</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user</td><td className="px-4 py-3">User identity, authentication, and settings</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh cloud</td><td className="px-4 py-3">Cloud workspace management</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay</td><td className="px-4 py-3">Manage relay server and registered machines</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh artifacts</td><td className="px-4 py-3">Project artifacts repo (branch per workspace, roll-up to main)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh status</td><td className="px-4 py-3">Show status of all gitspace daemons</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh web</td><td className="px-4 py-3">Start the local relay + serve web stack on this machine</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh gallery</td><td className="px-4 py-3">Open the block render gallery (design surface for transcript blocks and tool calls)</td></tr>
            </tbody>
          </table>

          <h3 className="text-xl font-semibold text-white mb-4">project</h3>
          <p className="text-zinc-400 mb-4">A project is a container for one repository and its workspaces. <code className="text-zinc-300">add</code> pulls a repo from GitHub. <code className="text-zinc-300">create</code> makes one from scratch with a local <code className="text-zinc-300">git init</code> and no GitHub repo.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project list</td><td className="px-4 py-3"><code className="text-zinc-300">--json</code>, <code className="text-zinc-300">--verbose</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project add</td><td className="px-4 py-3"><code className="text-zinc-300">--org &lt;org&gt;</code>, <code className="text-zinc-300">--no-clone</code>, <code className="text-zinc-300">--bundle-url &lt;url&gt;</code>, <code className="text-zinc-300">--bundle-path &lt;path&gt;</code>, <code className="text-zinc-300">--skip-bundle</code>, <code className="text-zinc-300">--linear-key &lt;key&gt;</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project create &lt;name&gt;</td><td className="px-4 py-3"><code className="text-zinc-300">--base-branch &lt;branch&gt;</code> (default <code className="text-zinc-300">main</code>), <code className="text-zinc-300">--workspace &lt;name&gt;</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh project remove [project-name]</td><td className="px-4 py-3"><code className="text-zinc-300">--force</code></td></tr>
            </tbody>
          </table>
          <CodeBlock code={`gssh project add --org acme
        gssh project create scratchpad --base-branch main --workspace first-cut
        gssh project list --json`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">workspace</h3>
          <p className="text-zinc-400 mb-4">A workspace is a git worktree on its own branch. Almost every workspace command takes <code className="text-zinc-300">--project &lt;name&gt;</code>, and the ones that act on a single workspace also take <code className="text-zinc-300">--workspace &lt;name&gt;</code>.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace list</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--json</code>, <code className="text-zinc-300">--verbose</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace add [workspace-name]</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--branch &lt;name&gt;</code>, <code className="text-zinc-300">--from &lt;branch&gt;</code>, <code className="text-zinc-300">--status &lt;phase&gt;</code> (default <code className="text-zinc-300">code</code>), <code className="text-zinc-300">--issue &lt;number&gt;</code>, <code className="text-zinc-300">--no-setup</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace set-phase &lt;workspace-name&gt;</td><td className="px-4 py-3"><code className="text-zinc-300">--phase &lt;phase&gt;</code>, <code className="text-zinc-300">--project</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace remove [workspace-name]</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--force</code>, <code className="text-zinc-300">--keep-branch</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace context</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--workspace</code>, <code className="text-zinc-300">--json</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4">The kanban phases are <code className="text-zinc-300">plan</code>, <code className="text-zinc-300">code</code>, <code className="text-zinc-300">review</code>, and <code className="text-zinc-300">ship</code>. <code className="text-zinc-300">--issue</code> on <code className="text-zinc-300">workspace add</code> imports a GitHub issue: the workspace is named after it and its goal is seeded from the issue.</p>
          <CodeBlock code={`gssh workspace add auth-refresh --project gitspace --from develop
        gssh workspace add --project gitspace --issue 412
        gssh workspace set-phase auth-refresh --project gitspace --phase review
        gssh workspace context --project gitspace --workspace auth-refresh --json`} multiLine />

          <h4 className="text-lg font-semibold text-white mb-3">workspace session</h4>
          <p className="text-zinc-400 mb-4">Terminal sessions scoped to one workspace. The parent command takes <code className="text-zinc-300">--sandbox &lt;name&gt;</code> to use an isolated tmux-lite runtime sandbox.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace session list</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--workspace</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace session new [name]</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--workspace</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh workspace session attach</td><td className="px-4 py-3"><code className="text-zinc-300">--project</code>, <code className="text-zinc-300">--workspace</code>, <code className="text-zinc-300">--session &lt;id&gt;</code>, <code className="text-zinc-300">--force</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">--session</code> accepts a session ID or a name. <code className="text-zinc-300">--force</code> takes the session over if it is attached elsewhere.</p>
          <CodeBlock code={`gssh workspace session new build --project gitspace --workspace auth-refresh
        gssh workspace session list --project gitspace --workspace auth-refresh
        gssh workspace session attach --project gitspace --workspace auth-refresh --session build --force`} multiLine />

          <h4 className="text-lg font-semibold text-white mb-3">workspace bundle</h4>
          <p className="text-zinc-400 mb-4">Bundle onboarding values for a workspace: <code className="text-zinc-300">status</code>, <code className="text-zinc-300">show</code>, <code className="text-zinc-300">edit</code>, and <code className="text-zinc-300">refresh</code>. <code className="text-zinc-300">show</code> prints current values, secret set-status, and confirm status; <code className="text-zinc-300">edit</code> updates inputs, secrets, and confirm states.</p>
          <CodeBlock code={`gssh workspace bundle status --project gitspace --workspace auth-refresh
        gssh workspace bundle refresh --project gitspace --workspace auth-refresh`} multiLine />

          <h4 className="text-lg font-semibold text-white mb-3">Other workspace subtrees</h4>
          <p className="text-zinc-400 mb-4">Four subtrees are large enough to have their own pages. They are listed here so you know they exist:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">gssh workspace review</code> is the diff review system: <code className="text-zinc-300">list</code>, <code className="text-zinc-300">import</code>, <code className="text-zinc-300">push</code>, <code className="text-zinc-300">hunks</code>, <code className="text-zinc-300">add-hunk</code>, <code className="text-zinc-300">add-file</code>, <code className="text-zinc-300">add-line</code>.</li>
            <li><code className="text-zinc-300">gssh workspace notes</code> manages local notes and todos: <code className="text-zinc-300">list</code>, <code className="text-zinc-300">add</code>, <code className="text-zinc-300">update</code>, <code className="text-zinc-300">remove</code>, <code className="text-zinc-300">done</code>, <code className="text-zinc-300">undone</code>.</li>
            <li><code className="text-zinc-300">gssh workspace service</code> manages workspace services: <code className="text-zinc-300">list</code>, <code className="text-zinc-300">start</code>, <code className="text-zinc-300">stop</code>, <code className="text-zinc-300">attach</code>, <code className="text-zinc-300">open</code>.</li>
            <li><code className="text-zinc-300">gssh workspace events</code> queries workspace event logs: <code className="text-zinc-300">list</code> (NDJSON), <code className="text-zinc-300">show</code>, <code className="text-zinc-300">tail</code>.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">machine</h3>
          <p className="text-zinc-400 mb-4">This is the host side. <code className="text-zinc-300">serve</code> runs the remote access daemon, <code className="text-zinc-300">tmux</code> runs the terminal session daemon, and <code className="text-zinc-300">enroll</code> registers this machine against a relay using an invite token.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">What it does</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine serve start</td><td className="px-4 py-3">Start the serve daemon (auto-selects a relay when <code className="text-zinc-300">--relay</code> is omitted)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine serve stop</td><td className="px-4 py-3">Stop the serve daemon</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine serve status</td><td className="px-4 py-3">Show serve daemon status</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine enroll</td><td className="px-4 py-3">Enroll with a relay-machine invite token</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux start / stop / status</td><td className="px-4 py-3">Run the tmux-lite server daemon</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux list</td><td className="px-4 py-3">List active tmux-lite sessions</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux new [name]</td><td className="px-4 py-3">Create and attach to a new session</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux attach &lt;id&gt;</td><td className="px-4 py-3">Attach to a session by id or name</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux kill &lt;id&gt;</td><td className="px-4 py-3">Kill a session by id or name</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux replay</td><td className="px-4 py-3">Inspect saved tmux-lite replays</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh machine tmux hosting</td><td className="px-4 py-3">Configure tmux-lite service hosting</td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">serve start</code> takes <code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--relay-pubkey &lt;pubkey&gt;</code>, <code className="text-zinc-300">--foreground</code>, <code className="text-zinc-300">--password-stdin</code>, <code className="text-zinc-300">-y, --yes</code>, and the one-time token flags <code className="text-zinc-300">--bootstrap-token</code>, <code className="text-zinc-300">--enrollment-token</code>, and <code className="text-zinc-300">--unlock-token</code> (with <code className="text-zinc-300">--workspace-id</code>). <code className="text-zinc-300">--takeover</code> reclaims the machine for the current identity by clearing persisted relay control state and forgetting a stale trust pin. <code className="text-zinc-300">gssh machine tmux</code> also accepts <code className="text-zinc-300">--sandbox &lt;name&gt;</code>.</p>
          <CodeBlock code={`gssh machine serve start --foreground
        gssh machine serve start --relay ws://localhost:4480/ws
        gssh machine enroll --invite <token> --label laptop
        gssh machine tmux list`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">invite</h3>
          <p className="text-zinc-400 mb-4">Root-signed tokens that let another machine register on a relay you own.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh invite relay-machine create</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--machine-signing-key &lt;base64&gt;</code>, <code className="text-zinc-300">--machine-key-exchange-key &lt;base64&gt;</code>, <code className="text-zinc-300">--expires &lt;duration&gt;</code> (default <code className="text-zinc-300">24h</code>), <code className="text-zinc-300">--max-uses &lt;n&gt;</code> (default <code className="text-zinc-300">1</code>), <code className="text-zinc-300">--label</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh invite list</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--json</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh invite revoke &lt;invite-id&gt;</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-8"><code className="text-zinc-300">--max-uses</code> also accepts the literal value <code className="text-zinc-300">unlimited</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">client</h3>
          <p className="text-zinc-400 mb-4">The connecting side.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh client machines list</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--relay-pubkey &lt;pubkey&gt;</code>, <code className="text-zinc-300">--json</code>, <code className="text-zinc-300">-y, --yes</code>, <code className="text-zinc-300">--password-stdin</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh client connect [target]</td><td className="px-4 py-3"><code className="text-zinc-300">--relay &lt;url&gt;</code>, <code className="text-zinc-300">--relay-pubkey &lt;pubkey&gt;</code>, <code className="text-zinc-300">--machine &lt;id&gt;</code>, <code className="text-zinc-300">-y, --yes</code>, <code className="text-zinc-300">--password-stdin</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4">The <code className="text-zinc-300">target</code> argument is a machine ID. <code className="text-zinc-300">--machine</code> supplies the machine ID for direct mode.</p>
          <CodeBlock code={`gssh client machines list --relay ws://localhost:4480/ws
        gssh client connect <machine-id>`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">user</h3>
          <p className="text-zinc-400 mb-4">Identity, gitspace.sh login and hosting, settings, and notification hooks.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">What it does</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity init</td><td className="px-4 py-3">Initialize a new identity (generates a 24-word mnemonic)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity show</td><td className="px-4 py-3">Show identity information</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity recover</td><td className="px-4 py-3">Recover identity from the 24-word mnemonic</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity export</td><td className="px-4 py-3">Export public key in <code className="text-zinc-300">gssh-user:</code> format</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity import &lt;key&gt;</td><td className="px-4 py-3">Import a peer public key (validates format)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity remove</td><td className="px-4 py-3">Remove identity from the keychain (mnemonic required to recover)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user identity backup</td><td className="px-4 py-3">Manage optional encrypted cloud backup of your identity</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user auth login / logout / status</td><td className="px-4 py-3">GitHub login for gitspace.sh</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host reserve &lt;subdomain&gt;</td><td className="px-4 py-3">Reserve a subdomain</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host release [subdomain]</td><td className="px-4 py-3">Release a subdomain</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host list</td><td className="px-4 py-3">List your subdomains</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host set-primary &lt;subdomain&gt;</td><td className="px-4 py-3">Set the primary subdomain for hosted relay and tmux hosting</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host status</td><td className="px-4 py-3">Show hosting status</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user host doctor</td><td className="px-4 py-3">Check hosted relay readiness and remediation steps</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user config notifications</td><td className="px-4 py-3">Configure notification settings (<code className="text-zinc-300">--show</code>, <code className="text-zinc-300">--reset</code>)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user config linear setup / show / clear</td><td className="px-4 py-3">Configure the Linear integration</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user notifications install / uninstall / hook / status</td><td className="px-4 py-3">Manage the notification shell hooks</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh user migrate cleanup-legacy</td><td className="px-4 py-3">Delete stale keychain entries after migrating to unified secrets</td></tr>
            </tbody>
          </table>
          <CodeBlock code={`gssh user identity init
        gssh user auth login
        gssh user host reserve brad
        gssh user host doctor`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">relay</h3>
          <p className="text-zinc-400 mb-4">The relay routes encrypted traffic between machines and clients. It never sees plaintext.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay start</td><td className="px-4 py-3"><code className="text-zinc-300">--port &lt;port&gt;</code> (default <code className="text-zinc-300">4480</code>), <code className="text-zinc-300">--bind &lt;address&gt;</code> (default <code className="text-zinc-300">0.0.0.0</code>), <code className="text-zinc-300">--mode &lt;mode&gt;</code> (default <code className="text-zinc-300">auto</code>), <code className="text-zinc-300">--hostname</code>, <code className="text-zinc-300">--label</code>, <code className="text-zinc-300">--foreground</code>, <code className="text-zinc-300">--takeover</code>, <code className="text-zinc-300">-y, --yes</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay stop</td><td className="px-4 py-3">Stop the relay server</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay status</td><td className="px-4 py-3"><code className="text-zinc-300">--json</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay machines list</td><td className="px-4 py-3"><code className="text-zinc-300">--json</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh relay machines revoke &lt;machine-id&gt;</td><td className="px-4 py-3">Remove a machine from the relay registry</td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">--mode</code> takes <code className="text-zinc-300">auto</code> (local plus hosted if available), <code className="text-zinc-300">hosted</code> (require a tunnel, keep local), or <code className="text-zinc-300">local</code>. <code className="text-zinc-300">relay start</code> runs in the background unless you pass <code className="text-zinc-300">--foreground</code>.</p>
          <CodeBlock code={`gssh relay start --mode local --port 4480
        gssh relay status --json
        gssh relay machines list`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Whole-machine commands</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">gssh status</code> prints the state of every gitspace daemon. <code className="text-zinc-300">gssh web</code> brings up the local relay and serve stack together, which is the fastest way to get the web app running on this machine.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-4">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">Notable flags</th></tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh status</td><td className="px-4 py-3">No flags</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh web</td><td className="px-4 py-3"><code className="text-zinc-300">--port &lt;port&gt;</code> (default <code className="text-zinc-300">4480</code>), <code className="text-zinc-300">--relay</code>, <code className="text-zinc-300">--takeover</code>, <code className="text-zinc-300">--password-stdin</code>, <code className="text-zinc-300">-y, --yes</code></td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">gssh gallery [page]</td><td className="px-4 py-3"><code className="text-zinc-300">--port &lt;port&gt;</code> (default <code className="text-zinc-300">5173</code>), <code className="text-zinc-300">--no-open</code>; page is <code className="text-zinc-300">blocks</code> (default) or <code className="text-zinc-300">transcript</code></td></tr>
            </tbody>
          </table>
          <p className="text-zinc-400 mb-8"><code className="text-zinc-300">gssh web --relay</code> starts a hosted relay with a cloudflared tunnel to your gitspace.sh subdomain.</p>

          <h3 className="text-xl font-semibold text-white mb-4">artifacts and cloud</h3>
          <p className="text-zinc-400 mb-4">Two trees are documented on their own pages. In outline:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">gssh artifacts</code> manages the per-project artifacts repo, one branch per workspace rolled up to main: <code className="text-zinc-300">provision</code>, <code className="text-zinc-300">status</code>, <code className="text-zinc-300">repair</code>, <code className="text-zinc-300">remote</code>, <code className="text-zinc-300">sync</code>, <code className="text-zinc-300">rollup &lt;workspace&gt;</code>.</li>
            <li><code className="text-zinc-300">gssh cloud</code> manages cloud workspaces: <code className="text-zinc-300">setup</code>, <code className="text-zinc-300">status</code>, <code className="text-zinc-300">list</code>, <code className="text-zinc-300">launch</code>, <code className="text-zinc-300">stop</code>, <code className="text-zinc-300">resume</code>, <code className="text-zinc-300">destroy</code>, <code className="text-zinc-300">connect</code>.</li>
          </ul>
        </div>
      );

    case "workspace-review":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Diff Review</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">Review a workspace diff as local threads, then sync those threads with a GitHub pull request. Threads can target a whole file, a line range, or a single hunk. The reading and writing commands all speak JSON, so an agent can drive the same review surface a person uses.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Commands</h3>
          <p className="text-zinc-400 mb-4">All of these live under <code className="text-zinc-300">gssh workspace review</code>. Running the group with no subcommand prints its help.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Command</th>
                <th className="px-4 py-3">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">review list</td><td className="px-4 py-3">Print review threads as structured JSON</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">review import</td><td className="px-4 py-3">Import GitHub PR review comments as local threads</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">review push</td><td className="px-4 py-3">Push local review decisions to GitHub as a formal PR review</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">review hunks &lt;file&gt;</td><td className="px-4 py-3">List hunks in a changed file with stable index IDs</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">review add-hunk &lt;file&gt;</td><td className="px-4 py-3">Add or update a hunk review by hunk index</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">review add-file &lt;file&gt;</td><td className="px-4 py-3">Add a file-level review thread</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">review add-line &lt;file&gt;</td><td className="px-4 py-3">Add a line-range review thread</td></tr>
            </tbody>
          </table>

          <h3 className="text-xl font-semibold text-white mb-4">Context flags</h3>
          <p className="text-zinc-400 mb-4">Every subcommand requires <code className="text-zinc-300">--project &lt;name&gt;</code> and <code className="text-zinc-300">--workspace &lt;name&gt;</code>. There is no implicit context on these commands, so a script or an agent never has to guess which workspace it is writing to.</p>
          <p className="text-zinc-400 mb-4">The <code className="text-zinc-300">&lt;file&gt;</code> argument is matched against the workspace's changed files. A full path always works. A shorter suffix works too when it matches exactly one changed file. If it matches several, the command fails and lists the candidates instead of picking one.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Reading the diff</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">hunks</code> is the targeting step. It prints each hunk in a changed file with a 1-based index, the hunk header, and a target ref you can quote back. Use <code className="text-zinc-300">--format text</code> for a short list of index and header, or leave it off for JSON.</p>
          <CodeBlock code={`gssh workspace review hunks src/core/review.ts --project gitspace --workspace my-space
        gssh workspace review hunks src/core/review.ts --project gitspace --workspace my-space --format text`} multiLine />

          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">list</code> prints the threads that already exist. Each thread carries its target kind, a target ref, a readable target summary, its decision, whether it is resolved, and every comment on it. JSON is the default; <code className="text-zinc-300">--format text</code> prints the same threads as readable blocks.</p>
          <CodeBlock code={`gssh workspace review list --project gitspace --workspace my-space
        gssh workspace review list --project gitspace --workspace my-space --format text`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Adding threads</h3>
          <p className="text-zinc-400 mb-4">Three granularities, three commands. All three accept <code className="text-zinc-300">--json</code> to print the created thread ID and target ref instead of a success line.</p>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">add-hunk</code> takes the index from <code className="text-zinc-300">hunks</code> via <code className="text-zinc-300">--index &lt;number&gt;</code>, which is required. It carries an optional <code className="text-zinc-300">--body &lt;text&gt;</code> and one decision flag: <code className="text-zinc-300">--approve</code>, <code className="text-zinc-300">--reject</code>, or <code className="text-zinc-300">--pending</code>. Passing more than one decision flag is an error. You must pass at least a decision or a body. If a thread already exists on that hunk, the decision updates it and the body is added as a reply rather than starting a second thread.</p>
          <CodeBlock code={`gssh workspace review add-hunk src/core/review.ts --project gitspace --workspace my-space --index 2 --approve
        gssh workspace review add-hunk src/core/review.ts --project gitspace --workspace my-space --index 3 --reject --body "This drops the error case."`} multiLine />

          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">add-file</code> attaches a comment to the whole file. <code className="text-zinc-300">--body &lt;text&gt;</code> is required.</p>
          <CodeBlock code={`gssh workspace review add-file src/core/review.ts --project gitspace --workspace my-space --body "Split this module before merge."`} multiLine />

          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">add-line</code> attaches a comment to a line range. <code className="text-zinc-300">--start &lt;number&gt;</code> and <code className="text-zinc-300">--body &lt;text&gt;</code> are required. <code className="text-zinc-300">--end &lt;number&gt;</code> defaults to the start line, and an end below the start is clamped up to it. <code className="text-zinc-300">--side &lt;side&gt;</code> takes LEFT or RIGHT and defaults to RIGHT, so a comment lands on the new side of the diff unless you say otherwise.</p>
          <CodeBlock code={`gssh workspace review add-line src/core/review.ts --project gitspace --workspace my-space --start 120 --end 134 --body "Extract this into a helper."
        gssh workspace review add-line src/core/review.ts --project gitspace --workspace my-space --start 88 --side LEFT --body "Why was this removed?"`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">GitHub round trip</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">import</code> pulls the PR's review comments down as local threads. Root comments become threads and replies are attached to them. Comments already imported are skipped, so running it again only picks up what is new. It reports how many threads were imported and how many exist in total.</p>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">push</code> sends unresolved threads back up as one formal PR review. The overall review event is derived from your hunk decisions: any rejected hunk submits REQUEST_CHANGES, all hunks approved with none rejected submits APPROVE, and anything else submits COMMENT. It prints a GitHub URL when it finishes.</p>
          <p className="text-zinc-400 mb-4">Both take <code className="text-zinc-300">--pr &lt;number&gt;</code>. Leave it off and the PR is detected from the workspace branch; if there is no open PR to detect, the command fails and asks you to pass the number. Both shell out to the <code className="text-zinc-300">gh</code> CLI, so <code className="text-zinc-300">gh</code> must be installed and authenticated.</p>
          <CodeBlock code={`gssh workspace review import --project gitspace --workspace my-space
        gssh workspace review import --project gitspace --workspace my-space --pr 412
        gssh workspace review push --project gitspace --workspace my-space --pr 412`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">The workflow</h3>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Import existing PR feedback so it sits alongside your own notes.</li>
            <li>List the hunks in each changed file to get stable target IDs.</li>
            <li>Add hunk, line, and file threads, marking hunks approved, rejected, or pending as you go.</li>
            <li>List threads to see the current state of the review.</li>
            <li>Push once. The decisions decide whether GitHub sees an approval, a change request, or a comment.</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Who calls what</h3>
          <p className="text-zinc-400 mb-4">The <code className="text-zinc-300">hunks</code>, <code className="text-zinc-300">add-hunk</code>, <code className="text-zinc-300">add-file</code>, and <code className="text-zinc-300">add-line</code> commands are built for agents. Help text calls the hunk IDs AI-friendly targets, and the shape is deliberate: an agent lists hunks, gets back indexes and target refs as JSON, then writes a thread against an index instead of trying to describe a location in prose. <code className="text-zinc-300">list</code> defaults to JSON for the same reason, and <code className="text-zinc-300">--json</code> on the add commands closes the loop by returning the new thread ID.</p>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">import</code> and <code className="text-zinc-300">push</code> are the human-facing ends. They talk to GitHub on your account through <code className="text-zinc-300">gh</code>, and <code className="text-zinc-300">push</code> submits a review under your name, so it is the step worth keeping a person on. The text output modes exist for the same reason: reading a review is a human job even when writing it was not.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Where threads are stored</h3>
          <p className="text-zinc-400 mb-4">Review threads live in the workspace at <code className="text-zinc-300">.gitspace/workspace/&lt;workspace&gt;/review.json</code>. They are local until you push them.</p>
        </div>
      );

    case "workspace-ops":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Notes, Services, and Events</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">Three subtrees under <code className="text-zinc-300">gssh workspace</code> cover the day to day state of a workspace: notes and todos you keep next to the branch, long running services defined by the repo, and the structured event log those services write.</p>

          <p className="text-zinc-400 mb-8">Every command in this section takes <code className="text-zinc-300">--project &lt;name&gt;</code> and <code className="text-zinc-300">--workspace &lt;name&gt;</code>. Both are required.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Notes and todos</h3>
          <p className="text-zinc-400 mb-4">Notes are local scratch state attached to one workspace. A note is either a plain note or a todo, and a todo can carry a priority of <code className="text-zinc-300">low</code>, <code className="text-zinc-300">medium</code>, or <code className="text-zinc-300">high</code>. They are stored as JSON inside the workspace, under <code className="text-zinc-300">.gitspace/workspace/&lt;workspace&gt;/notes.json</code>, and that directory is added to your ignore rules, so notes never end up in a commit.</p>

          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Command</th>
                <th className="px-4 py-3">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">notes list</td><td className="px-4 py-3">Print all notes. JSON by default, with a summary block. Use <code className="text-zinc-300">--format text</code> for one line per note.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">notes add</td><td className="px-4 py-3">Add a note. Body comes from <code className="text-zinc-300">--body</code> or <code className="text-zinc-300">--stdin</code>, not both.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">notes update</td><td className="px-4 py-3">Change an existing note by <code className="text-zinc-300">--id</code>.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">notes remove</td><td className="px-4 py-3">Delete a note by <code className="text-zinc-300">--id</code>.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">notes done</td><td className="px-4 py-3">Mark a todo done.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">notes undone</td><td className="px-4 py-3">Mark a todo open again.</td></tr>
            </tbody>
          </table>

          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">add</code> takes <code className="text-zinc-300">--todo</code> and <code className="text-zinc-300">--priority</code>. <code className="text-zinc-300">update</code> takes <code className="text-zinc-300">--body</code>, <code className="text-zinc-300">--priority</code>, <code className="text-zinc-300">--todo</code> or <code className="text-zinc-300">--note</code> to switch kind, and <code className="text-zinc-300">--done</code> or <code className="text-zinc-300">--undone</code>. You cannot pass both halves of a pair. Every write command accepts <code className="text-zinc-300">--json</code> to print the resulting note instead of a status line.</p>

          <CodeBlock code={`gssh workspace notes add --project my-app --workspace fix-login \\
          --todo --priority high --body "Rotate the session key before merge"

        gssh workspace notes list --project my-app --workspace fix-login --format text

        gssh workspace notes done --project my-app --workspace fix-login --id <note-id>`} multiLine />

          <p className="text-zinc-400 mb-8">Text output marks todos with <code className="text-zinc-300">[ ]</code> or <code className="text-zinc-300">[x]</code> and plain notes with <code className="text-zinc-300">-</code>, followed by the note id you pass back to <code className="text-zinc-300">update</code>, <code className="text-zinc-300">remove</code>, <code className="text-zinc-300">done</code>, and <code className="text-zinc-300">undone</code>.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Services</h3>
          <p className="text-zinc-400 mb-4">A service is a long running process the workspace knows how to start: a dev server, a worker, a watcher. The list is not something you register through the CLI. It comes from a file in the repo, <code className="text-zinc-300">.gitspace/processes.json</code> inside the workspace, so the service set is versioned with the branch. The file is parsed as JSONC, meaning comments and trailing commas are allowed.</p>

          <p className="text-zinc-400 mb-4">The file holds a <code className="text-zinc-300">processes</code> array. Each entry needs a unique <code className="text-zinc-300">name</code> and a <code className="text-zinc-300">command</code>. The rest is optional:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">args</code>, <code className="text-zinc-300">cwd</code>, <code className="text-zinc-300">env</code>. Env values must be strings, so quote numbers.</li>
            <li><code className="text-zinc-300">instances</code>. Omitted means one. Set it to <code className="text-zinc-300">0</code> to disable the definition without deleting it.</li>
            <li><code className="text-zinc-300">autostart</code>, a boolean.</li>
            <li><code className="text-zinc-300">restart</code>, an object with <code className="text-zinc-300">policy</code> (<code className="text-zinc-300">never</code>, <code className="text-zinc-300">on-failure</code>, <code className="text-zinc-300">always</code>) plus <code className="text-zinc-300">maxAttempts</code>, <code className="text-zinc-300">backoffMs</code>, <code className="text-zinc-300">maxBackoffMs</code>. It must be an object. The bare string form is rejected.</li>
            <li><code className="text-zinc-300">ports</code>, a list of entries that each need a <code className="text-zinc-300">name</code>, unique within the service. <code className="text-zinc-300">protocol</code> is optional and is either <code className="text-zinc-300">http</code> or <code className="text-zinc-300">tcp</code>; anything other than <code className="text-zinc-300">tcp</code> is treated as HTTP.</li>
            <li><code className="text-zinc-300">events</code>, which tunes event capture for that service.</li>
          </ul>

          <JsonBlock code={`{
          "processes": [
            {
              "name": "sample-server",
              "command": "bun",
              "args": ["sample-server/index.ts"],
              "autostart": false,
              "ports": [
                { "name": "web", "protocol": "http" }
              ],
              "restart": {
                "policy": "on-failure",
                "maxAttempts": 5,
                "backoffMs": 2000,
                "maxBackoffMs": 10000
              }
            }
          ]
        }`} />

          <p className="text-zinc-400 mb-4">If the file is missing or the array is empty, <code className="text-zinc-300">service list</code> tells you there are no processes configured. A malformed or invalid file prints a warning naming the path and the problem.</p>

          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Command</th>
                <th className="px-4 py-3">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">service list</td><td className="px-4 py-3">List each configured instance as <code className="text-zinc-300">name#instance</code> with running or stopped, plus its local and hosted URLs.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">service start</td><td className="px-4 py-3">Start every instance of <code className="text-zinc-300">--name</code>.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">service stop</td><td className="px-4 py-3">Stop every instance of <code className="text-zinc-300">--name</code>.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">service attach</td><td className="px-4 py-3">Print the <code className="text-zinc-300">gssh machine tmux attach</code> command for the running service session.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">service open</td><td className="px-4 py-3">Open the service's HTTP ports in a browser.</td></tr>
            </tbody>
          </table>

          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">start</code>, <code className="text-zinc-300">stop</code>, <code className="text-zinc-300">attach</code>, and <code className="text-zinc-300">open</code> all require <code className="text-zinc-300">--name</code>. Ports are allocated when a service starts, so a service you have never started reports that its ports are not allocated yet.</p>

          <CodeBlock code={`gssh workspace service list --project my-app --workspace fix-login

        gssh workspace service start --project my-app --workspace fix-login --name sample-server

        gssh workspace service open --project my-app --workspace fix-login --name sample-server --local`} multiLine />

          <p className="text-zinc-400 mb-8"><code className="text-zinc-300">open</code> picks the first HTTP port by default and prefers the hosted URL when hosting is on. <code className="text-zinc-300">--port &lt;name-or-number&gt;</code> picks a specific one, <code className="text-zinc-300">--all</code> opens every HTTP port, <code className="text-zinc-300">--local</code> forces the localhost URL, and <code className="text-zinc-300">--remote</code> requires a hosted URL and fails if there is not an active one. <code className="text-zinc-300">--local</code> and <code className="text-zinc-300">--remote</code> cannot be combined.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Events</h3>
          <p className="text-zinc-400 mb-4">Every line a service writes is captured as a structured event and stored under the workspace at <code className="text-zinc-300">.gitspace/events/processes/&lt;service&gt;-&lt;instance&gt;/</code>, one JSON object per line. A plain log line still becomes an event; a line that happens to be JSON keeps its fields. Each event carries an <code className="text-zinc-300">eventId</code>, <code className="text-zinc-300">eventName</code>, <code className="text-zinc-300">level</code>, <code className="text-zinc-300">timestamp</code> and <code className="text-zinc-300">timestampMs</code>, <code className="text-zinc-300">message</code>, the project and workspace, and the raw parsed line.</p>

          <p className="text-zinc-400 mb-4">If a service sets a <code className="text-zinc-300">correlationField</code> in its <code className="text-zinc-300">events</code> config, matching lines are also rolled into a wide event that carries a timeline of the events collected for that correlation id. The timeline is capped, so the oldest entries fall off once the cap is reached. That gives two kinds: <code className="text-zinc-300">source</code> for the raw line and <code className="text-zinc-300">wide</code> for the aggregate.</p>

          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Command</th>
                <th className="px-4 py-3">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="px-4 py-3 font-mono text-green-400">events list</td><td className="px-4 py-3">Print matching events as NDJSON, one compact object per line. Limit defaults to 100.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">events show</td><td className="px-4 py-3">Print one event, pretty printed. Needs an event id, from <code className="text-zinc-300">--event-id</code> or <code className="text-zinc-300">--filter "eventId=&lt;id&gt;"</code>.</td></tr>
              <tr><td className="px-4 py-3 font-mono text-green-400">events tail</td><td className="px-4 py-3">Print the most recent events. Limit defaults to 50. Add <code className="text-zinc-300">--follow</code> to keep streaming.</td></tr>
            </tbody>
          </table>

          <p className="text-zinc-400 mb-4">Because the output is NDJSON, you can pipe it straight into <code className="text-zinc-300">jq</code> or any line oriented tool. <code className="text-zinc-300">list</code> and <code className="text-zinc-300">tail</code> share the same filters:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><code className="text-zinc-300">--process</code>, <code className="text-zinc-300">--level</code>, <code className="text-zinc-300">--event</code>, <code className="text-zinc-300">--event-id</code>, <code className="text-zinc-300">--correlation-id</code></li>
            <li><code className="text-zinc-300">--since</code> and <code className="text-zinc-300">--until</code>, each taking a duration like <code className="text-zinc-300">30m</code> or <code className="text-zinc-300">2h</code>, or an ISO timestamp</li>
            <li><code className="text-zinc-300">--filter key=value</code>, repeatable. Keys are <code className="text-zinc-300">event</code>, <code className="text-zinc-300">eventId</code>, <code className="text-zinc-300">level</code>, <code className="text-zinc-300">message</code>, <code className="text-zinc-300">process</code>, <code className="text-zinc-300">kind</code> (<code className="text-zinc-300">source</code> or <code className="text-zinc-300">wide</code>), and <code className="text-zinc-300">correlationId</code></li>
          </ul>

          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">list</code> also takes <code className="text-zinc-300">--head [n]</code>, <code className="text-zinc-300">--tail [n]</code>, and <code className="text-zinc-300">--order asc|desc</code>. Order is newest first unless you ask for <code className="text-zinc-300">--head</code>, which flips it to oldest first.</p>

          <CodeBlock code={`gssh workspace events tail --project my-app --workspace fix-login \\
          --process sample-server --follow

        gssh workspace events list --project my-app --workspace fix-login \\
          --level error --since 2h --limit 20

        gssh workspace events show --project my-app --workspace fix-login --event-id <event-id>`} multiLine />

          <p className="text-zinc-400 mb-8">Reach for <code className="text-zinc-300">tail --follow</code> when you are watching a service you just started and want its output without attaching a terminal to it. Reach for <code className="text-zinc-300">list</code> with <code className="text-zinc-300">--since</code> and <code className="text-zinc-300">--level</code> after the fact, when something already failed and you want the error lines. Once you have a correlation id from one event, <code className="text-zinc-300">--correlation-id</code> pulls the whole request back out.</p>
        </div>
      );

    case "custom-scripts":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Custom Scripts</h1>

          <p className="text-zinc-400 mb-4">
            GitSpace uses convention-based scripts stored per workspace in <code className="text-zinc-300">~/gitspace/&lt;project&gt;/workspaces/&lt;workspace&gt;/.gitspace/scripts/</code>:
          </p>

          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 font-mono text-sm mb-8">
            <pre className="text-zinc-300">{`~/gitspace/<project>/workspaces/<workspace>/.gitspace/
└── scripts/
    ├── pre/      # Run before setup (once)
    ├── setup/    # Run on workspace creation (once)
    ├── select/   # Run every time workspace is opened
    └── remove/   # Run before workspace deletion`}</pre>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Rules</h3>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Scripts must be executable (<code className="text-zinc-300">chmod +x</code>)</li>
            <li>Run alphabetically (use <code className="text-zinc-300">01-</code>, <code className="text-zinc-300">02-</code> prefixes)</li>
            <li>Working directory: the workspace</li>
            <li>Arguments: <code className="text-zinc-300">$1</code> = workspace name, <code className="text-zinc-300">$2</code> = repository</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Example Script</h3>
          <p className="text-zinc-500 text-sm mb-2">.gitspace/scripts/select/01-status.sh</p>
          <JsonBlock code={`#!/bin/bash
echo "Switching to: $1"
git fetch origin
git status`} />
        </div>
      );

    case "repo-bundles":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Repo Config Bundles</h1>

          <p className="text-zinc-400 mb-4">
            Bundles allow teams to share onboarding configurations. Place in <code className="text-zinc-300">.gitspace/</code>:
          </p>

          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 font-mono text-sm mb-8">
            <pre className="text-zinc-300">{`.gitspace/
├── bundle.json           # Manifest
└── scripts/
    ├── pre/              # Pre-setup scripts
    ├── setup/            # Setup scripts
    ├── select/           # Select scripts
    └── remove/           # Remove scripts`}</pre>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Manifest Example</h3>
          <JsonBlock code={`{
  "version": "1.0",
  "name": "my-app-bundle",
  "onboarding": [
    { "id": "node", "type": "confirm", "title": "Node.js", "checkCommand": "node" },
    { "id": "api-key", "type": "secret", "title": "API Key", "configKey": "apiKey" }
  ]
}`} />

          <h3 className="text-xl font-semibold text-white mb-4">Step Types</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400 mb-8">
              <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Purpose</th>
                  <th className="px-4 py-3">Storage</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">info</td>
                  <td className="px-4 py-3">Display information</td>
                  <td className="px-4 py-3">N/A</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">confirm</td>
                  <td className="px-4 py-3">Verify installation</td>
                  <td className="px-4 py-3">N/A</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">secret</td>
                  <td className="px-4 py-3">Sensitive values</td>
                  <td className="px-4 py-3">OS Keychain</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">input</td>
                  <td className="px-4 py-3">Plain text</td>
                  <td className="px-4 py-3">Config file</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="text-xl font-semibold text-white mb-4">Using Values in Scripts</h3>
          <JsonBlock code={`echo "Team: $TEAM_NAME"
echo "Has API key: $API_KEY"`} />
        </div>
      );

    case "artifacts":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Artifacts</h1>
          <p className="text-xl text-zinc-400 mb-8 leading-relaxed">Screenshots, demo videos, eval reports, goal evidence. Work that proves work happened, but does not belong in your code repo. GitSpace gives every project a second git repo just for that, with a branch per workspace and a roll-up into main.</p>

          <h3 className="text-xl font-semibold text-white mb-4">The model</h3>
          <p className="text-zinc-400 mb-4">One artifacts git repo per project. One branch per workspace. Roll-up merges a workspace branch into main.</p>
          <p className="text-zinc-400 mb-4">The repo is a bare repo at <code className="text-zinc-300">~/gitspace/&lt;project&gt;/.artifacts.git</code>. Each workspace mounts its own branch as a git worktree at <code className="text-zinc-300">&lt;workspace&gt;/.gitspace/artifacts</code>, and the project base mounts <code className="text-zinc-300">main</code> the same way. The branch is created off main the first time the mount is made. A workspace is a code branch plus an artifacts branch.</p>

          <CodeBlock code={`~/gitspace/<project>/.artifacts.git      # bare artifacts repo, one per project
          main                                   # the shared record
          <workspace-name>                       # branched off main when the mount is created

        <workspace>/.gitspace/artifacts          # worktree of the workspace branch
        base/.gitspace/artifacts                 # worktree of main`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Why roll-up cannot conflict</h3>
          <p className="text-zinc-400 mb-4">The tree layout is what makes merging routine. Every goal owns <code className="text-zinc-300">goals/&lt;goal-id&gt;/</code> and nothing else. Project-level artifacts live at the tree root. Because goal folders are disjoint, two workspaces do not write the same path, so merging a workspace branch into <code className="text-zinc-300">main</code> stays mechanically conflict-free.</p>
          <p className="text-zinc-400 mb-8">The folder is keyed by goal id, not workspace name. Workspace names are ephemeral. The worktree gets deleted at ship and the name can be reused. Artifacts outlive the workspace that made them.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Large files</h3>
          <p className="text-zinc-400 mb-4">A pre-commit hook installed once in the bare repo's <code className="text-zinc-300">hooks/</code> converts staged blobs of 2 MB or more into a local blob-store entry plus a git-LFS pointer, and adds the matching <code className="text-zinc-300">.gitattributes</code> line. You commit normally. Blob bytes live in <code className="text-zinc-300">~/gitspace/&lt;project&gt;/.artifacts-blobs</code>.</p>
          <p className="text-zinc-400 mb-8">Hooks can be bypassed with <code className="text-zinc-300">--no-verify</code>, so the real boundary is a publish gate. <code className="text-zinc-300">sync</code> and <code className="text-zinc-300">rollup</code> refuse to publish a branch that carries a raw non-pointer blob of 2 MB or more. Those bytes never left your machine, so <code className="text-zinc-300">repair</code> can rewrite the commits safely.</p>

          <h3 className="text-xl font-semibold text-white mb-4">Three tiers</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">gssh artifacts status</code> reports which one you are on, based on the configured remote.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Tier</th><th className="px-4 py-3">Branches</th><th className="px-4 py-3">Large files</th></tr>
            </thead>
            <tbody>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3">GitHub</td><td className="px-4 py-3">Pushed to a private <code className="text-zinc-300">&lt;owner&gt;/&lt;repo&gt;-artifacts</code></td><td className="px-4 py-3">Uploaded to GitHub LFS</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3">BYO remote</td><td className="px-4 py-3">Pushed to any git URL you attach</td><td className="px-4 py-3">Blobs stay local, no transport</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3">Local only</td><td className="px-4 py-3">No remote</td><td className="px-4 py-3">Blobs stay local</td></tr>
            </tbody>
          </table>

          <h3 className="text-xl font-semibold text-white mb-4">Getting on the GitHub tier</h3>
          <p className="text-zinc-400 mb-4">One command. It creates the private repo, pushes, mirrors the code repo's collaborators, and uploads large files to GitHub LFS. It also commits a pointer file into your code repo, so other machines and teammates pick up the remote when they clone.</p>
          <CodeBlock code={`gssh artifacts provision`} multiLine />

          <p className="text-zinc-400 mb-4">Prefer your own git host instead. Attach a remote and sync. The URL is recorded in <code className="text-zinc-300">.gitspace/artifacts.json</code> and staged in the base repo, so commit it.</p>
          <CodeBlock code={`gssh artifacts remote add git@example.com:me/thing-artifacts.git
        gssh artifacts sync`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Project command reference</h3>
          <p className="text-zinc-400 mb-4">Every command takes <code className="text-zinc-300">--project &lt;name&gt;</code>, which defaults to the current project.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">What it does</th></tr>
            </thead>
            <tbody>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh artifacts provision</td><td className="px-4 py-3">Provision a private GitHub artifacts repo, push, mirror collaborators, upload large files to GitHub LFS</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh artifacts status</td><td className="px-4 py-3">Show the repo path, tier, remote, blob store, hook health, and branches</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh artifacts repair</td><td className="px-4 py-3">Convert raw large files in never-pushed commits to LFS pointers. Takes <code className="text-zinc-300">--workspace &lt;name&gt;</code>, defaulting to the project base's main mount</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh artifacts remote add &lt;url&gt;</td><td className="px-4 py-3">Attach a git remote and record it in <code className="text-zinc-300">.gitspace/artifacts.json</code></td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh artifacts sync</td><td className="px-4 py-3">Fetch, fast-forward main, then push all artifact branches to the remote</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh artifacts rollup &lt;workspace&gt;</td><td className="px-4 py-3">Merge a workspace's artifacts branch into main, filtered. Add <code className="text-zinc-300">--remove-branch</code> to delete the branch after a clean merge</td></tr>
            </tbody>
          </table>

          <h3 className="text-xl font-semibold text-white mb-4">When a push is refused</h3>
          <p className="text-zinc-400 mb-4">If <code className="text-zinc-300">sync</code> reports a refused branch, it names the offending files, their sizes, and the repair command. Repair that branch, then sync again.</p>
          <CodeBlock code={`gssh artifacts sync
        # Push REFUSED for branch 'my-workspace': demo.mp4 (14.2 MB) committed raw
        #   — run: gssh artifacts repair --workspace my-workspace

        gssh artifacts repair --workspace my-workspace
        gssh artifacts sync`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Rolling up</h3>
          <p className="text-zinc-400 mb-4">Curation happens at the merge, not before it. For each goal folder the branch owns, roll-up keeps two things and drops the rest:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-4 ml-2">
            <li>The canonical record the goal system writes: the goal doc, the rubric, the workflow spec, journal, review, validation evidence, triggers, blame, and the favorites manifest. This always rolls up.</li>
            <li>Anything else captured into the goal folder, but only when it is starred. Stars live in a committed manifest at <code className="text-zinc-300">goals/&lt;goal-id&gt;/.favorites.json</code>, so they travel with the branch and the roll-up can read them.</li>
          </ul>
          <p className="text-zinc-400 mb-4">Project-level paths at the tree root, and goal folders the branch did not change, pass through untouched.</p>
          <CodeBlock code={`gssh artifacts rollup my-workspace --remove-branch`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Inside a workspace</h3>
          <p className="text-zinc-400 mb-4"><code className="text-zinc-300">gssh space artifacts</code> is the in-session surface. Paths are relative to the root you own, which for a workspace agent is its goal folder.</p>
          <table className="w-full text-sm text-left text-zinc-400 mb-8">
            <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
              <tr><th className="px-4 py-3">Command</th><th className="px-4 py-3">What it does</th></tr>
            </thead>
            <tbody>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh space artifacts commit &lt;paths...&gt;</td><td className="px-4 py-3">Capture files already written in the mount. Pointer split plus provenance in one commit. <code className="text-zinc-300">-m, --message &lt;message&gt;</code>, <code className="text-zinc-300">--cap &lt;token&gt;</code> to verify a capability token and enforce its write scope</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh space artifacts promote &lt;source&gt; &lt;destRelPath&gt;</td><td className="px-4 py-3">Promote an uncommitted working file into the versioned tree. <code className="text-zinc-300">-m, --message &lt;message&gt;</code></td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh space artifacts scratch-path &lt;rel&gt;</td><td className="px-4 py-3">Print the absolute path a <code className="text-zinc-300">local://&lt;rel&gt;</code> reference resolves to. Parent dirs are created</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh space artifacts share &lt;relPath&gt;</td><td className="px-4 py-3">Mint a signed public link served through your relay. Requires serve active. <code className="text-zinc-300">--ttl &lt;duration&gt;</code> (default <code className="text-zinc-300">7d</code>), <code className="text-zinc-300">--max-uses &lt;n&gt;</code>, <code className="text-zinc-300">--live</code> to serve current branch state instead of pinning a point-in-time capture</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh space artifacts share-list</td><td className="px-4 py-3">List minted share links on this machine</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh space artifacts share-revoke &lt;tokenId&gt;</td><td className="px-4 py-3">Revoke a share link. Takes effect on the next request</td></tr>
              <tr className="border-b border-zinc-800"><td className="px-4 py-3 font-mono text-green-400">gssh space artifacts repair</td><td className="px-4 py-3">Same repair, scoped to the current workspace</td></tr>
            </tbody>
          </table>

          <p className="text-zinc-400 mb-4">A typical in-session flow. Write a draft to scratch, promote it into the versioned tree, then share it.</p>
          <CodeBlock code={`gssh space artifacts scratch-path notes.md
        gssh space artifacts promote local://notes.md reports/notes.md -m "capture run notes"
        gssh space artifacts share reports/notes.md --ttl 24h --max-uses 5`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4">Addressing</h3>
          <p className="text-zinc-400 mb-4">Artifacts have a URI scheme. The mount base is resolved on the server from the project and workspace segments, so clients never supply a path prefix.</p>
          <CodeBlock code={`artifact://<project>/<workspace>/<relpath>`} multiLine />
          <p className="text-zinc-400 mb-8">The workspace segment is a workspace name or <code className="text-zinc-300">@base</code> for the project base clone's main mount. Session scratch lives under <code className="text-zinc-300">.sessions/</code>, which the bare repo's shared exclude keeps out of version control while staying addressable, so drafts never enter branch history or roll-ups.</p>
        </div>
      );

    case "gitspace-managed":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">gitspace.sh (Managed)</h1>

          <p className="text-zinc-400 mb-6">
            The easiest way to get remote access:
          </p>

          <CodeBlock code={`# 1. Create identity
gssh user identity init

# 2. Login with GitHub
gssh user auth login

# 3. Reserve subdomain
gssh user host reserve yourname

# 4. Start serving
gssh machine serve start --foreground

# 5. Access: https://yourname.gitspace.sh`} multiLine />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Manage Subdomains</h3>
          <CodeBlock code={`gssh user host list              # List your subdomains
gssh user host set-primary name  # Set primary
gssh user host release name      # Release subdomain
gssh user host status            # Show status`} multiLine language="bash" />
        </div>
      );

    case "self-hosted-relay":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Self-Hosted Relay</h1>

          <p className="text-zinc-400 mb-6">For complete control, run your own relay:</p>

          <h3 className="text-xl font-semibold text-white mb-4">1. Start Relay</h3>
          <CodeBlock code="gssh relay start --port 4480" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">2. Create Enrollment Invite</h3>
          <CodeBlock
            code={`# On the machine
gssh user identity init
gssh user identity show

# On the relay host
gssh invite relay-machine create --relay ws://localhost:4480/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB> --label "My Mac"`}
            multiLine
          />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">3. Enroll + Serve</h3>
          <CodeBlock code={`gssh machine enroll --invite "ws://localhost:4480/ws#<TOKEN>" --label "My Mac"
gssh machine serve start --relay ws://localhost:4480/ws`} multiLine language="bash" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">4. Connect from Another Owner Device</h3>
          <CodeBlock code={`# Recover the same owner identity
gssh user identity recover

# Connect as owner
gssh client connect <machine-id>`} multiLine />
        </div>
      );

    case "identity-management":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Identity Management</h1>

          <p className="text-zinc-400 mb-6">
            Every machine and client has a cryptographic identity:
          </p>

          <CodeBlock code={`gssh user identity init [--force]
gssh user identity show [--fingerprint] [--json]`} multiLine language="bash" />

          <p className="text-zinc-500 text-sm mt-4">
            Identity storage: <code className="text-zinc-300">~/gitspace/.identity/</code>
          </p>

          <p className="text-zinc-400 mt-8 mb-4">
            Identity is encrypted at rest and requires an unlock password when used for remote connections.
          </p>
        </div>
      );

    case "access-control":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Owner Access Model</h1>

          <p className="text-zinc-400 mb-6">
            Runtime access is owner-only. Clients and machines must present device certificates derived from the same owner user root identity.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Connect from Another Owner Device</h3>
          <CodeBlock code={`gssh user identity recover
gssh client connect --machine <machine-id> --relay ws://relay.example.com/ws`} multiLine language="bash" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Enroll Machines with Root-Signed Invites</h3>
          <CodeBlock code={`gssh invite relay-machine create --relay ws://relay.example.com/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB>
gssh machine enroll --invite "ws://relay.example.com/ws#<TOKEN>" --label "My Machine"`} multiLine language="bash" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Identity Format</h3>
          <p className="text-zinc-400 mb-4 text-sm">
            Owner user root keys use this format:
          </p>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 font-mono text-sm text-green-400 break-all">
            gssh-user:&lt;BASE64_SIGNING_PUBLIC_KEY&gt;
          </div>
        </div>
      );

    case "configuration":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Configuration</h1>

          <h3 className="text-xl font-semibold text-white mb-4">Global Config</h3>
          <p className="text-zinc-500 text-sm mb-2">~/gitspace/.config.json</p>
          <JsonBlock code={`{
  "currentProject": "my-app",
  "projectsDir": "/Users/username/gitspace",
  "defaultBaseBranch": "main"
}`} />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Project Config</h3>
          <p className="text-zinc-500 text-sm mb-2">~/gitspace/&lt;project&gt;/.config.json</p>
          <JsonBlock code={`{
  "name": "my-app",
  "repository": "myorg/my-app",
  "baseBranch": "main"
}`} />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Environment Variables</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400 mb-8">
              <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
                <tr>
                  <th className="px-4 py-3">Variable</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Default</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">RELAY_PORT</td>
                  <td className="px-4 py-3">Relay port</td>
                  <td className="px-4 py-3">4480</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      );

    case "troubleshooting":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Troubleshooting</h1>

          <div className="space-y-8">
            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"command not found: gssh"</h4>
              <p className="text-zinc-400 text-sm mb-2">Ensure Bun's global bin is in your PATH:</p>
              <CodeBlock code={`export PATH="$HOME/.bun/bin:$PATH"`} />
              <p className="text-zinc-500 text-sm">Add to your shell profile (<code className="text-zinc-300">~/.zshrc</code>, <code className="text-zinc-300">~/.bashrc</code>)</p>
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"No identity found"</h4>
              <CodeBlock code="gssh user identity init" />
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"Failed to unlock identity"</h4>
              <p className="text-zinc-400 text-sm mb-2">You're entering the wrong password. If forgotten, recreate:</p>
              <CodeBlock code="gssh user identity init --force" />
              <p className="text-zinc-500 text-sm">Warning: This invalidates existing owner identity bindings and requires re-enrollment/recovery across devices</p>
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"Machine offline"</h4>
              <ul className="list-disc list-inside text-zinc-400 text-sm space-y-1 ml-2">
                <li>Ensure <code className="text-zinc-300">gssh machine serve start --foreground</code> is running on the target machine</li>
                <li>Check the machine can reach the relay URL</li>
                <li>Verify the machine is authorized on the relay</li>
              </ul>
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"Client not authorized"</h4>
              <p className="text-zinc-400 text-sm mb-2">The client identity does not match the relay/machine owner identity:</p>
              <CodeBlock code={`gssh user identity show
gssh user identity recover`} multiLine language="bash" />
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"Enrollment invite expired"</h4>
              <p className="text-zinc-400 text-sm mb-2">Create a new machine enrollment invite with longer expiration:</p>
              <CodeBlock code="gssh invite relay-machine create --relay ws://relay.example.com/ws --machine-signing-key <BASE64_ED25519_PUB> --machine-key-exchange-key <BASE64_X25519_PUB> --expires 7d" />
            </div>

            <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50">
              <h4 className="text-white font-bold mb-2">"GitHub CLI not authenticated"</h4>
              <CodeBlock code="gh auth login" />
            </div>
          </div>
        </div>
      );

    case "security":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Security</h1>

          <div className="space-y-8">
            <div className="p-6 rounded-xl bg-green-500/5 border border-green-500/20">
              <h3 className="font-bold text-green-400 mb-2">End-to-End Encrypted</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Terminal traffic encrypted with AES-256-GCM. Relay cannot decrypt.
              </p>
            </div>

            <div className="p-6 rounded-xl bg-blue-500/5 border border-blue-500/20">
              <h3 className="font-bold text-blue-400 mb-2">Cryptographic Identity</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Ed25519 signing + X25519 key exchange. No passwords for authentication.
              </p>
            </div>

            <div className="p-6 rounded-xl bg-purple-500/5 border border-purple-500/20">
              <h3 className="font-bold text-purple-400 mb-2">X3DH Handshake</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Session keys derived per-connection for forward secrecy.
              </p>
            </div>

            <div className="p-6 rounded-xl bg-yellow-500/5 border border-yellow-500/20">
              <h3 className="font-bold text-yellow-500 mb-3">Current Limitations</h3>
              <ul className="list-disc list-inside space-y-3 text-zinc-400 text-sm leading-relaxed">
                <li>
                  <strong className="text-white">Client proof-of-possession</strong>: The handshake doesn't fully enforce that the client possesses the private key corresponding to their claimed public key. If an attacker learns an allowed public key, identity spoofing is theoretically possible.
                </li>
                <li>
                  <strong className="text-white">Permission enforcement</strong>: Permission flags (<code className="text-zinc-300">read</code>/<code className="text-zinc-300">write</code>/<code className="text-zinc-300">manage</code>) are not fully enforced server-side after the handshake completes. "View-only" access should be treated as intended behavior rather than a strict security guarantee.
                </li>
              </ul>
              <p className="text-zinc-500 text-sm mt-4">These limitations are being addressed in future releases.</p>
            </div>
          </div>
        </div>
      );

    case "glossary":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Glossary</h1>

          <dl className="grid gap-6">
            <div>
              <dt className="text-white font-bold mb-1">Machine</dt>
              <dd className="text-zinc-400 text-sm">Device running <code className="text-zinc-300">gssh machine serve start --foreground</code></dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Client</dt>
              <dd className="text-zinc-400 text-sm">Device connecting via browser or CLI</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Relay</dt>
              <dd className="text-zinc-400 text-sm">WebSocket router that forwards encrypted traffic between machines and clients</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Relay Identity</dt>
              <dd className="text-zinc-400 text-sm">Ed25519 keypair used by the relay to sign messages and challenges</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Authorized Machine</dt>
              <dd className="text-zinc-400 text-sm">Machine public key approved to register with a relay</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Identity</dt>
              <dd className="text-zinc-400 text-sm">Ed25519 signing + X25519 key exchange keypairs, encrypted at rest</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Invite</dt>
              <dd className="text-zinc-400 text-sm">Signed token that bootstraps trust and enables first connection</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Owner Identity Binding</dt>
              <dd className="text-zinc-400 text-sm">Runtime rule requiring client and machine device certificates to derive from the same owner user root identity</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">X3DH</dt>
              <dd className="text-zinc-400 text-sm">Extended Triple Diffie-Hellman handshake for session key establishment</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">PTY</dt>
              <dd className="text-zinc-400 text-sm">Pseudo-terminal, the interface between your shell and the terminal</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Worktree</dt>
              <dd className="text-zinc-400 text-sm">Git feature allowing multiple working directories for one repository</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Bundle</dt>
              <dd className="text-zinc-400 text-sm">Repository configuration package for team onboarding</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Session</dt>
              <dd className="text-zinc-400 text-sm">A terminal session managed by tmux-lite on the server</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Web app</dt>
              <dd className="text-zinc-400 text-sm">The interactive surface, started with <code className="text-zinc-300">gssh web</code> or <code className="text-zinc-300">gssh machine serve start</code></dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">tmux-lite</dt>
              <dd className="text-zinc-400 text-sm">Built-in terminal multiplexer for managing sessions</dd>
            </div>
            <div>
              <dt className="text-white font-bold mb-1">Subdomain</dt>
              <dd className="text-zinc-400 text-sm">Your custom URL on gitspace.sh (e.g., <code className="text-zinc-300">yourname.gitspace.sh</code>)</dd>
            </div>
          </dl>
        </div>
      );

    case "linear-integration":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Linear Integration</h1>

          <p className="text-zinc-400 mb-8">
            GitSpace integrates with Linear to create workspaces directly from issues. Configure Linear at the user level,
            then optionally customize per-project.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4">Setup</h3>
          <p className="text-zinc-400 mb-4">
            Run the setup wizard to configure your Linear API key and select teams:
          </p>
          <CodeBlock code="gssh user config linear setup" />

          <p className="text-zinc-400 mb-4">
            The wizard will:
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Prompt for your Linear API key (stored securely in OS keychain)</li>
            <li>Fetch available teams from Linear</li>
            <li>Let you select which teams to work with</li>
            <li>Set a default team for new projects</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Project-Level Configuration</h3>
          <p className="text-zinc-400 mb-4">
            Configure Linear for a specific project:
          </p>
          <CodeBlock code="gssh user config linear setup --project myapp" />

          <p className="text-zinc-400 mb-4">
            You can choose to:
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><strong className="text-zinc-300">Use user-level API key</strong> - Inherit from your global config and select which teams to use</li>
            <li><strong className="text-zinc-300">Use project-specific API key</strong> - Enter a different API key for this project (useful for different Linear workspaces)</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Commands</h3>
          <CodeBlock code={`gssh user config linear setup                 # User-level setup wizard
gssh user config linear setup --project app   # Project-specific config (key + teams)
gssh user config linear show                  # Show user-level config
gssh user config linear show --project app    # Show project config
gssh user config linear clear                 # Clear user-level config
gssh user config linear clear --project app   # Clear project config (including API key)`} multiLine language="bash" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Creating Workspaces from Issues</h3>
          <p className="text-zinc-400 mb-4">
            Once configured, you can create workspaces from Linear issues:
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Run <code className="text-zinc-300">gssh workspace add --project my-project</code> and select "Create from Linear issue" at the source prompt</li>
          </ul>

          <p className="text-zinc-400 mb-4">
            The workspace will be named using the issue identifier and title, and issue details will be saved
            to <code className="text-zinc-300">.prompt/issue.md</code> in the workspace.
          </p>

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Getting Your API Key</h3>
          <p className="text-zinc-400 mb-4">
            To get your Linear API key:
          </p>
          <ol className="list-decimal list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>Go to Linear → Settings → API</li>
            <li>Under "Personal API keys", click "Create key"</li>
            <li>Give it a name (e.g., "GitSpace")</li>
            <li>Copy the key and paste it when prompted by <code className="text-zinc-300">gssh user config linear setup</code></li>
          </ol>
        </div>
      );

    default:
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h1 className="text-4xl font-bold mb-6">Documentation</h1>
            <p className="text-zinc-400">Select a section from the sidebar to get started.</p>
        </div>
      );
  }
}
