import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');
const preload = pathToFileURL(path.join(projectRoot, 'scripts', 'network-deny.mjs')).href;

// @des DES-F001-017 @fun FUN-F001-033
describe('offline build network preload', () => {
  it.each([
    ['dns.promises.lookup', "const dns = await import('node:dns'); await dns.default.promises.lookup('example.com')"],
    ['node:dns/promises.lookup', "const dns = await import('node:dns/promises'); await dns.lookup('example.com')"],
  ])('%sを同期的に遮断する', (_name, expression) => {
    const script = `
      try {
        ${expression};
        process.exitCode = 2;
      } catch (error) {
        if (error?.message !== 'NETWORK_DISABLED_DURING_BUILD') process.exitCode = 3;
      }
    `;
    const result = spawnSync(process.execPath, [`--import=${preload}`, '--input-type=module', '--eval', script], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  });
});
