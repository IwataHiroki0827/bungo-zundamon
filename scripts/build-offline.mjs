import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preload = path.join(projectRoot, 'scripts', 'network-deny.mjs');
const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim();
const nodeOptions = [inheritedNodeOptions, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
const environment = {
  ...process.env,
  NODE_OPTIONS: nodeOptions,
  npm_config_offline: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
};

// @des DES-F001-017 @fun FUN-F001-033
function runNode(relativeEntry, args = []) {
  const entry = path.join(projectRoot, ...relativeEntry.split('/'));
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runNode('node_modules/typescript/bin/tsc', ['--noEmit']);
runNode('node_modules/vite/bin/vite.js', ['build']);
runNode('scripts/verify-project.mjs');
