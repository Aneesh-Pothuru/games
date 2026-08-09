/**
 * One way to launch a browser for the e2e suites.
 *
 * Two things vary by environment and neither belongs copy-pasted into five
 * files: where Chromium lives, and whether outbound HTTPS has to go through a
 * proxy. The proxy matters because it is what lets these suites run against
 * the deployed site (BASE_URL=https://…) and not only against wrangler dev.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BUNDLED = '/opt/pw-browsers/chromium';

export const BASE = process.env.BASE_URL ?? 'http://localhost:8787';

export function launchOptions() {
  const opts = {};
  const executablePath = process.env.CHROMIUM_PATH || (existsSync(BUNDLED) ? BUNDLED : undefined);
  if (executablePath) opts.executablePath = executablePath;

  // Only for remote targets: localhost is in every no_proxy list, and routing
  // it through a proxy would break the default local run.
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxy && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(BASE)) {
    opts.proxy = { server: proxy };
  }
  return opts;
}

export const launchBrowser = () => chromium.launch(launchOptions());
