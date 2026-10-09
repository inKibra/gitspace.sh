import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { readAdvertisedRefs, readCommitPack } from '../../runtime-workspace-do/src/artifacts-snapshot.js';

import { network } from './network.js';

const remote = 'https://origin.invalid/repository.git';
const commit = '1234567890abcdef1234567890abcdef12345678';
const packet = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;

describe('public Git transport in Workers', () => {
  it('discovers a public branch through the Workers fetch implementation', async () => {
    const advertisement = packet('# service=git-upload-pack\n') + '0000' + packet(`${commit} refs/heads/main\n`) + '0000';
    network.use(http.get(`${remote}/info/refs`, () => new HttpResponse(advertisement)));
    expect(await readAdvertisedRefs({ remote, token: null })).toEqual(new Map([['refs/heads/main', commit]]));
  });

  it.each(['discovery', 'pack'] as const)('rejects a %s redirect without contacting its destination', async operation => {
    let redirectedRequests = 0;
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
      ? readAdvertisedRefs({ remote, token: null })
      : readCommitPack({ remote, token: null, commit });
    await expect(result).rejects.toThrow(operation === 'discovery' ? 'Git discovery failed (302)' : 'Git fetch failed (302)');
    expect(redirectedRequests).toBe(0);
  });
});
