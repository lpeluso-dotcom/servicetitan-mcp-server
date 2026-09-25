import type { Env } from './env';

type OAuthConfigEnv = Pick<Env, 'OAUTH_KV' | 'ACCESS_ISSUER' | 'ACCESS_CLIENT_ID' | 'ACCESS_CLIENT_SECRET' | 'ALLOWED_EMAILS'>;

function nonBlank(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function isOAuthConfigured(env: OAuthConfigEnv): boolean {
  return Boolean(
    env.OAUTH_KV &&
      nonBlank(env.ACCESS_ISSUER) &&
      nonBlank(env.ACCESS_CLIENT_ID) &&
      nonBlank(env.ACCESS_CLIENT_SECRET) &&
      nonBlank(env.ALLOWED_EMAILS),
  );
}
