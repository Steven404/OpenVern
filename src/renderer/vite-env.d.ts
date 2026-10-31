/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` selects the in-memory `MockApiClient`. */
  readonly VITE_API?: 'mock' | 'http';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
