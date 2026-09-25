import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getStAccessToken, clearStTokenCache, invalidateStAccessToken, setMintTimeoutMsForTest } from '../st-oauth';

const ENV = { ST_CLIENT_ID: 'cid', ST_CLIENT_SECRET: 'csecret' };

function tokenResponse(token: string, expiresIn = 900): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getStAccessToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearStTokenCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setMintTimeoutMsForTest(null);
  });

  it('mints with client credentials against the production auth host', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-1'));
    await expect(getStAccessToken(ENV)).resolves.toBe('tok-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.servicetitan.io/connect/token');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'csecret',
    });
  });

  it('uses the integration auth host when ST_ENV=integration', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-int'));
    await getStAccessToken({ ...ENV, ST_ENV: 'integration' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://auth-integration.servicetitan.io/connect/token');
  });

  it('reuses the cached token until 60s before expiry, then re-mints', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-1', 900)).mockResolvedValueOnce(tokenResponse('tok-2', 900));
    expect(await getStAccessToken(ENV)).toBe('tok-1');
    vi.setSystemTime(new Date('2026-09-25T12:13:59.000Z')); 
    expect(await getStAccessToken(ENV)).toBe('tok-1');
    vi.setSystemTime(new Date('2026-09-25T12:14:01.000Z')); 
    expect(await getStAccessToken(ENV)).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-mints when the client id changes', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-a')).mockResolvedValueOnce(tokenResponse('tok-b'));
    expect(await getStAccessToken(ENV)).toBe('tok-a');
    expect(await getStAccessToken({ ...ENV, ST_CLIENT_ID: 'other' })).toBe('tok-b');
  });

  it('shares one in-flight mint between concurrent callers', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-shared'));
    const [a, b] = await Promise.all([getStAccessToken(ENV), getStAccessToken(ENV)]);
    expect([a, b]).toEqual(['tok-shared', 'tok-shared']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight entry when the mint rejects, so the next caller mints again', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(tokenResponse('tok-retry'));
    await expect(getStAccessToken(ENV)).rejects.toThrow('network down');
    await expect(getStAccessToken(ENV)).resolves.toBe('tok-retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds the mint to its own timeout, independent of any caller signal, so a hung fetch cannot wedge future callers', async () => {
    setMintTimeoutMsForTest(5);
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new DOMException('mint timed out', 'TimeoutError')));
        }),
    );
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-after-timeout'));
    await expect(getStAccessToken(ENV)).rejects.toThrow();
    await expect(getStAccessToken(ENV)).resolves.toBe('tok-after-timeout');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    
    
    const firstInit = fetchMock.mock.calls[0][1];
    expect(firstInit.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed on a non-200 without echoing the secret', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"invalid_client","detail":"csecret"}', { status: 401 }));
    const err = await getStAccessToken(ENV).catch((e) => e);
    expect(err).toMatchObject({ code: 'upstream_error' });
    expect(String(err.message)).toContain('HTTP 401');
    expect(String(err.message)).not.toContain('csecret');
  });

  it('refuses to call ServiceTitan when credentials are missing, with a config_error — clear message, never masked', async () => {
    await expect(getStAccessToken({ ST_CLIENT_ID: '', ST_CLIENT_SECRET: 'x' })).rejects.toMatchObject({
      code: 'config_error',
      message: expect.stringContaining('ST_CLIENT_ID'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the 200 response body is not valid JSON, without echoing it', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json, csecret leaked here', { status: 200 }));
    const err = await getStAccessToken(ENV).catch((e) => e);
    expect(err).toMatchObject({ code: 'upstream_error' });
    expect(String(err.message)).not.toContain('csecret');
    expect(String(err.message)).not.toContain('leaked');
  });
});

describe('invalidateStAccessToken', () => {
  beforeEach(() => {
    clearStTokenCache();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('evicts the cached token for this credential so the next call re-mints', async () => {
    const fetchMock = vi.fn(async () => tokenResponse('tok-1'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getStAccessToken(ENV)).toBe('tok-1');
    invalidateStAccessToken(ENV);
    fetchMock.mockResolvedValueOnce(tokenResponse('tok-2'));
    expect(await getStAccessToken(ENV)).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves a different credential\'s cached token alone', async () => {
    const fetchMock = vi.fn(async () => tokenResponse('tok-a'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getStAccessToken(ENV)).toBe('tok-a');
    invalidateStAccessToken({ ...ENV, ST_CLIENT_ID: 'other-client' });
    expect(await getStAccessToken(ENV)).toBe('tok-a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
