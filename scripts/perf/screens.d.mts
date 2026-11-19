export interface WindowScreen {
  name: string;
  hash: string;
  size?: [number, number];
  contentSize?: boolean;
  fits?: boolean;
  via?: 'mcp' | 'import-task' | 'import-template';
}
export interface MainScreen {
  name: string;
  tab: string;
  detail?: string;
  project?: boolean;
  /** After selecting the project: the project's tab to show (`last`: an addon's, after Looper's own). */
  projectTab?: 'last';
  chat?: boolean;
  terminal?: boolean;
  addon?: boolean;
}
export interface PhoneScreenEntry {
  name: string;
  tab: string;
  push?: string;
  taps?: (string | RegExp)[];
}
export const WINDOWS: WindowScreen[];
export const MAIN_SCREENS: MainScreen[];
export const PHONE_SCREENS: PhoneScreenEntry[];
export const PHONES: string[];
