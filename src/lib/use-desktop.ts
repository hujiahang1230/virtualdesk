'use client';

import { useEffect, useState } from 'react';

import type { DesktopState } from './desktop-types';

/**
 * 读取桌面版(.exe)外壳的状态。
 *
 * - 在浏览器里打开时返回 null,页面走原来的 Web 逻辑(用 /api/network 探测局域网地址)
 * - 在桌面版里返回主进程推送的状态,包含内置服务地址与局域网访问链接
 */
export function useDesktop(): DesktopState | null {
  const [state, setState] = useState<DesktopState | null>(null);

  useEffect(() => {
    const bridge = window.virtualdeskDesktop;
    if (!bridge) return;

    let cancelled = false;
    void bridge
      .getInfo()
      .then((info) => {
        if (!cancelled) setState(info);
      })
      .catch(() => {
        /* 拿不到就退回 Web 逻辑 */
      });

    const unsubscribe = bridge.onState((info) => {
      if (!cancelled) setState(info);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
