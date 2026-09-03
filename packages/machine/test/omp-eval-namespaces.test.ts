import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'bun:test';
import { disposeVmContextsByOwner } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/eval/js/context-manager.ts';
import { executeJs } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/eval/js/executor.ts';
import { resolveLocalUrlToPath } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/internal-urls/local-protocol.ts';
import { EvalTool } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/tools/eval.ts';
import { buildManagedKernelEnvPatch } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/eval/executor-base.ts';

const roots: string[] = [];
const owners: string[] = [];

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => disposeVmContextsByOwner(owner)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function toolSession(cwd: string) {
  return {
    cwd,
    settings: { get: () => undefined },
  } as never;
}

async function run(
  code: string,
  artifacts: string,
  namespaces: Record<string, { declaration: string; call(method: string, args: unknown): Promise<unknown> }>,
  mounts: Record<string, 'read' | 'write'> = { base: 'read', workspace: 'write' },
) {
  const owner = crypto.randomUUID();
  owners.push(owner);
  return executeJs(code, {
    cwd: artifacts,
    sessionId: `eval:${owner}`,
    kernelOwnerId: owner,
    session: toolSession(artifacts),
    localRoots: { local: artifacts },
    localPolicies: { local: mounts },
    evalNamespaces: namespaces,
  });
}

describe('GitSpace OMP eval extensions', () => {
  it('runs Space and MCP calls in one persistent JavaScript eval surface', async () => {
    const artifacts = await mkdtemp(join(tmpdir(), 'gitspace-eval-'));
    roots.push(artifacts);
    const calls: string[] = [];
    const namespaces = {
      space: {
        declaration: '{ current(): Promise<unknown> }',
        call: async (method: string) => {
          calls.push(`space.${method}`);
          return { projectId: 'project-a', spaceId: 'workspace-a' };
        },
      },
      mcp: {
        declaration: '{ list(): Promise<unknown[]> }',
        call: async (method: string) => {
          calls.push(`mcp.${method}`);
          return [{ name: 'linear.search' }];
        },
      },
    };
    const result = await run('const current = await space.current(); const tools = await mcp.list(); display({ current, tools });', artifacts, namespaces);
    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result.displayOutputs)).toContain('project-a');

    expect(JSON.stringify(result.displayOutputs)).toContain('linear.search');
    expect(calls).toEqual(['space.current', 'mcp.list']);
  });
  it('advertises host namespace declarations on the normal eval tool', () => {
    const evalTool = new EvalTool({
      settings: { get: () => undefined },
      getSessionSpawns: () => '*',
      localProtocolOptions: {
        getEvalNamespaces: () => ({
          space: { declaration: '{ current(): Promise<unknown> }', call: async () => ({}) },
          mcp: { declaration: '{ list(): Promise<unknown[]> }', call: async () => [] },
        }),
      },
    } as never);
    expect(evalTool.description).toContain('declare const space: { current(): Promise<unknown> };');
    expect(evalTool.description).toContain('declare const mcp: { list(): Promise<unknown[]> };');
  });

  it('lets workspace eval read base and write workspace but rejects base and unknown writes', async () => {
    const artifacts = await mkdtemp(join(tmpdir(), 'gitspace-eval-'));
    roots.push(artifacts);
    await mkdir(join(artifacts, 'base'), { recursive: true });
    await mkdir(join(artifacts, 'workspace'), { recursive: true });
    await writeFile(join(artifacts, 'base', 'seed.txt'), 'seed', 'utf8');

    const namespaces = {};
    const allowed = await run('const seed = await read("local://base/seed.txt"); await write("local://workspace/result.txt", `${seed}-ok`);', artifacts, namespaces);
    expect(allowed.exitCode).toBe(0);
    expect(await readFile(join(artifacts, 'workspace', 'result.txt'), 'utf8')).toBe('seed-ok');

    const baseDenied = await run('await write("local://base/blocked.txt", "no")', artifacts, namespaces);
    expect(baseDenied.exitCode).toBe(1);
    expect(baseDenied.output).toContain('local://base/ is read-only');

    const unknownDenied = await run('await write("local://other/blocked.txt", "no")', artifacts, namespaces);
    expect(unknownDenied.exitCode).toBe(1);
    expect(unknownDenied.output).toContain('outside the authorized artifact mounts');
  });

  it('lets project eval write base artifacts and rejects workspace artifacts', async () => {
    const artifacts = await mkdtemp(join(tmpdir(), 'gitspace-eval-'));
    roots.push(artifacts);
    await mkdir(join(artifacts, 'base'), { recursive: true });
    await mkdir(join(artifacts, 'workspace'), { recursive: true });

    const allowed = await run('await write(\"local://base/result.txt\", \"project\")', artifacts, {}, { base: 'write' });
    expect(allowed.exitCode).toBe(0);
    expect(await readFile(join(artifacts, 'base', 'result.txt'), 'utf8')).toBe('project');

    const workspaceDenied = await run('await write("local://workspace/blocked.txt", "no")', artifacts, {}, { base: 'write' });
    expect(workspaceDenied.exitCode).toBe(1);
    expect(workspaceDenied.output).toContain('outside the authorized artifact mounts');
  });

  it('applies the same mount policy at host local URL resolution', () => {
    const options = {
      getArtifactsDir: () => '/tmp/gitspace-artifacts',
      getLocalMounts: () => ({ base: 'read' as const, workspace: 'write' as const }),
    };
    expect(resolveLocalUrlToPath('local://base/report.txt', options)).toBe('/tmp/gitspace-artifacts/base/report.txt');
    expect(() => resolveLocalUrlToPath('local://base/report.txt', options, process.platform, 'write')).toThrow('read-only');
    expect(() => resolveLocalUrlToPath('local://other/report.txt', options)).toThrow('outside the authorized artifact mounts');
  });

  it('threads mount policy into retained Python, Ruby, and Julia kernels', () => {
    const patch = buildManagedKernelEnvPatch({
      localRoots: { local: '/tmp/gitspace-artifacts' },
      localPolicies: { local: { base: 'read', workspace: 'write' } },
    });
    expect(JSON.parse(patch.PI_EVAL_LOCAL_POLICIES!)).toEqual({ local: { base: 'read', workspace: 'write' } });
  });
});
