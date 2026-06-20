/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STELIS_RELAY_API_URL: string;
  readonly VITE_REPO_DOCS_BASE_URL: string;
  /** UI mode: 'relay' (default) = public relay pages | 'studio' = enables /promotion */
  readonly VITE_STELIS_UI_MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
