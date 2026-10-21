// Test double for the OAUTH_FLOW_STATE Durable Object namespace. State lives in
// the same plain-object store the KV stubs use, under `<kind>:<name>` keys.
// `names` records every idFromName call, so a test can prove a request never
// reached the Durable Object.
export function oauthFlowStateStub(store: Record<string, unknown>) {
  const names: string[] = [];
  return {
    names,
    idFromName: (name: string) => { names.push(name); return name; },
    get: (name: string) => ({
      putState: async (kind: 'login' | 'approve', payload: string) => {
        store[`${kind}:${name}`] = JSON.parse(payload);
      },
      readState: async (kind: 'login' | 'approve') => {
        const value = store[`${kind}:${name}`];
        return value === undefined ? null : JSON.stringify(value);
      },
      consumeState: async (kind: 'login' | 'approve') => {
        const key = `${kind}:${name}`;
        const value = store[key];
        delete store[key];
        return value === undefined ? null : JSON.stringify(value);
      },
    }),
  };
}
