export type StBackendName = 'direct';

export interface BackendEnv {
  
  ST_BACKEND?: string;
  
  ST_TRANSPORT?: Fetcher;
  
  ST_CLIENT_ID?: string;
  
  ST_CLIENT_SECRET?: string;
  
  ST_APP_KEY?: string;
  
  ST_ENV?: string;
}
