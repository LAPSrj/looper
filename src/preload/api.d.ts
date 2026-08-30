import type { LooperApi } from '../shared/api';

declare global {
  interface Window {
    looper: LooperApi;
  }
}

export {};
