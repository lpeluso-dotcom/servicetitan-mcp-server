import type { Env } from './env';
import { hasConfiguredSecret, timingSafeEqual, type AuthResult, type Role } from './auth';

const BEARER_RE = /^bearer\s+(\S+)\s*$/i;

export async function resolvePublicAuth(request: Request, env: Env): Promise<AuthResult> {
  
  
  const header = request.headers.get('authorization') ?? '';
  const token = BEARER_RE.exec(header)?.[1] ?? '';
  if (!token || !hasConfiguredSecret(env.MCP_TOKEN) || !(await timingSafeEqual(token, env.MCP_TOKEN))) {
    return { authenticated: false, role: 'default', actor: 'anonymous', authMode: 'none' };
  }

  const role: Role =
    env.MCP_LOCKDOWN === 'true'
      ? 'lockdown'
      : env.MCP_TOKEN_ROLE === undefined || env.MCP_TOKEN_ROLE === 'default'
        ? 'default'
        : env.MCP_TOKEN_ROLE === 'readonly'
          ? 'readonly'
          : 'readonly'; 

  return { authenticated: true, role, actor: 'mcp-token', principal: 'mcp-token', authMode: 'mcp-token' };
}
