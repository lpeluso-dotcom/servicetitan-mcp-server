import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createDirectBackend,stApiUrl } from '../direct';
import { clearStTokenCache,getStAccessToken } from '../st-oauth';
const env={ST_TENANT_ID:'123',ST_CLIENT_ID:'fixture',ST_CLIENT_SECRET:'fixture-secret',ST_APP_KEY:'fixture-app'};
beforeEach(()=>clearStTokenCache());afterEach(()=>vi.unstubAllGlobals());
describe('credential destination confinement',()=>{
 it.each(['/crm/v2/tenant/456/customers','//example.com/crm/v2/tenant/123/customers','/crm/v2/tenant/123/../../456/customers','/crm/v2/tenant/123/%2e%2e/customers','/crm/v2/tenant/123/customers#fragment','/other/api','/crm/v2/tenant/123/customers\\x'])('refuses %s before fetching credentials',async endpoint=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const result=await createDirectBackend(env).fetch(`https://st-backend.invalid/api/st/read?endpoint=${encodeURIComponent(endpoint)}`);
  expect(result.status).toBe(400);expect(fetch).not.toHaveBeenCalled();
 });
 it('retains safe query encoding and only the configured tenant',()=>{
  expect(stApiUrl(env,'/crm/v2/tenant/000000000/customers?name=A%20B')?.pathname).toBe('/crm/v2/tenant/123/customers');
 });
 it('refuses credentialed API redirects without following them',async()=>{
  const fetch=vi.fn(async(url:string,init:RequestInit)=>{
   expect(init.redirect).toBe('manual');
   return url.endsWith('/connect/token')?Response.json({access_token:'test-token',expires_in:900}):new Response(null,{status:307,headers:{location:'https://example.com/collect'}});
  });vi.stubGlobal('fetch',fetch);
  await expect(createDirectBackend(env).fetch('https://st-backend.invalid/api/st/read?endpoint=%2Fcrm%2Fv2%2Ftenant%2F123%2Fcustomers')).rejects.toThrow(/redirect refused/);
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('refuses OAuth redirects and does not reuse tokens after secret rotation',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:307,headers:{location:'https://example.com/collect'}})).mockResolvedValueOnce(Response.json({access_token:'old',expires_in:900})).mockResolvedValueOnce(Response.json({access_token:'new',expires_in:900}));vi.stubGlobal('fetch',fetch);
  await expect(getStAccessToken(env)).rejects.toThrow(/307/);expect(fetch.mock.calls[0][1].redirect).toBe('manual');
  expect(await getStAccessToken(env)).toBe('old');expect(await getStAccessToken({...env,ST_CLIENT_SECRET:'rotated-fixture'})).toBe('new');
  expect(fetch).toHaveBeenCalledTimes(3);
 });
});

it('bounds a write response before wrapping it in JSON',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(Response.json({access_token:'test-token',expires_in:900})).mockResolvedValueOnce(new Response('x'.repeat(1_048_577)));
 vi.stubGlobal('fetch',fetch);
 await expect(createDirectBackend(env).fetch('https://st-backend.invalid/api/st/write',{method:'POST',body:JSON.stringify({endpoint:'/crm/v2/tenant/123/customers/42',method:'PATCH',payload:{name:'Fixture'}})})).rejects.toThrow(/byte limit/);
 expect(fetch).toHaveBeenCalledTimes(2);
});
