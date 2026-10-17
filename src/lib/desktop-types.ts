/**
 * 桌面版(.exe)外壳通过 preload 暴露的接口。
 * 在普通浏览器里 window.virtualdeskDesktop 是 undefined。
 */

export interface DesktopLanCandidate {
  address: string;
  label: string;
}

export interface DesktopState {
  phase: 'starting' | 'database' | 'server' | 'ready' | 'error';
  message: string;
  error: string | null;
  url: string | null;
  lanCandidates: DesktopLanCandidate[];
  lanUrl: string | null;
  databaseUrl: string | null;
  logsDir: string | null;
  userDataDir?: string;
  version?: string;
  isPackaged?: boolean;
}

export interface VirtualDeskDesktopBridge {
  isDesktop: true;
  getInfo: () => Promise<DesktopState>;
  openExternal: (url: string) => Promise<boolean>;
  openDataDir: () => Promise<string>;
  copyText: (text: string) => Promise<boolean>;
  relaunch: () => Promise<void>;
  onState: (callback: (state: DesktopState) => void) => () => void;
}

declare global {
  interface Window {
    virtualdeskDesktop?: VirtualDeskDesktopBridge;
    /**
     * 由 C# 宿主在返回 HTML 时注入:
     *   __VIRTUALDESK_API_BASE__ —— 接口所在的绝对地址(宿主挂在随机端口上)
     *   __VIRTUALDESK_HOST__     —— 值为 'desktop' 表示由单文件 exe 托管
     */
    __VIRTUALDESK_API_BASE__?: string;
    __VIRTUALDESK_HOST__?: string;
  }
}

export {};
