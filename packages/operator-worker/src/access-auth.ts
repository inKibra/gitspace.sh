import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';

export interface AccessIdentity {
  email: string;
  subject: string;
}

export interface AccessConfiguration {
  teamDomain: string;
  audience: string;
  operatorEmail: string;
}

function normalizedTeamDomain(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com') || url.pathname !== '/') {
    throw new Error('Cloudflare Access team domain is invalid');
  }
  return url.origin;
}

export async function verifyAccessToken(
  token: string,
  configuration: AccessConfiguration,
  keyResolver?: JWTVerifyGetKey,
): Promise<AccessIdentity> {
  const issuer = normalizedTeamDomain(configuration.teamDomain);
  if (!configuration.audience.trim()) throw new Error('Cloudflare Access audience is missing');
  const resolver = keyResolver ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const verified = await jwtVerify(token, resolver, {
    issuer,
    audience: configuration.audience,
    algorithms: ['RS256'],
  });
  return identityFromPayload(verified.payload, configuration.operatorEmail);
}

function identityFromPayload(payload: JWTPayload, operatorEmail: string): AccessIdentity {
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const expected = operatorEmail.trim().toLowerCase();
  if (!email || !expected || email !== expected) throw new Error('Cloudflare Access identity is not an authorized operator');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Cloudflare Access subject is missing');
  return { email, subject: payload.sub };
}

export async function operatorIdentity(request: Request, env: Env): Promise<AccessIdentity | null> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OPERATOR_EMAIL) return null;
  try {
    return await verifyAccessToken(token, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      operatorEmail: env.OPERATOR_EMAIL,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'operator-access-denied',
      reason: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}
