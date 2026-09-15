import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  image: { type: 'string' }, id: { type: 'string' }, operator: { type: 'string', default: 'https://api.gitspace.sh' },
  account: { type: 'string' }, application: { type: 'string' }, cancel: { type: 'boolean' },
}, strict: true });
const id = values.id ?? crypto.randomUUID();
const accessToken = process.env.GITSPACE_OPERATOR_ACCESS_JWT;
if (!accessToken) throw new Error('GITSPACE_OPERATOR_ACCESS_JWT is required (Cloudflare Access operator identity)');
const operator = new URL(values.operator!);
if (operator.protocol !== 'https:') throw new Error('Operator URL must use HTTPS');
async function operatorRequest(action: string, body: Record<string, unknown>) {
  const response = await fetch(new URL(`/v1/operator/sandboxes/rollout/${action}`, operator), {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': accessToken! }, body: JSON.stringify(body),
  });
  const result = await response.json() as { status?: string; error?: { message?: string } };
  if (!response.ok || result.status !== 'ok') throw new Error(result.error?.message ?? `Operator ${action} failed (HTTP ${response.status})`);
}
if (values.cancel) {
  if (!values.id) throw new Error('--cancel requires the existing --id');
  await operatorRequest('cancel', { id });
  console.log(`Cancelled container rollout ${id}`);
} else {
  const image = values.image;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = values.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!image || !/^registry\.cloudflare\.com\/[a-f0-9]+\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/u.test(image)) throw new Error('--image must be an already-published immutable Cloudflare registry image');
  if (!token || !account || !values.application) throw new Error('CLOUDFLARE_API_TOKEN, --account and --application are required');
  const root = resolve(import.meta.dir, '..');
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-rollout-'));
  const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  delete config.$schema;
  config.main = resolve(root, config.main);
  for (const container of config.containers) container.image = image;
  const configPath = join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config));
  try {
    console.log(`Preparing durable checkpoints for rollout ${id}`);
    await operatorRequest('prepare', { id, image });
    const child = Bun.spawn(['bunx', 'wrangler', 'deploy', '--config', configPath, '--containers-rollout=immediate'], { cwd: root, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
    if (await child.exited !== 0) throw new Error('Provider deployment failed; the admission barrier remains active');
    const api = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/containers/applications/${encodeURIComponent(values.application)}`;
    const deadline = Date.now() + 20 * 60_000;
    let applied = false;
    while (Date.now() < deadline) {
      const responses = await Promise.all([fetch(api, { headers: { authorization: `Bearer ${token}` } }), fetch(`${api}/instances`, { headers: { authorization: `Bearer ${token}` } })]);
      if (responses.some(response => !response.ok)) throw new Error('Cannot verify provider rollout; admission barrier remains active');
      const [application, instances] = await Promise.all(responses.map(response => response.json())) as [
        { success: boolean; result: { configuration: { image: string } } },
        { success: boolean; result: { instances: Array<{ image: string; status: { state: string } }> }; result_info?: { cursor?: string; cursors?: { after?: string } } },
      ];
      if (!application.success || !instances.success) throw new Error('Provider returned an unsuccessful rollout query');
      if (instances.result_info?.cursor || instances.result_info?.cursors?.after) throw new Error('Instance listing is paginated; cannot prove complete rollout');
      applied = application.result.configuration.image === image && instances.result.instances.every(instance => instance.status.state === 'inactive' || (instance.status.state === 'running' && instance.image === image));
      if (applied) break;
      await Bun.sleep(2_000);
    }
    if (!applied) throw new Error('Provider image did not converge; admission barrier remains active');
    await operatorRequest('finish', { id, image });
    console.log(`Container rollout ${id} applied and machine recovery started`);
  } catch (error) {
    console.error(`Rollout ${id} is not complete. Inspect provider state before retrying or using --cancel --id ${id}.`);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
