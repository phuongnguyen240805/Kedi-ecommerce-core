import { z } from 'zod';
import { ghnProvider } from './ghn-shipping';
import {
  ShippingError,
  shippingConfiguration,
  policySchema,
  type ShippingEnv,
  type ShippingProvider,
  type QuoteEngineConfig,
  type ShippingConfig,
} from './smart-shipping';

const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
export const carrierAccountSchema = z
  .object({
    id: key,
    carrier_id: z.literal('ghn'),
    execution_owner: z.enum(['pancake', 'direct']),
    enabled: z.boolean(),
    verified: z.boolean(),
    warehouse_id: z.string().min(1).max(100),
    environment: z.enum(['production', 'staging']),
    shop_id: z.number().int().positive(),
    from_district_id: z.number().int().positive(),
    from_ward_code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
    capabilities: z
      .array(
        z.enum([
          'quote',
          'create',
          'read',
          'cancel',
          'address',
          'cod',
          'return',
          'redelivery',
        ]),
      )
      .max(8),
    cod: z.boolean().default(false),
    allowed_district_ids: z.array(z.number().int().positive()).max(1000).optional(),
    max_weight_g: z.number().int().positive().max(50000),
    pancake_partner_id: z.number().int().positive().optional(),
    pancake_account_id: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.execution_owner !== 'pancake' ||
      (!!a.pancake_partner_id && !!a.pancake_account_id),
    'Pancake-owned accounts require verified POS partner and account IDs',
  );
export type CarrierAccount = z.infer<typeof carrierAccountSchema>;
export type CarrierEnv = ShippingEnv & {
  CARRIER_REGISTRY_JSON?: string;
  CARRIER_SECRETS_JSON?: string;
  PANCAKE_WAREHOUSE_ID?: string;
  PANCAKE_GHN_ACCOUNT_ID?: string;
};

// Public registry never contains credentials. Disabled accounts remain resolvable
// for reconciliation of labels which were already created.
export function carrierAccounts(env: CarrierEnv): CarrierAccount[] {
  if (!env.CARRIER_REGISTRY_JSON) return [];
  try {
    const accounts = z
      .array(carrierAccountSchema)
      .min(1)
      .max(20)
      .parse(JSON.parse(env.CARRIER_REGISTRY_JSON));
    if (new Set(accounts.map((a) => a.id)).size !== accounts.length) throw Error();
    return accounts;
  } catch {
    throw new ShippingError(
      'carrier_registry_invalid',
      503,
      'Cấu hình tài khoản vận chuyển không hợp lệ.',
    );
  }
}
export function carrierConfiguration(
  env: CarrierEnv,
  account: CarrierAccount,
): ShippingConfig {
  try {
    const secrets = z
      .record(
        z.string(),
        z
          .object({
            token: z.string().min(8),
            webhook_secret: z.string().min(24).optional(),
          })
          .strict(),
      )
      .parse(JSON.parse(env.CARRIER_SECRETS_JSON || ''));
    const token = secrets[account.id]?.token;
    if (!token) throw Error();
    const policy = policySchema.parse(JSON.parse(env.SMART_SHIPPING_POLICY || ''));
    return {
      token,
      shop_id: account.shop_id,
      from_district_id: account.from_district_id,
      from_ward_code: account.from_ward_code,
      environment: account.environment,
      policy,
    };
  } catch {
    throw new ShippingError(
      'carrier_credentials_missing',
      503,
      'Chưa cấu hình riêng thông tin xác thực tài khoản vận chuyển.',
    );
  }
}
export function carrierWebhookSecret(env: CarrierEnv, id: string): string | undefined {
  try {
    const secret = JSON.parse(env.CARRIER_SECRETS_JSON || '{}')[id]?.webhook_secret;
    return typeof secret === 'string' && secret.length >= 24 ? secret : undefined;
  } catch {
    return undefined;
  }
}
export function shippingLocationConfiguration(env: CarrierEnv) {
  if (!env.CARRIER_REGISTRY_JSON) return shippingConfiguration(env);
  const account = carrierAccounts(env).find(
    (a) =>
      a.enabled &&
      a.verified &&
      a.warehouse_id === env.PANCAKE_WAREHOUSE_ID &&
      a.capabilities.includes('quote'),
  );
  if (!account)
    throw new ShippingError(
      'carrier_unavailable',
      503,
      'Chưa có tài khoản vận chuyển cho danh mục địa chỉ.',
    );
  return carrierConfiguration(env, account);
}
export function shippingQuoteSetup(env: CarrierEnv): {
  config: QuoteEngineConfig;
  providers: ShippingProvider[];
} {
  if (!env.CARRIER_REGISTRY_JSON) {
    const config = shippingConfiguration(env);
    return { config, providers: [ghnProvider] };
  }
  if (env.SMART_SHIPPING_ENABLED !== 'true')
    throw new ShippingError('shipping_disabled', 503, 'Smart Shipping chưa được bật.');
  let policy;
  try {
    policy = policySchema.parse(JSON.parse(env.SMART_SHIPPING_POLICY || ''));
  } catch {
    throw new ShippingError(
      'shipping_policy_missing',
      503,
      'Chưa cấu hình quy cách kiện hàng và thời hạn giao.',
    );
  }
  const accounts = carrierAccounts(env).filter(
    (a) =>
      a.enabled &&
      a.verified &&
      a.warehouse_id === env.PANCAKE_WAREHOUSE_ID &&
      a.capabilities.includes('quote') &&
      a.capabilities.includes('read') &&
      (a.execution_owner === 'pancake'
        ? a.pancake_account_id === Number(env.PANCAKE_GHN_ACCOUNT_ID)
        : a.capabilities.includes('create')),
  );
  if (!accounts.length)
    throw new ShippingError(
      'carrier_unavailable',
      503,
      'Chưa có tài khoản vận chuyển được xác minh cho kho.',
    );
  const environments = new Set(accounts.map((a) => a.environment));
  if (environments.size !== 1)
    throw new ShippingError(
      'carrier_environment_mixed',
      503,
      'Không trộn báo giá staging và production.',
    );
  const config: QuoteEngineConfig = {
    policy,
    environment: accounts[0].environment,
    registry_identity: accounts,
  };
  const providers = accounts.map(
    (account) =>
      ({
        code: account.id,
        async quote(context) {
          if (
            (context.request.payment_method === 'cod' && !account.cod) ||
            context.parcel.weight_g > account.max_weight_g ||
            (account.allowed_district_ids &&
              !account.allowed_district_ids.includes(
                context.request.destination.district_id,
              ))
          )
            return {
              offers: [],
              warnings: [{ provider: account.id, code: 'account_ineligible' }],
            };
          const result = await ghnProvider.quote({
            ...context,
            config: carrierConfiguration(env, account),
          });
          return {
            ...result,
            warnings: result.warnings.map((w) => ({ ...w, provider: account.id })),
            offers: result.offers.map((o) => ({
              ...o,
              id: `${o.provider}:${account.id}:${o.service_type_id}`,
              account_id: account.id,
              execution_owner: account.execution_owner,
              service_id: String(o.service_type_id),
              ...(account.execution_owner === 'pancake'
                ? {
                    pos_account_id: account.pancake_account_id,
                    pos_partner_id: account.pancake_partner_id,
                  }
                : {}),
              account_binding: {
                shop_id: account.shop_id,
                warehouse_id: account.warehouse_id,
                from_district_id: account.from_district_id,
                from_ward_code: account.from_ward_code,
              },
            })),
          };
        },
      }) satisfies ShippingProvider,
  );
  return { config, providers };
}
