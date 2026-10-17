import { env } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAdvertisedRefs, transferCommit, type GitHttpAuth } from '../../runtime-workspace-do/src/artifacts-snapshot.js';
import { remoteDefaultBranch } from '../src/cloud-project.js';
import { GitHubAppDO } from '../src/github-app.js';

import { network } from './network.js';

afterEach(() => vi.restoreAllMocks());

const remote = 'https://origin.invalid/repository.git';
const artifacts = 'https://artifacts.invalid/project-covered.git';
const commit = '1234567890abcdef1234567890abcdef12345678';
const zero = '0'.repeat(40);
const packet = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;
const installation: GitHttpAuth = { kind: 'basic', username: 'x-access-token', password: 'ghs_installation' };
const basic = `Basic ${btoa('x-access-token:ghs_installation')}`;

describe('public Git transport in Workers', () => {
  it('discovers a public branch through the Workers fetch implementation', async () => {
    const advertisement = packet('# service=git-upload-pack\n') + '0000' + packet(`${commit} refs/heads/main\n`) + '0000';
    network.use(http.get(`${remote}/info/refs`, ({ request }) => {
      expect(request.headers.get('authorization')).toBeNull();
      return new HttpResponse(advertisement);
    }));
    expect(await readAdvertisedRefs({ remote, auth: null })).toEqual(new Map([['refs/heads/main', commit]]));
  });

  it.each(['discovery', 'pack'] as const)('rejects a %s redirect without contacting its destination', async operation => {
    let redirectedRequests = 0;
    if (operation === 'pack') network.use(http.get(`${remote}/info/refs`, () => new HttpResponse(packet(`${commit} refs/heads/main\n`) + '0000')));
    network.use(
      http.get('https://redirected.invalid/repository.git', () => {
        redirectedRequests++;
        return new HttpResponse('');
      }),
      (operation === 'discovery' ? http.get : http.post)(
        `${remote}/${operation === 'discovery' ? 'info/refs' : 'git-upload-pack'}`,
        () => HttpResponse.redirect('https://redirected.invalid/repository.git', 302),
      ),
    );
    const result = operation === 'discovery'
      ? readAdvertisedRefs({ remote, auth: installation })
      : transferCommit({ source: { remote, auth: installation }, destination: { remote: artifacts, auth: { kind: 'bearer', token: 'artifacts-write' } }, ref: 'refs/heads/main', previous: null, commit });
    await expect(result).rejects.toThrow(operation === 'discovery' ? 'Git discovery failed (302)' : 'Git fetch failed (302)');
    expect(redirectedRequests).toBe(0);
  });

  it('streams an origin pack into Artifacts with Basic origin credentials on discovery and pack requests', async () => {
    const pack = new Uint8Array([...new TextEncoder().encode('PACK'), 0, 0, 0, 2, 0, 0, 0, 0, ...new Uint8Array(20).fill(7)]);
    const sideband = new Uint8Array([...new TextEncoder().encode((pack.length + 5).toString(16).padStart(4, '0')), 1, ...pack]);
    const requests: string[] = [];
    let pushed = new Uint8Array(0);
    network.use(
      http.get(`${remote}/info/refs`, ({ request }) => {
        requests.push(`origin discovery ${request.headers.get('authorization')}`);
        return new HttpResponse(packet('# service=git-upload-pack\n') + '0000' + packet('version 2\n') + packet('fetch=shallow\n') + '0000');
      }),
      http.post(`${remote}/git-upload-pack`, async ({ request }) => {
        requests.push(`origin pack ${request.headers.get('authorization')}`);
        expect(await request.text()).toContain(`want ${commit}\n`);
        return new HttpResponse(new Blob([packet('packfile\n'), sideband, '0000']));
      }),
      http.get(`${artifacts}/info/refs`, ({ request }) => {
        requests.push(`artifacts discovery ${request.headers.get('authorization')}`);
        return new HttpResponse(packet(`${zero} capabilities^{}\0report-status\n`) + '0000');
      }),
      http.post(`${artifacts}/git-receive-pack`, async ({ request }) => {
        requests.push(`artifacts push ${request.headers.get('authorization')}`);
        pushed = new Uint8Array(await request.arrayBuffer());
        return new HttpResponse(packet('unpack ok\n') + packet('ok refs/heads/main\n') + '0000');
      }),
    );
    await transferCommit({ source: { remote, auth: installation }, destination: { remote: artifacts, auth: { kind: 'bearer', token: 'artifacts-write' } }, ref: 'refs/heads/main', previous: null, commit });
    expect(requests).toEqual([
      `origin discovery ${basic}`, `origin pack ${basic}`,
      'artifacts discovery Bearer artifacts-write', 'artifacts push Bearer artifacts-write',
    ]);
    // The push carries the ref command, then exactly the demultiplexed pack bytes.
    expect(new TextDecoder().decode(pushed)).toContain(`${zero} ${commit} refs/heads/main\0report-status\n`);
    expect(pushed.subarray(pushed.length - pack.length)).toEqual(pack);
  });
});

describe('origin default branch', () => {
  const advertisement = packet('# service=git-upload-pack\n') + '0000' + packet(`${commit} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/github\n`) + '0000';

  it('asks a covered repository only with its installation token', async () => {
    vi.spyOn(GitHubAppDO.prototype, 'coverage').mockReturnValue(91);
    const tokens = vi.spyOn(GitHubAppDO.prototype, 'repositoryToken').mockResolvedValue({ token: 'ghs_installation', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const authorizations: Array<string | null> = [];
    network.use(http.get('https://github.com/acme/private.git/info/refs', ({ request }) => {
      authorizations.push(request.headers.get('authorization'));
      return new HttpResponse(advertisement);
    }));
    expect(await remoteDefaultBranch(env, 'git@github.com:acme/private.git')).toBe('trunk');
    expect(authorizations).toEqual([basic]);
    expect(tokens).toHaveBeenCalledWith('acme/private', 'read');
  });

  it('asks an uncovered repository without credentials', async () => {
    const tokens = vi.spyOn(GitHubAppDO.prototype, 'repositoryToken');
    const authorizations: Array<string | null> = [];
    network.use(http.get('https://github.com/octocat/Hello-World.git/info/refs', ({ request }) => {
      authorizations.push(request.headers.get('authorization'));
      return new HttpResponse(advertisement);
    }));
    expect(await remoteDefaultBranch(env, 'https://github.com/octocat/Hello-World.git')).toBe('trunk');
    expect(authorizations).toEqual([null]);
    expect(tokens).not.toHaveBeenCalled();
  });
});
