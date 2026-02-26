import { checkCommandExists } from './deps.js';

export async function isCloudflaredInstalled(): Promise<boolean> {
  return checkCommandExists('cloudflared');
}
