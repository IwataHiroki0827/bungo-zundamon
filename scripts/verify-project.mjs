import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PAGES_BASE,
  verifyBuiltReferences,
  verifyWorkflowPermissions,
} from './release-checks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// @des DES-F001-015 @des DES-F001-016 @fun FUN-F001-031 @fun FUN-F001-032
async function main() {
  const [workflow, nvmrc, packageJson] = await Promise.all([
    readFile(path.join(projectRoot, '.github', 'workflows', 'pages.yml'), 'utf8'),
    readFile(path.join(projectRoot, '.nvmrc'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const expectedNodeVersion = packageJson.engines?.node;
  const workflowReport = verifyWorkflowPermissions(workflow, {
    expectedNodeVersion,
    nvmrcVersion: nvmrc.trim().replace(/^v/, ''),
  });
  const buildReport = await verifyBuiltReferences(path.join(projectRoot, 'dist'), PAGES_BASE);
  const errors = [...workflowReport.errors, ...buildReport.errors];
  const warnings = [...workflowReport.warnings, ...buildReport.warnings];
  if (process.version.slice(1) !== expectedNodeVersion) errors.push('LOCAL_NODE_VERSION_MISMATCH');
  if (!buildReport.files.some((file) => file.path === '.nojekyll')) errors.push('NOJEKYLL_MISSING');

  for (const warning of warnings) console.warn(`[build warning] ${warning}`);
  if (errors.length > 0) {
    for (const error of [...new Set(errors)]) console.error(`[build error] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`build verification passed: ${buildReport.files.length} files / ${buildReport.totalBytes} bytes`);
}

await main();

