import { z } from 'zod';

export const MACHINE_PAIRING_TTL_MS = 10 * 60_000;
export const machinePairingTokenSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().regex(/^u-[a-f0-9]{32}$/u),
  pairingId: z.uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  apiUrl: z.string().url().max(2_048).refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }),
  expiresAt: z.number().int().positive(),
});
export type MachinePairingToken = z.infer<typeof machinePairingTokenSchema>;

/** Expiry is the server's: it set `expiresAt` from its clock and refuses a claim after it. Browser and machine clocks
 * differ from it, so neither side checks the time here (a machine 30 s slow refused every fresh token). */
export function encodeMachinePairingToken(input: MachinePairingToken): string {
  const value = machinePairingTokenSchema.parse(input);
  return `gsp_${btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

export function decodeMachinePairingToken(input: string): MachinePairingToken | null {
  if (!/^gsp_[A-Za-z0-9_-]{1,4096}$/u.test(input)) return null;
  try {
    const raw = input.slice(4).replaceAll('-', '+').replaceAll('_', '/');
    const parsed = machinePairingTokenSchema.safeParse(JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
