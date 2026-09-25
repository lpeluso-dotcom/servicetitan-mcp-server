export const ALLOWED_BROWSER_ORIGINS: ReadonlySet<string> = new Set([
  'https://claude.ai',
  'https://claude.com',
  'http://localhost:5173',   
  'http://127.0.0.1:5173',
  'http://localhost:6274',   
  'http://127.0.0.1:6274',
]);

export function corsOriginFor(request: Request): string {
  const origin = request.headers.get('origin');
  return origin && ALLOWED_BROWSER_ORIGINS.has(origin) ? origin : 'https://claude.ai';
}

const CORS_BASE = {
  methods: 'GET, POST, OPTIONS, DELETE',
  headers: 'content-type, mcp-session-id, authorization, x-actor, x-correlation-id',
  exposeHeaders: 'mcp-session-id',
  maxAge: 86400,
};

export function corsOptionsFor(request: Request) {
  return { ...CORS_BASE, origin: corsOriginFor(request) };
}
