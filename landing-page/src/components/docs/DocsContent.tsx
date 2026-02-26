import { Terminal, Copy, Check } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../../app/components/ui/badge";

function CodeBlock({ code, language = "bash", multiLine = false }: { code: string; language?: string; multiLine?: boolean }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = code.split('\n');

  return (
    <div className="relative mt-4 mb-6 group">
      <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button
            onClick={onCopy}
            className="p-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
        >
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 overflow-x-auto font-mono text-sm leading-relaxed">
        {multiLine ? (
          lines.map((line, i) => (
            <div key={i} className="flex">
              {language === 'bash' && line.trim() && !line.startsWith('#') && !line.startsWith('//') && (
                <span className="text-zinc-500 select-none mr-2">$</span>
              )}
              <span className={line.startsWith('#') || line.startsWith('//') ? "text-zinc-500" : "text-zinc-300"}>{line}</span>
            </div>
          ))
        ) : (
          <>
            {language === 'bash' && <span className="text-zinc-500 select-none mr-2">$</span>}
            <span className="text-zinc-300">{code}</span>
          </>
        )}
      </div>
    </div>
  );
}

function JsonBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative mt-4 mb-6 group">
      <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button
            onClick={onCopy}
            className="p-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
        >
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 overflow-x-auto font-mono text-sm leading-relaxed">
        <pre className="text-zinc-300">{code}</pre>
      </div>
    </div>
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
            <li>Interactive TUI for visual workspace management</li>
            <li>Convention-based scripts for automation</li>
            <li>Team onboarding via repo config bundles</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Remote Access</h3>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li>E2E encrypted terminal access from any browser or CLI</li>
            <li>Zero-trust relay: routes traffic but cannot decrypt content</li>
            <li>Identity-based auth using Ed25519/X25519 cryptographic keys</li>
            <li>Instant hosting via gitspace.sh subdomains</li>
          </ul>
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

# Authenticate GitHub
gh auth login

# Launch TUI
gssh

# Or via CLI:
gssh project add    # Add a GitHub repo
gssh workspace add my-feature --project my-project # Create a workspace`} multiLine />
        </div>
      );

    case "installation":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">Installation</h1>

          <h3 className="text-xl font-semibold text-white mb-4">Prerequisites</h3>
          <p className="text-zinc-400 mb-4">Required:</p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><a href="https://git-scm.com/" className="text-green-400 hover:underline">Git</a> - Version control</li>
            <li><a href="https://cli.github.com/" className="text-green-400 hover:underline">GitHub CLI</a> - <code className="text-zinc-300">gh auth login</code> before using GitSpace</li>
            <li><a href="https://stedolan.github.io/jq/" className="text-green-400 hover:underline">jq</a> - JSON processing</li>
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

    case "tui-interface":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">TUI Interface</h1>

          <p className="text-zinc-400 mb-4">Launch the TUI with no arguments:</p>
          <CodeBlock code="gssh" />

          <p className="text-zinc-400 mb-8">
            The TUI provides a two-panel interface:
          </p>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-8 ml-2">
            <li><strong className="text-white">Left panel</strong>: Your projects</li>
            <li><strong className="text-white">Right panel</strong>: Workspaces in the selected project</li>
          </ul>

          <h3 className="text-xl font-semibold text-white mb-4">Key Bindings</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400 mb-8">
              <thead className="text-xs text-zinc-500 uppercase bg-zinc-900">
                <tr>
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">Enter</td>
                  <td className="px-4 py-3">Select project / Open workspace</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">Tab</td>
                  <td className="px-4 py-3">Switch between panels</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">n</td>
                  <td className="px-4 py-3">New project / workspace</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">d</td>
                  <td className="px-4 py-3">Delete selected item</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">?</td>
                  <td className="px-4 py-3">Show help</td>
                </tr>
                <tr className="border-b border-zinc-800">
                  <td className="px-4 py-3 font-mono text-green-400">q</td>
                  <td className="px-4 py-3">Quit</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      );

    case "cli-commands":
      return (
        <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-4xl font-bold mb-6">CLI Commands</h1>

          <h3 className="text-xl font-semibold text-white mb-4">Projects</h3>
          <CodeBlock code={`gssh project add              # Add from GitHub (interactive)
gssh project add --org myorg  # Filter by organization
gssh workspace list --project myapp     # List workspaces in a project
gssh project list            # List all projects
gssh project remove myapp     # Remove a project`} multiLine language="bash" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Workspaces</h3>
          <CodeBlock code={`gssh workspace add my-feature --project my-project           # Create workspace
gssh workspace add --from develop --project my-project       # Create from specific branch
gssh workspace context --project my-project --workspace my-feature        # Show workspace context
gssh workspace list --project <project-name>                     # List workspaces
gssh workspace remove my-feature --project my-project`} multiLine language="bash" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Other Commands</h3>
          <CodeBlock code={`gssh project list   # List projects
gssh status         # Show daemon statuses`} multiLine language="bash" />

          <h3 className="text-xl font-semibold text-white mb-4 mt-8">Command Options</h3>

          <h4 className="text-lg font-medium text-zinc-300 mb-3">Options for <code className="text-green-400">gssh project add</code></h4>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-6 ml-2 text-sm">
            <li><code className="text-zinc-300">--bundle-url &lt;url&gt;</code> - Load bundle from remote URL (zip archive)</li>
            <li><code className="text-zinc-300">--bundle-path &lt;path&gt;</code> - Load bundle from local directory</li>
            <li><code className="text-zinc-300">--skip-bundle</code> - Skip bundle detection and onboarding</li>
            <li><code className="text-zinc-300">--no-clone</code> - Create project structure without cloning</li>
            <li><code className="text-zinc-300">--org &lt;org&gt;</code> - Filter repos to specific organization</li>
          </ul>

          <h4 className="text-lg font-medium text-zinc-300 mb-3">Options for <code className="text-green-400">gssh workspace add [workspace-name] --project &lt;project-name&gt;</code></h4>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-6 ml-2 text-sm">
            <li><code className="text-zinc-300">--branch &lt;name&gt;</code> - Specify different branch name from workspace name</li>
            <li><code className="text-zinc-300">--from &lt;branch&gt;</code> - Create from specific branch instead of base</li>
            <li><code className="text-zinc-300">--no-setup</code> - Skip setup commands</li>
          </ul>

          <h4 className="text-lg font-medium text-zinc-300 mb-3">Options for <code className="text-green-400">gssh workspace remove [workspace-name] --project &lt;project-name&gt;</code></h4>
          <ul className="list-disc list-inside space-y-2 text-zinc-400 mb-6 ml-2 text-sm">
            <li><code className="text-zinc-300">--force</code> - Skip confirmation prompts</li>
            <li><code className="text-zinc-300">--keep-branch</code> - Don't delete git branch when removing</li>
          </ul>
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
              <dt className="text-white font-bold mb-1">TUI</dt>
              <dd className="text-zinc-400 text-sm">Terminal User Interface, the interactive <code className="text-zinc-300">gssh</code> interface</dd>
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
            <li>In the TUI, select "Create from Linear issue" when adding a workspace</li>
            <li>Or use the CLI: <code className="text-zinc-300">gssh workspace add --project my-project</code> and select "Create from Linear issue"</li>
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
