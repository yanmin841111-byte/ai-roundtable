import { report, runApp } from '../app';
import { scriptedMember } from '../fixtures';

async function main() {
  const payload = [
    '<style>#settings-btn { display: none !important }</style>',
    '<div id="settings-btn" style="position:fixed" onclick="alert(1)">unsafe attributes</div>',
    '<form><input autofocus><button>Fake control</button></form>',
    '<iframe src="about:blank"></iframe>',
    '[Unsafe](healthcheck-demo://noop) [Script](javascript:alert%281%29)',
    '[Website](https://example.com) **Readable**',
    '```html\n<style>example only</style>\n```',
  ].join('\n\n');
  const result = await runApp({
    members: [scriptedMember({ id: 'author', name: 'Author', report: payload })],
    timeoutMs: 45000,
    constants: { payload },
    scenario: async (context: any) => {
      const app: any = globalThis;
      await app.ready();
      await app.send(`@Author ${context.payload}`, 'discuss');
      const bodies = Array.from(document.querySelectorAll('#timeline .body'));
      app.check(bodies.length >= 2, 'User and AI Markdown rendered');
      for (const body of bodies) {
        app.check(!body.querySelector('style,script,form,input,button,iframe,[style],[onclick],[id]'), 'Untrusted controls and attributes removed');
        app.check(!Array.from(body.querySelectorAll('a[href]')).some((link) => !/^(https?:\/\/|mailto:)/i.test(link.getAttribute('href') || '')), 'Unsafe protocols removed');
      }
      app.check(getComputedStyle(document.querySelector('#settings-btn')!).display !== 'none', 'AI cannot hide settings');
      app.check(!!document.querySelector('#timeline a[href="https://example.com"]'), 'HTTPS link preserved');
      app.check(!!document.querySelector('#timeline strong'), 'Markdown formatting preserved');
      app.check(Array.from(document.querySelectorAll('#timeline pre code')).some((code) => code.textContent?.includes('<style>example only</style>')), 'Code examples preserved as text');
      await app.shot('sanitized-markdown');
      const originalUrl = location.href;
      app.check(window.open(`${originalUrl}?untrusted=popup`) === null, 'New app windows denied');
      location.assign(`${originalUrl}?untrusted=navigation`);
      await app.shot('blocked-navigation');
      app.check(location.href === originalUrl, 'Same-window navigation denied');
      app.check(!!(await (window as any).api.getConfig()).settings, 'Trusted app remains usable');
      return {};
    },
  });
  report('Markdown trust boundary', result);
  result.cleanup();
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });