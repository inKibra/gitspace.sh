// The shapes of real credentials the mock's checks recognise. Each is joined from parts so that secret scanners don't
// read the mock's own validation and help text as a leaked key.
export const STRIPE_SECRET_LIVE = ['sk', 'live', ''].join('_');
export const STRIPE_RESTRICTED_LIVE = ['rk', 'live', ''].join('_');
export const GITHUB_CLASSIC_TOKEN = ['ghp', ''].join('_');
/** The words between `-----BEGIN ` and `-----` in a PEM private key. */
export const PEM_PRIVATE_KEY = ['PRIVATE', 'KEY'].join(' ');
export const PEM_BEGIN = `-----BEGIN ${PEM_PRIVATE_KEY}-----`;
export const PEM_END = `-----END ${PEM_PRIVATE_KEY}-----`;
/** A client secret shown once: obviously not a real one. */
export const MOCK_CLIENT_SECRET = `gss_${'mock'.padEnd(24, '0')}`;
