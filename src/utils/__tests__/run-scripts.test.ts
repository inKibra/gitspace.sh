/**
 * Tests for run-scripts.ts
 * Specifically testing the nonInteractive mode that prevents script blocking
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { runScriptsInTerminal, discoverScripts } from '../run-scripts';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('runScriptsInTerminal', () => {
  let testDir: string;
  let scriptsDir: string;
  let workspacePath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `run-scripts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    scriptsDir = join(testDir, 'scripts');
    workspacePath = join(testDir, 'workspace');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('discoverScripts', () => {
    it('should discover executable scripts in directory', () => {
      const script1 = join(scriptsDir, '01-first.sh');
      const script2 = join(scriptsDir, '02-second.sh');
      const nonExec = join(scriptsDir, 'readme.txt');

      writeFileSync(script1, '#!/bin/bash\necho "first"');
      writeFileSync(script2, '#!/bin/bash\necho "second"');
      writeFileSync(nonExec, 'not executable');

      chmodSync(script1, 0o755);
      chmodSync(script2, 0o755);
      // nonExec stays non-executable

      const scripts = discoverScripts(scriptsDir);
      expect(scripts).toHaveLength(2);
      expect(scripts[0]).toContain('01-first.sh');
      expect(scripts[1]).toContain('02-second.sh');
    });

    it('should return empty array for non-existent directory', () => {
      const scripts = discoverScripts('/non/existent/path');
      expect(scripts).toEqual([]);
    });

    it('should return scripts in alphabetical order', () => {
      const scriptZ = join(scriptsDir, 'z-last.sh');
      const scriptA = join(scriptsDir, 'a-first.sh');
      const scriptM = join(scriptsDir, 'm-middle.sh');

      writeFileSync(scriptZ, '#!/bin/bash\necho "z"');
      writeFileSync(scriptA, '#!/bin/bash\necho "a"');
      writeFileSync(scriptM, '#!/bin/bash\necho "m"');

      chmodSync(scriptZ, 0o755);
      chmodSync(scriptA, 0o755);
      chmodSync(scriptM, 0o755);

      const scripts = discoverScripts(scriptsDir);
      expect(scripts[0]).toContain('a-first.sh');
      expect(scripts[1]).toContain('m-middle.sh');
      expect(scripts[2]).toContain('z-last.sh');
    });
  });

  describe('nonInteractive mode', () => {
    it('should not block when script tries to read stdin', async () => {
      // Create a script that tries to read from stdin with a timeout
      // In interactive mode with no input, this would wait for the timeout
      // In non-interactive mode, stdin is closed so read gets EOF immediately
      const scriptPath = join(scriptsDir, '01-read-stdin.sh');
      writeFileSync(scriptPath, `#!/bin/bash
# Try to read from stdin - should get EOF immediately in non-interactive mode
if read -t 5 input 2>/dev/null; then
  echo "Got input: $input"
else
  echo "No input (stdin closed or timeout)"
fi
exit 0
`);
      chmodSync(scriptPath, 0o755);

      // This should complete quickly without blocking for 5 seconds
      const startTime = Date.now();
      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
      });
      const elapsed = Date.now() - startTime;

      // Should complete in well under 5 seconds (the read timeout)
      // Give it 2 seconds max for script startup overhead
      expect(elapsed).toBeLessThan(2000);
    });

    it('should complete successfully for simple scripts', async () => {
      const scriptPath = join(scriptsDir, '01-simple.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "Running cleanup for $1 in $2"
exit 0
`);
      chmodSync(scriptPath, 0o755);

      // Should not throw
      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
      });
    });

    it('should throw on script failure', async () => {
      const scriptPath = join(scriptsDir, '01-fail.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "About to fail"
exit 1
`);
      chmodSync(scriptPath, 0o755);

      await expect(
        runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
          nonInteractive: true,
        })
      ).rejects.toThrow(/Script failed with exit code 1/);
    });

    it('should pass workspace name and repository as arguments', async () => {
      // Create a script that writes its arguments to a file
      const outputFile = join(testDir, 'args.txt');
      const scriptPath = join(scriptsDir, '01-check-args.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "$1" > "${outputFile}"
echo "$2" >> "${outputFile}"
`);
      chmodSync(scriptPath, 0o755);

      await runScriptsInTerminal(scriptsDir, workspacePath, 'my-workspace', 'owner/repo', {
        nonInteractive: true,
      });

      const output = await Bun.file(outputFile).text();
      const lines = output.trim().split('\n');
      expect(lines[0]).toBe('my-workspace');
      expect(lines[1]).toBe('owner/repo');
    });

    it('should set working directory to workspace path', async () => {
      const outputFile = join(testDir, 'cwd.txt');
      const scriptPath = join(scriptsDir, '01-check-cwd.sh');
      writeFileSync(scriptPath, `#!/bin/bash
pwd > "${outputFile}"
`);
      chmodSync(scriptPath, 0o755);

      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
      });

      const output = await Bun.file(outputFile).text();
      // On macOS, /var is a symlink to /private/var, so we need to handle both
      const actualCwd = output.trim();
      const expectedCwd = workspacePath;
      // Either direct match or with /private prefix (macOS symlink)
      expect(
        actualCwd === expectedCwd ||
        actualCwd === `/private${expectedCwd}` ||
        expectedCwd === `/private${actualCwd}`
      ).toBe(true);
    });

    it('should run scripts in alphabetical order', async () => {
      const outputFile = join(testDir, 'order.txt');

      // Create scripts out of order
      const script3 = join(scriptsDir, '03-third.sh');
      const script1 = join(scriptsDir, '01-first.sh');
      const script2 = join(scriptsDir, '02-second.sh');

      writeFileSync(script3, `#!/bin/bash\necho "third" >> "${outputFile}"`);
      writeFileSync(script1, `#!/bin/bash\necho "first" >> "${outputFile}"`);
      writeFileSync(script2, `#!/bin/bash\necho "second" >> "${outputFile}"`);

      chmodSync(script3, 0o755);
      chmodSync(script1, 0o755);
      chmodSync(script2, 0o755);

      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
      });

      const output = await Bun.file(outputFile).text();
      const lines = output.trim().split('\n');
      expect(lines).toEqual(['first', 'second', 'third']);
    });

    it('should stop on first script failure', async () => {
      const outputFile = join(testDir, 'stopped.txt');

      const script1 = join(scriptsDir, '01-success.sh');
      const script2 = join(scriptsDir, '02-fail.sh');
      const script3 = join(scriptsDir, '03-never-runs.sh');

      writeFileSync(script1, `#!/bin/bash\necho "1" >> "${outputFile}"`);
      writeFileSync(script2, `#!/bin/bash\necho "2" >> "${outputFile}"\nexit 1`);
      writeFileSync(script3, `#!/bin/bash\necho "3" >> "${outputFile}"`);

      chmodSync(script1, 0o755);
      chmodSync(script2, 0o755);
      chmodSync(script3, 0o755);

      await expect(
        runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
          nonInteractive: true,
        })
      ).rejects.toThrow();

      const output = await Bun.file(outputFile).text();
      const lines = output.trim().split('\n');
      // Script 3 should never have run
      expect(lines).toEqual(['1', '2']);
    });
  });

  describe('interactive mode (default)', () => {
    it('should run scripts successfully', async () => {
      const scriptPath = join(scriptsDir, '01-simple.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "Running in interactive mode"
exit 0
`);
      chmodSync(scriptPath, 0o755);

      // Should not throw - default is interactive mode
      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo');
    });
  });

  describe('environment variables', () => {
    it('should pass bundle values as SPACE_VALUE_* env vars', async () => {
      const outputFile = join(testDir, 'env.txt');
      const scriptPath = join(scriptsDir, '01-env.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "$SPACE_VALUE_API_KEY" >> "${outputFile}"
echo "$SPACE_VALUE_DATABASE_URL" >> "${outputFile}"
`);
      chmodSync(scriptPath, 0o755);

      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
        bundleValues: {
          'api-key': 'my-api-key',
          'database_url': 'postgres://localhost/db',
        },
      });

      const output = await Bun.file(outputFile).text();
      const lines = output.trim().split('\n');
      expect(lines[0]).toBe('my-api-key');
      expect(lines[1]).toBe('postgres://localhost/db');
    });

    it('should pass bundle secrets as SPACE_SECRET_* env vars', async () => {
      const outputFile = join(testDir, 'secrets.txt');
      const scriptPath = join(scriptsDir, '01-secrets.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "$SPACE_SECRET_TOKEN" >> "${outputFile}"
`);
      chmodSync(scriptPath, 0o755);

      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
        bundleSecrets: {
          'token': 'super-secret-token',
        },
      });

      const output = await Bun.file(outputFile).text();
      expect(output.trim()).toBe('super-secret-token');
    });
  });

  describe('no scripts', () => {
    it('should complete successfully when no scripts exist', async () => {
      // scriptsDir exists but is empty
      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
      });
      // Should not throw
    });

    it('should complete successfully when scripts dir does not exist', async () => {
      const nonExistentDir = join(testDir, 'non-existent-scripts');
      await runScriptsInTerminal(nonExistentDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
      });
      // Should not throw
    });
  });

  describe('onOutput callback', () => {
    it('should call onOutput with script stdout in nonInteractive mode', async () => {
      const scriptPath = join(scriptsDir, '01-output.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "Hello from script"
echo "Line 2"
`);
      chmodSync(scriptPath, 0o755);

      const chunks: Buffer[] = [];
      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
        onOutput: (data) => chunks.push(data),
      });

      const output = Buffer.concat(chunks).toString();
      expect(output).toContain('Hello from script');
      expect(output).toContain('Line 2');
    });

    it('should call onOutput with script stderr in nonInteractive mode', async () => {
      const scriptPath = join(scriptsDir, '01-stderr.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "Error message" >&2
`);
      chmodSync(scriptPath, 0o755);

      const chunks: Buffer[] = [];
      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: true,
        onOutput: (data) => chunks.push(data),
      });

      const output = Buffer.concat(chunks).toString();
      expect(output).toContain('Error message');
    });

    it('should not call onOutput in interactive mode (stdio: inherit)', async () => {
      const scriptPath = join(scriptsDir, '01-simple.sh');
      writeFileSync(scriptPath, `#!/bin/bash
echo "Output"
`);
      chmodSync(scriptPath, 0o755);

      const chunks: Buffer[] = [];
      await runScriptsInTerminal(scriptsDir, workspacePath, 'test-workspace', 'test/repo', {
        nonInteractive: false, // Interactive mode
        onOutput: (data) => chunks.push(data),
      });

      // In interactive mode, stdio is inherited, so onOutput won't be called
      expect(chunks).toHaveLength(0);
    });
  });
});
