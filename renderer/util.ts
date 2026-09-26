// Renderer 共用的小工具:查節點、數字與路徑的顯示、跳脫
import { localeTag } from './i18n';

// querySelector 在這個 app 裡查的都是 index.html 既有的節點,查不到就是程式寫錯。
// 保留原本「直接使用回傳值」的語意,型別由呼叫端以泛型指定。
export const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;

export function fmt(n: number): string { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
export function exactNumber(n: number): string { return Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 20 }); }
// 只留最後兩層,例如 /Users/me/projects/app → …/projects/app
export function shortPath(p: string): string {
  const parts = String(p).replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(p);
}
export function initials(name: string | undefined): string { return (name || '?').trim().slice(0, 1).toUpperCase(); }
export function escapeHtml(s: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, (c) => map[c]);
}
export function randomColor(): string { const c = ['#6c8cff', '#d97757', '#10a37f', '#c678dd', '#e5c07b', '#56b6c2', '#ff6b9d']; return c[Math.floor(Math.random() * c.length)]; }

// Electron 會把主程序錯誤包成 "Error invoking remote method 'x': Error: 訊息"
export function cleanIpcError(e: unknown): string {
  return String((e && (e as Error).message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function cssEscape(value: string): string {
  if (window.CSS && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/"/g, '\\"');
}

interface ResizeOptions {
  axis: 'x' | 'y';
  // 往右或往下拖時尺寸變大用 1,往左或往上變大用 -1
  direction: 1 | -1;
  get: () => number;
  apply: (size: number) => number;
  save: (size: number) => void;
  reset: () => void;
  step?: number;
}

export function bindResizeHandle(handle: HTMLElement, { axis, direction, get, apply, save, reset, step = 24 }: ResizeOptions): void {
  const coordinate = (event: PointerEvent) => axis === 'x' ? event.clientX : event.clientY;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = coordinate(event);
    const startSize = get();
    try { handle.setPointerCapture(event.pointerId); } catch {}
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (next: PointerEvent) => apply(startSize + (coordinate(next) - start) * direction);
    const end = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing-x', 'resizing-y');
      save(get());
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  });
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', (event) => {
    const keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (event.key === 'Home' || event.key === 'Enter') { event.preventDefault(); reset(); return; }
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const grow = event.key === keys[1] ? direction : -direction;
    save(apply(get() + grow * step));
  });
}
