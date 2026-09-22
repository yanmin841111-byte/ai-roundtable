import { createElement, ArrowUp, Check, Download, FileDiff, Folder, Pause, Play, RotateCcw, Settings, Square, SquarePen, Terminal, Paperclip, RefreshCw, ClipboardList, CircleHelp } from 'lucide';

const icons = { send: ArrowUp, accept: Check, export: Download, diff: FileDiff, folder: Folder, pause: Pause, start: Play, revert: RotateCcw, settings: Settings, stop: Square, new: SquarePen, terminal: Terminal, attach: Paperclip, refresh: RefreshCw, result: ClipboardList, incomplete: CircleHelp };
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