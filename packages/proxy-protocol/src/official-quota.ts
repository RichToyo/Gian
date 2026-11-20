import { z } from 'zod';

const text = z.string().max(256).regex(/^[^\u0000-\u001f\u007f]*$/u);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().regex(/^-?\d{1,30}(?:\.\d{1,12})?$/u);

/** Credential-free payload shared by native normalizers and the quota RPC.
 * Data alone is not proof that an installed Runtime/account is qualified. */
export const officialQuotaDataSchema = z.strictObject({
  windows: z.array(z.strictObject({
    id: text, label: text, usedRatio: z.number().min(0).max(1).nullable(),
    resetAt: integer.nullable(), windowDurationMinutes: integer.nullable(),
  })).max(64),
  balances: z.array(z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/u), total: decimal,
    granted: decimal.nullable(), toppedUp: decimal.nullable(),
  })).max(16),
});
export type ProxyOfficialQuotaData = z.infer<typeof officialQuotaDataSchema>;
export type ProxyOfficialQuotaWindow = ProxyOfficialQuotaData['windows'][number];
export type ProxyOfficialQuotaBalance = ProxyOfficialQuotaData['balances'][number];
export function isProxyOfficialQuotaData(value: unknown): value is ProxyOfficialQuotaData {
  return officialQuotaDataSchema.safeParse(value).success;
}

export const officialQuotaReadParamsSchema = z.strictObject({
  model: text.nullable(),
  provider: text.nullable(),
  /** Random per Host lifetime; not a Provider credential. */
  identityNonce: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type OfficialQuotaReadParams = z.infer<typeof officialQuotaReadParamsSchema>;

/** Account identity is an opaque digest, never a credential or account profile. */
export const officialQuotaReadResultSchema = officialQuotaDataSchema.extend({
  /** A separately signed-in CLI account, not the bound session Runtime.
   * No stable account identity is exported; failures must discard old values. */
  source: z.literal('cli').optional(),
  status: z.enum(['ready', 'auth_required', 'unsupported', 'excluded', 'error']),
  authRevision: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  error: z.enum(['unavailable', 'auth_required', 'rate_limited', 'timeout', 'invalid_response']).nullable(),
}).superRefine((value, context) => {
  const hasData = value.windows.length + value.balances.length > 0;
  if (value.status === 'ready'
    ? (!value.authRevision && value.source !== 'cli') || !hasData || value.error !== null
    : hasData || (value.status === 'error' ? value.error === null : value.error !== null)) {
    context.addIssue({ code: 'custom', message: 'Invalid official quota state' });
  }
  if (value.source === 'cli' && value.authRevision !== null) {
    context.addIssue({ code: 'custom', message: 'CLI snapshot must not assert a Runtime account identity' });
  }
});
export type ProxyOfficialQuotaReadResult = z.infer<typeof officialQuotaReadResultSchema>;
export function isProxyOfficialQuotaReadResult(value: unknown): value is ProxyOfficialQuotaReadResult {
  return officialQuotaReadResultSchema.safeParse(value).success;
}
