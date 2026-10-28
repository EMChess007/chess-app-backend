/**
 * Which browser the browser end-to-end launches (scripts/e2e-browser/app.mjs `browserLaunchOptions`). Pure: an environment object in, the Playwright options out; no browser is started.
 *
 *   npm run test:e2eBrowserOptions
 *
 * Why: the harness always asked for the system Chrome (`channel: 'chrome'`), which a Linux cloud VM does not have (it has Playwright's Chromium). `E2E_BROWSER_PATH` names an executable
 * instead; with it unset the behaviour is the one the Windows development machine always had. Literals on purpose: the default channel, the variable names and the headless rule are
 * what the cloud setup (scripts/cloud-setup.sh in the app repo) and TESTING.md section "Cloud sessions" rely on.
 */
import assert from 'node:assert/strict';
import { browserLaunchOptions } from './e2e-browser/app.mjs';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
const same = (actual, expected, message) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${message} (${JSON.stringify(actual)})`);

same(browserLaunchOptions({}), { channel: 'chrome', headless: true }, 'default: the system Chrome, headless');
same(browserLaunchOptions({ E2E_BROWSER_CHANNEL: 'msedge' }), { channel: 'msedge', headless: true }, 'a channel can be named');
same(browserLaunchOptions({ E2E_BROWSER_CHANNEL: '' }), { channel: 'chrome', headless: true }, 'an empty channel is the default');
same(browserLaunchOptions({ E2E_BROWSER_PATH: '/opt/pw-browsers/chromium' }), { executablePath: '/opt/pw-browsers/chromium', headless: true }, 'a path runs that executable and names no channel');
same(
  browserLaunchOptions({ E2E_BROWSER_PATH: '/opt/pw-browsers/chromium', E2E_BROWSER_CHANNEL: 'msedge' }),
  { executablePath: '/opt/pw-browsers/chromium', headless: true },
  'a path wins over a channel',
);
same(browserLaunchOptions({ E2E_BROWSER_PATH: '' }), { channel: 'chrome', headless: true }, 'an empty path counts as unset');
same(browserLaunchOptions({ E2E_HEADED: '1' }), { channel: 'chrome', headless: false }, 'E2E_HEADED=1 shows the window');
same(browserLaunchOptions({ E2E_HEADED: '0' }), { channel: 'chrome', headless: true }, 'only "1" shows the window');
same(browserLaunchOptions({ E2E_HEADED: '1', E2E_BROWSER_PATH: '/x/chrome' }), { executablePath: '/x/chrome', headless: false }, 'headed works with a path too');
const keysOfDefault = Object.keys(browserLaunchOptions({})).sort().join(',');
ok(keysOfDefault === 'channel,headless', 'the default carries no executablePath key (Playwright would prefer it over the channel)');
const keysOfPath = Object.keys(browserLaunchOptions({ E2E_BROWSER_PATH: '/x' })).sort().join(',');
ok(keysOfPath === 'executablePath,headless', 'a path carries no channel key');

console.log(`\n${passed} checks passed`);
