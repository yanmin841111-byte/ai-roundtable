import { createElement, ArrowUp, ArrowUpRight, Check, Cloud, Copy, Download, Ellipsis, Eye, EyeOff, FileDiff, Folder, FolderPlus, Pause, Play, Plus, RotateCcw, Settings, Square, SquarePen, Terminal, Paperclip, RefreshCw, ClipboardList, CircleHelp, X } from 'lucide';

const icons = { send: ArrowUp, external: ArrowUpRight, accept: Check, copy: Copy, export: Download, diff: FileDiff, folder: Folder, folderPlus: FolderPlus, pause: Pause, start: Play, plus: Plus, revert: RotateCcw, retry: RotateCcw, settings: Settings, stop: Square, new: SquarePen, terminal: Terminal, attach: Paperclip, refresh: RefreshCw, result: ClipboardList, incomplete: CircleHelp, more: Ellipsis, cloud: Cloud, show: Eye, hide: EyeOff, close: X };
export type IconName = keyof typeof icons;

export function icon(name: string): SVGElement {
  return createElement(icons[name as IconName] || CircleHelp, { width: 16, height: 16, 'stroke-width': 1.75, 'aria-hidden': 'true', focusable: 'false', class: 'ui-icon' });
}

export function controlLabel(control: HTMLElement, name: string, text: string): void {
  const label = document.createElement('span');
  label.className = 'control-label';
  label.textContent = text;
  control.replaceChildren(icon(name), label);
  control.setAttribute('aria-label', text);
  control.title = text;
}