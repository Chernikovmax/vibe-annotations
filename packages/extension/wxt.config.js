import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

const extensionDir = new URL('.', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: extensionDir, encoding: 'utf8' });
const { version } = JSON.parse(readFileSync(new URL('package.json', extensionDir), 'utf8'));
const sha = git('rev-parse', '--short=12', 'HEAD').trim();
const diff = git('diff', '--binary', 'HEAD', '--', '.');
const untracked = git('ls-files', '--others', '--exclude-standard', '-z', '--', '.').split('\0').filter(Boolean);
const fingerprint = createHash('sha256').update(diff);
for (const path of untracked) fingerprint.update(path).update('\0').update(readFileSync(new URL(encodeURI(path), extensionDir))).update('\0');
const revision = diff || untracked.length ? sha + '+dirty.' + fingerprint.digest('hex').slice(0, 10) : sha;
const build = version + ' · ' + revision + ' · label, anchor-chain, hop-count=v2, overlay-cause, projection-edge';

// Keep the same manifest shape the Chrome Web Store listing expects. WXT generates
// the actual manifest.json from this config plus discovered entrypoints.
export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  vite: () => ({ define: { __REMARKER_BUILD__: JSON.stringify(build) } }),
  // Avoid clashing with the Next.js website dev server on :3000.
  dev: {
    server: { port: 3010 },
  },
  webExt: {
    startUrls: ['http://localhost:3000'],
    keepProfileChanges: true,
  },
  manifest: {
    name: 'Remarker',
    description:
      'Visual annotations for localhost dev projects. Send feedback to AI coding agents like Claude & Cursor via MCP.',
    author: 'Raphael Regnier - Spellbind Creative Studio',
    permissions: ['activeTab', 'storage', 'scripting', 'clipboardWrite', 'offscreen', 'downloads', 'alarms'],
    // '*://*/*' covers the "enable on all sites" annotation flow (http/https).
    // '<all_urls>' is additionally required by chrome.tabs.captureVisibleTab for
    // screenshots — it is NOT satisfied by '*://*/*' (which omits file://, etc.).
    optional_host_permissions: ['*://*/*', '<all_urls>'],
    host_permissions: [
      'http://localhost/*',
      'https://localhost/*',
      'http://127.0.0.1/*',
      'https://127.0.0.1/*',
      'http://0.0.0.0/*',
      'https://0.0.0.0/*',
      'http://*.local/*',
      'https://*.local/*',
      'http://*.test/*',
      'https://*.test/*',
      'http://*.localhost/*',
      'https://*.localhost/*',
      'file:///*',
    ],
    icons: {
      16: 'assets/icons/icon16.png',
      32: 'assets/icons/icon32.png',
      48: 'assets/icons/icon48.png',
      128: 'assets/icons/icon128.png',
    },
    action: {
      default_title: 'Remarker',
    },
    commands: {
      'toggle-annotate': {
        suggested_key: {
          default: 'Ctrl+Shift+Comma',
          mac: 'Command+Shift+Comma',
        },
        description: 'Toggle annotation mode',
      },
    },
    web_accessible_resources: [
      {
        resources: ['assets/fonts/InterVariable.woff2', 'assets/icons/icon-hq.png'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
