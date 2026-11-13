import type { HumblerApi } from "../shared/api";

declare global {
  interface Window {
    humbler: HumblerApi;
  }
}

export {};
