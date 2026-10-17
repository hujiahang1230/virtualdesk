'use client';

import { useCallback, useEffect, useState } from 'react';

interface CopyButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}

/** 复制到剪贴板的小按钮:优先用 Clipboard API,失败则退回到 execCommand */
export default function CopyButton({
  value,
  label = '复制',
  copiedLabel = '已复制 ✓',
  className = 'vd-btn',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    const ok = await copyText(value);
    setCopied(ok);
  }, [value]);

  return (
    <button type="button" className={className} onClick={copy} aria-live="polite">
      {copied ? copiedLabel : label}
    </button>
  );
}

async function copyText(text: string): Promise<boolean> {
  // 桌面版有主进程的剪贴板通道,比浏览器 API 更可靠
  try {
    if (window.virtualdeskDesktop?.copyText) {
      const ok = await window.virtualdeskDesktop.copyText(text);
      if (ok) return true;
    }
  } catch {
    /* 继续用下面的方式 */
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 非安全上下文或用户拒绝时走下面的兜底
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
