import { z } from 'zod';

const ProviderErrorBodySchema = z.object({
  error: z.union([z.object({ type: z.string().optional(), message: z.string().optional(), code: z.string().nullable().optional() }), z.string()]).optional(),
  message: z.string().optional(),
  detail: z.string().optional(),
});

/** What to do about a provider refusal, by HTTP status and the provider's error type. */
function nextStep(status: number, type: string, message: string): string {
  if (status === 401 || status === 403 || /authentication|permission/u.test(type)) return 'Sign in to this provider again under Inference → Providers.';
  if (/fast mode/iu.test(message)) return 'Turn off Fast mode in the agent controls, or add usage credits to the account.';
  if (status === 429 || /rate_limit|quota/u.test(type)) return 'Wait for the limit to reset, or choose another model or account.';
  if (status === 404 || /not_found/u.test(type)) return 'This account cannot use the model; choose another model.';
  if (status === 529 || status >= 500 || /overloaded|api_error|server/u.test(type)) return 'The provider is failing or overloaded; send the message again shortly.';
  return '';
}

/** A provider's raw error (`429 {"type":"error","error":{...}}`) as one plain sentence and the next step. Anything else
 * is returned unchanged. */
export function providerErrorText(raw: string): string {
  const match = /^(\d{3})\s+(\{[\s\S]*\})\s*$/u.exec(raw.trim());
  if (!match) return raw;
  let parsed: z.infer<typeof ProviderErrorBodySchema>;
  try { parsed = ProviderErrorBodySchema.parse(JSON.parse(match[2]!)); } catch { return raw; }
  const status = Number(match[1]);
  const error = typeof parsed.error === 'string' ? { message: parsed.error } : parsed.error;
  const message = (error?.message ?? parsed.message ?? parsed.detail ?? '').trim();
  const type = `${typeof parsed.error === 'object' ? parsed.error.type ?? '' : ''} ${typeof parsed.error === 'object' ? parsed.error.code ?? '' : ''}`;
  const sentence = message ? (/[.!?]$/u.test(message) ? message : `${message}.`) : `The provider refused the request (HTTP ${status}).`;
  const step = nextStep(status, type, message);
  return step ? `${sentence} ${step}` : sentence;
}
