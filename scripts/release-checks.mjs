import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { parseDocument } from 'yaml';
import { runF002SecurityChecks } from './f002-security.mjs';

export { runF002SecurityChecks, runF002StaticSecurityChecks } from './f002-security.mjs';

export const PAGES_BASE = '/bungo-zundamon/';
export const WARNING_TOTAL_BYTES = 500_000_000;
export const HARD_TOTAL_BYTES = 750_000_000;
export const HARD_FILE_BYTES = 104_857_600;

const REQUIRED_CSP = Object.freeze({
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'"],
  'media-src': ["'self'"],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-src': ["'none'"],
});

const SHA40 = /^[a-f0-9]{40}$/;
const FEATURE_ID = /^F\d{3}$/;
const REMOTE_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/;
const LOCAL_ACTION = /^\.\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIME_BY_EXTENSION = Object.freeze({
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});
const REQUIRED_AUTOMATED_CHECKS = Object.freeze([
  'typecheck',
  'lint',
  'unit',
  'build',
  'schema',
  'asset-budget',
  'same-origin',
]);
const REQUIRED_F002_QT_IDS = Object.freeze(
  Array.from({ length: 14 }, (_, index) => `QT-F002-${String(index + 1).padStart(3, '0')}`),
);
const REQUIRED_F002_WORK_IDS = Object.freeze(['000473', '043752', '043754']);
const REQUIRED_F002_VIEWPORTS = new Set(['390x844', '844x390', '1440x900']);
const REQUIRED_F002_ACCESSIBILITY = new Set(['keyboard', 'semantic-aria', 'reduced-motion']);
const DEPLOY_CONDITION = "github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.PAGES_DEPLOY_ENABLED == 'true' && vars.PAGES_DEPLOY_COMMIT == github.sha";

function report(errors, warnings = []) {
  return { ok: errors.length === 0, errors, warnings };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactObject(actual, expected) {
  if (!isRecord(actual)) return false;
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function parseWorkflow(source) {
  try {
    const document = parseDocument(source, {
      maxAliasCount: 0,
      merge: false,
      prettyErrors: false,
      schema: 'core',
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) return null;
    if (document.contents?.range == null) return null;
    const value = document.toJS({ maxAliasCount: 0 });
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function includesForbiddenControl(value) {
  if (typeof value === 'string') return /\balways\s*\(|\|\|\s*true\b|&&\s*false\b/i.test(value);
  if (Array.isArray(value)) return value.some(includesForbiddenControl);
  if (isRecord(value)) {
    if (Object.hasOwn(value, 'continue-on-error')) return true;
    return Object.values(value).some(includesForbiddenControl);
  }
  return false;
}

function actionReference(step) {
  if (!isRecord(step) || typeof step.uses !== 'string') return null;
  const marker = step.uses.lastIndexOf('@');
  return marker > 0 ? [step.uses.slice(0, marker), step.uses.slice(marker + 1)] : [step.uses, ''];
}

function hasExactRunStep(steps, command) {
  return steps.some((step) => isRecord(step)
    && step.run === command
    && !Object.hasOwn(step, 'if')
    && !Object.hasOwn(step, 'continue-on-error'));
}

// @des DES-F001-016 @fun FUN-F001-032
export function verifyWorkflowPermissions(workflow, options = {}) {
  const errors = [];
  if (typeof workflow !== 'string') {
    return report(['WORKFLOW_NOT_TEXT']);
  }
  const parsed = parseWorkflow(workflow);
  if (!parsed) return report(['WORKFLOW_YAML_INVALID']);
  if (includesForbiddenControl(parsed)) errors.push('WORKFLOW_CONTROL_BYPASS');

  const trigger = parsed.on;
  if (!isRecord(trigger)
    || !hasExactObject(trigger.pull_request, {})
    || !hasExactObject(trigger.workflow_dispatch, {})
    || !isRecord(trigger.push)
    || !Array.isArray(trigger.push.branches)
    || trigger.push.branches.length !== 1
    || trigger.push.branches[0] !== '**') {
    errors.push('WORKFLOW_EVENT_MATRIX_INVALID');
  }
  if (!hasExactObject(parsed.permissions, { contents: 'read' })) {
    errors.push('TOP_LEVEL_PERMISSIONS_NOT_READ_ONLY');
  }
  const jobs = parsed.jobs;
  const build = isRecord(jobs) && isRecord(jobs.build) ? jobs.build : null;
  const deploy = isRecord(jobs) && isRecord(jobs.deploy) ? jobs.deploy : null;
  if (!build) errors.push('BUILD_JOB_MISSING');
  if (!deploy) errors.push('DEPLOY_JOB_MISSING');
  if (!isRecord(jobs) || Object.keys(jobs).some((job) => !['build', 'deploy'].includes(job))) {
    errors.push('UNEXPECTED_JOB');
  }
  if (!hasExactObject(build?.permissions, { contents: 'read' })) {
    errors.push('BUILD_PERMISSIONS_INVALID');
  }
  if (!hasExactObject(deploy?.permissions, { pages: 'write', 'id-token': 'write' })) {
    errors.push('DEPLOY_PERMISSIONS_INVALID');
  }

  const buildSteps = Array.isArray(build?.steps) ? build.steps : [];
  const deploySteps = Array.isArray(deploy?.steps) ? deploy.steps : [];
  const references = [...buildSteps, ...deploySteps].map(actionReference).filter(Boolean);
  if (references.length === 0) errors.push('ACTION_REFERENCE_MISSING');
  for (const [action, reference] of references) {
    if (action.startsWith('./')) {
      if (!LOCAL_ACTION.test(action) || reference !== '') errors.push(`ACTION_LOCAL_INVALID:${action}`);
    } else if (!REMOTE_ACTION.test(action) || !SHA40.test(reference)) {
      errors.push(`ACTION_NOT_PINNED:${action}`);
    }
  }
  const checkoutSteps = buildSteps.filter((step) => actionReference(step)?.[0] === 'actions/checkout');
  const checkoutWith = checkoutSteps.length === 1 && isRecord(checkoutSteps[0]?.with)
    ? checkoutSteps[0].with
    : null;
  if (checkoutSteps.length !== 1 || checkoutWith?.['persist-credentials'] !== false) {
    errors.push('CHECKOUT_CREDENTIALS_PERSISTED');
  }
  if (checkoutSteps.length !== 1 || checkoutWith?.['fetch-depth'] !== 0) {
    errors.push('CHECKOUT_HISTORY_INCOMPLETE');
  }
  if (checkoutWith !== null
    && !hasExactObject(checkoutWith, { 'persist-credentials': false, 'fetch-depth': 0 })) {
    errors.push('CHECKOUT_CONFIG_INVALID');
  }

  if (!hasExactRunStep(buildSteps, 'npm ci')) errors.push('NPM_CI_MISSING');
  if (buildSteps.some((step) => typeof step?.run === 'string' && /^npm (?:install|i)(?:\s|$)/.test(step.run))) errors.push('NPM_INSTALL_FORBIDDEN');
  const nodeStep = buildSteps.find((step) => actionReference(step)?.[0] === 'actions/setup-node');
  if (!hasExactObject(nodeStep?.with, { 'node-version-file': '.nvmrc', cache: 'npm' })) errors.push('NODE_VERSION_FILE_MISSING');
  if (!hasExactRunStep(buildSteps, 'npm run verify')) errors.push('VERIFY_STEP_MISSING');
  const expectedBuildStepKinds = ['actions/checkout', 'actions/setup-node', 'npm ci', 'npm run verify', 'actions/upload-pages-artifact'];
  const actualBuildStepKinds = buildSteps.map((step) => actionReference(step)?.[0] ?? step?.run ?? null);
  if (JSON.stringify(actualBuildStepKinds) !== JSON.stringify(expectedBuildStepKinds)
    || !hasExactObject(buildSteps[4]?.with, { path: 'dist' })
    || buildSteps.some((step) => !isRecord(step) || Object.hasOwn(step, 'if') || Object.hasOwn(step, 'continue-on-error'))) {
    errors.push('BUILD_STEPS_INVALID');
  }
  if (buildSteps.some((step) => typeof step?.run === 'string' && /(content:update|voicevox|curl\b|wget\b|invoke-webrequest)/i.test(step.run))) {
    errors.push('NETWORK_UPDATE_STEP_FORBIDDEN');
  }
  if (Object.hasOwn(build ?? {}, 'if') || Object.hasOwn(build ?? {}, 'needs')) errors.push('BUILD_CAN_BE_SKIPPED');
  if (deploy?.needs !== 'build') errors.push('DEPLOY_NEEDS_BUILD');
  if (deploy?.if !== DEPLOY_CONDITION) errors.push('DEPLOY_CONDITION_INVALID');
  if (deploySteps.length !== 1 || actionReference(deploySteps[0])?.[0] !== 'actions/deploy-pages' || deploySteps[0]?.id !== 'deployment') errors.push('DEPLOY_STEP_INVALID');
  if (options.expectedNodeVersion && options.nvmrcVersion !== options.expectedNodeVersion) {
    errors.push('NODE_VERSION_MISMATCH');
  }
  return report([...new Set(errors)]);
}

// @des DES-F001-014 @fun FUN-F001-031
export function verifyAssetBudget(files) {
  const errors = [];
  const warnings = [];
  let totalBytes = 0;
  const audioHashes = new Map();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      errors.push('INVALID_FILE_METADATA');
      continue;
    }
    totalBytes += file.bytes;
    if (file.bytes >= HARD_FILE_BYTES) errors.push(`FILE_LIMIT_EXCEEDED:${file.path}`);
    if (/\.wav$/i.test(file.path) && file.hash) {
      const previous = audioHashes.get(file.hash);
      if (previous && previous !== file.path) errors.push(`DUPLICATE_AUDIO_HASH:${file.path}`);
      audioHashes.set(file.hash, file.path);
    }
  }
  if (totalBytes >= HARD_TOTAL_BYTES) errors.push('TOTAL_LIMIT_EXCEEDED');
  else if (totalBytes >= WARNING_TOTAL_BYTES) warnings.push('TOTAL_WARNING_THRESHOLD');
  return { ...report([...new Set(errors)], warnings), totalBytes };
}

// @des DES-F001-013 @fun FUN-F001-031
export function verifyCsp(html) {
  const errors = [];
  const meta = html.match(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0];
  const contentMatch = meta?.match(/content=(["'])(.*?)\1/i);
  const content = contentMatch?.[2];
  if (!content) return report(['CSP_META_MISSING']);
  const directives = new Map();
  for (const directive of content.split(';').map((value) => value.trim()).filter(Boolean)) {
    const [name, ...values] = directive.split(/\s+/);
    if (directives.has(name)) errors.push(`CSP_DUPLICATE:${name}`);
    directives.set(name, values);
  }
  for (const [name, values] of Object.entries(REQUIRED_CSP)) {
    if (JSON.stringify(directives.get(name)) !== JSON.stringify(values)) {
      errors.push(`CSP_DIRECTIVE_INVALID:${name}`);
    }
  }
  if (/unsafe-inline|unsafe-eval|\bdata:|\bblob:|https?:/i.test(content)) errors.push('CSP_UNSAFE_SOURCE');
  return report(errors);
}

async function collectFiles(directory, rootRealPath, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`SYMLINK_FORBIDDEN:${entry.name}`);
    const actual = await realpath(absolute);
    if (actual !== rootRealPath && !actual.startsWith(`${rootRealPath}${path.sep}`)) {
      throw new Error(`PATH_ESCAPE:${entry.name}`);
    }
    if (entry.isDirectory()) await collectFiles(absolute, rootRealPath, output);
    else if (entry.isFile()) output.push({ absolute, relative: path.relative(rootRealPath, actual).replaceAll('\\', '/'), bytes: metadata.size });
  }
  return output;
}

function referenceToRelative(reference, base, owner = 'index.html') {
  if (typeof reference !== 'string' || reference.trim() === '') throw new Error('EMPTY_REFERENCE');
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || /^\/\//.test(reference)) throw new Error(`UNSAFE_REFERENCE:${reference}`);
  const origin = 'https://pages.invalid';
  const ownerUrl = new URL(owner, `${origin}${base}`);
  const resolved = new URL(reference, ownerUrl);
  if (resolved.origin !== origin || !resolved.pathname.startsWith(base)) throw new Error(`BASE_ESCAPE:${reference}`);
  return decodeURIComponent(resolved.pathname.slice(base.length));
}

function textualReferences(relative, text) {
  const references = [];
  const extension = path.posix.extname(relative).toLowerCase();
  if (extension === '.html') {
    for (const match of text.matchAll(/<(?:script|link|img|audio|source)\b[^>]*(?:src|href)\s*=\s*["']([^"']+)["']/gi)) references.push(match[1]);
  }
  if (extension === '.css' || extension === '.svg') {
    for (const match of text.matchAll(/\burl\(\s*(?:["']([^"']+)["']|([^)'"\s][^)]*))\s*\)/gi)) references.push((match[1] ?? match[2]).trim());
  }
  if (extension === '.css') {
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) references.push(match[1]);
  }
  if (extension === '.svg') {
    for (const match of text.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']+)["']/gi)) references.push(match[1]);
  }
  if (extension === '.js' || extension === '.mjs') {
    for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g)) references.push(match[1]);
    for (const match of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) references.push(match[1]);
    for (const match of text.matchAll(/\bnew\s+URL\(\s*["']([^"']+)["']/g)) references.push(match[1]);
  }
  return [...new Set(references)];
}

function expectedMime(relative) {
  return MIME_BY_EXTENSION[path.posix.extname(relative).toLowerCase()] ?? null;
}

function verifyMimeContent(relative, bytes) {
  const mime = expectedMime(relative);
  if (!mime) return [`MIME_UNSUPPORTED:${relative}`];
  const extension = path.posix.extname(relative).toLowerCase();
  if (extension === '.png' && !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return [`MIME_CONTENT_MISMATCH:${relative}`];
  if (extension === '.wav' && (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE')) return [`MIME_CONTENT_MISMATCH:${relative}`];
  if (['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt'].includes(extension)) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return [`MIME_CONTENT_MISMATCH:${relative}`];
    }
    if (['.css', '.js', '.mjs'].includes(extension) && /<\s*!?doctype\s+html|<\s*html\b/i.test(text)) return [`MIME_CONTENT_MISMATCH:${relative}`];
    if (extension === '.html' && !/<(?:!doctype\s+html|html|head|meta)\b/i.test(text)) return [`MIME_CONTENT_MISMATCH:${relative}`];
    if (extension === '.svg' && !/<svg\b/i.test(text)) return [`MIME_CONTENT_MISMATCH:${relative}`];
    if (extension === '.json') {
      try {
        JSON.parse(text);
      } catch {
        return [`MIME_CONTENT_MISMATCH:${relative}`];
      }
    }
  }
  return [];
}

function catalogAssetReferences(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) catalogAssetReferences(item, output);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && (/(?:audio|image)?path$/i.test(key) || key === 'creditsRef')) output.push(item);
      else catalogAssetReferences(item, output);
    }
  }
  return output;
}

// @des DES-F001-013 @des DES-F001-014 @des DES-F001-015 @fun FUN-F001-031
export async function verifyBuiltReferences(distDir, base = PAGES_BASE) {
  const errors = [];
  if (base !== PAGES_BASE) return { ...report(['BASE_MISMATCH']), files: [], totalBytes: 0 };
  const root = await realpath(distDir);
  const files = await collectFiles(root, root);
  const byRelative = new Set(files.map((file) => file.relative));
  if (!byRelative.has('index.html')) errors.push('INDEX_MISSING');
  if (!byRelative.has('content/catalog.json')) errors.push('CATALOG_MISSING');
  const index = byRelative.has('index.html') ? await readFile(path.join(root, 'index.html'), 'utf8') : '';
  errors.push(...verifyCsp(index).errors);

  const referencedFiles = new Set(['index.html', 'content/catalog.json']);
  for (const file of files) {
    const extension = path.posix.extname(file.relative).toLowerCase();
    if (!['.html', '.css', '.js', '.mjs', '.json', '.svg'].includes(extension)) continue;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file.absolute));
    } catch {
      errors.push(`MIME_CONTENT_MISMATCH:${file.relative}`);
      continue;
    }
    const references = textualReferences(file.relative, text).map((reference) => ({ reference, owner: file.relative }));
    if (extension === '.json') {
      try {
        references.push(...catalogAssetReferences(JSON.parse(text)).map((reference) => ({ reference, owner: 'index.html' })));
      } catch {
        errors.push(`MIME_CONTENT_MISMATCH:${file.relative}`);
      }
    }
    for (const { reference, owner } of references) {
      try {
        const relative = referenceToRelative(reference, base, owner);
        if (!byRelative.has(relative)) errors.push(`REFERENCE_MISSING:${relative}`);
        else referencedFiles.add(relative);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'INVALID_REFERENCE');
      }
    }
  }

  const fileRecords = [];
  const secretPattern = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|https:\/\/[^/\s:]+:[^@\s]+@)/;
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    const hash = createHash('sha256').update(bytes).digest('hex');
    fileRecords.push({ path: file.relative, bytes: file.bytes, hash, mime: expectedMime(file.relative) });
    if (referencedFiles.has(file.relative)) errors.push(...verifyMimeContent(file.relative, bytes));
    if (/\.(?:html|js|css|json|txt|xml|svg)$/i.test(file.relative) && secretPattern.test(bytes.toString('utf8'))) {
      errors.push(`SECRET_PATTERN:${file.relative}`);
    }
  }
  const budget = verifyAssetBudget(fileRecords);
  errors.push(...budget.errors);
  return {
    ...report([...new Set(errors)], budget.warnings),
    files: fileRecords,
    totalBytes: budget.totalBytes,
  };
}

const REQUIRED_MANUAL_BROWSERS = new Set(['Windows Chrome', 'Windows Edge', 'iOS Safari']);
const REQUIRED_AUTOMATED_BROWSER_SCOPES = new Set(['chromium', 'firefox', 'webkit', 'android-viewport']);
const REQUIRED_BROWSER_RISK_SCOPES = new Set(['firefox', 'webkit', 'android-viewport']);
const BROWSER_RISK_TRIGGERS = new Set(['automated-failure', 'open-browser-defect', 'behavior-difference']);

function parseRfc3339Instant(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validHttpsUrl(value, predicate = () => true) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && predicate(url);
  } catch {
    return false;
  }
}

function nonBlankEvidence(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
}

function positiveIdentifier(value) {
  return (Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string' && /^[1-9]\d*$/.test(value));
}

function exactEvidenceSet(items, required, key) {
  const byKey = new Map();
  let invalid = !Array.isArray(items) || items.length !== required.size;
  for (const item of Array.isArray(items) ? items : []) {
    const value = item?.[key];
    if (!required.has(value) || byKey.has(value)) invalid = true;
    else byKey.set(value, item);
  }
  return { byKey, invalid };
}

function browserEvidenceValid(item, context, now, { installed, requireReviewer = true }) {
  const checkedAt = parseRfc3339Instant(item?.checkedAt);
  return isRecord(item)
    && item.status === 'passed'
    && (!installed || item.installed === true)
    && (!requireReviewer || (item.authorizedReviewer === true && nonBlankEvidence(item.reviewer)))
    && nonBlankEvidence(item.browserVersion)
    && nonBlankEvidence(item.osVersion)
    && nonBlankEvidence(item.evidence)
    && item.releaseCommit === context?.releaseCommit
    && item.catalogHash === context?.catalogHash
    && checkedAt !== null
    && now !== null
    && checkedAt <= now;
}

function githubRepositoryPath(repositoryUrl) {
  try {
    const url = new URL(repositoryUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== ''
      || url.username !== '' || url.password !== '' || parts.length !== 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

function candidateTuple(value) {
  const nested = isRecord(value?.candidate);
  const tuple = nested ? value.candidate : value;
  if (!isRecord(tuple)) return null;
  const expectedKeys = ['releaseCandidateBatchId', 'feature', 'releaseCommit', 'distSha256', 'artifactDigest'];
  if (nested && (Object.keys(tuple).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(tuple, key)))) return null;
  if (!FEATURE_ID.test(tuple.releaseCandidateBatchId ?? '') || tuple.feature !== tuple.releaseCandidateBatchId
    || !SHA40.test(tuple.releaseCommit ?? '') || !SHA256.test(tuple.distSha256 ?? '')
    || !SHA256.test(tuple.artifactDigest ?? '')) return null;
  return Object.fromEntries(expectedKeys.map((key) => [key, tuple[key]]));
}

function candidateMatches(value, expected) {
  const actual = candidateTuple(value);
  return actual !== null && Object.entries(expected).every(([key, expectedValue]) => actual[key] === expectedValue);
}

function exactStringSet(value, expected) {
  return Array.isArray(value) && value.length === expected.size
    && new Set(value).size === expected.size && value.every((item) => expected.has(item));
}

function isCanonicalWorkspaceRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes(':')
    || value.startsWith('/') || value.endsWith('/')) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isAcceptedAudioPath(value, workId) {
  if (!isCanonicalWorkspaceRelativePath(value)) return false;
  const parts = value.split('/');
  return parts.length === 6
    && parts[0] === 'content'
    && parts[1] === 'batches'
    && parts[2] === 'F002'
    && parts[3] === 'accepted-audio'
    && parts[4] === workId
    && /^[a-f0-9]{64}\.wav$/u.test(parts[5]);
}

/**
 * F002の全証跡をcanonical CandidateEvidence tupleへ束ねるread-only受入判定。
 * 欠落・失敗は領域別code、別build/commitの証跡混入はACCEPT_COMMIT_MISMATCHへfail-closedにする。
 *
 * @des DES-F002-003 @des DES-F002-005 @des DES-F002-009
 * @des DES-F002-011 @des DES-F002-013 @des DES-F002-016
 * @fun FUN-F002-030
 */
export async function acceptF002Release(context) {
  const blockers = [];
  const candidate = candidateTuple(context?.releaseBuild);
  const releaseBuildKeys = ['releaseCandidateBatchId', 'feature', 'releaseCommit', 'distSha256', 'artifactDigest'];
  if (candidate === null || candidate.feature !== 'F002'
    || !isRecord(context?.releaseBuild)
    || Object.keys(context.releaseBuild).length !== releaseBuildKeys.length
    || releaseBuildKeys.some((key) => !Object.hasOwn(context.releaseBuild, key))) {
    blockers.push('ACCEPT_COMMIT_MISMATCH');
  }
  const expected = candidate ?? {
    releaseCandidateBatchId: 'F002',
    feature: 'F002',
    releaseCommit: '',
    distSha256: '',
    artifactDigest: '',
  };
  const now = parseRfc3339Instant(context?.now);

  const checkout = context?.checkout;
  if (!isRecord(checkout) || checkout.status !== 'clean' || checkout.releaseVerifyStatus !== 'completed'
    || checkout.headSha !== expected.releaseCommit || checkout.releaseCommit !== expected.releaseCommit) {
    blockers.push('ACCEPT_COMMIT_MISMATCH');
  }

  const works = Array.isArray(context?.works) ? context.works : [];
  const workIds = new Set();
  const acceptedAudioPaths = new Set();
  const acceptedAudioFileNames = new Set();
  const acceptedAudioTuples = new Set();
  let workInvalid = works.length !== 3;
  for (const [index, work] of works.entries()) {
    if (!isRecord(work) || typeof work.workId !== 'string' || work.workId.length === 0 || workIds.has(work.workId)
      || work.workId !== REQUIRED_F002_WORK_IDS[index]
      || work.status !== 'accepted' || work.pendingCount !== 0
      || !Array.isArray(work.acceptedAudioSources) || work.acceptedAudioSources.length === 0
      || work.acceptedAudioSources.some((source) => !isRecord(source)
        || !isAcceptedAudioPath(source.path, work.workId) || !SHA256.test(source.sha256 ?? '')
        || !Number.isInteger(source.bytes) || source.bytes <= 0 || !SHA256.test(source.configHash ?? ''))) {
      workInvalid = true;
    } else {
      workIds.add(work.workId);
      for (const source of work.acceptedAudioSources) {
        const fileName = source.path.split('/').at(-1);
        const tuple = `${source.path}\u0000${source.sha256}\u0000${source.configHash}`;
        if (acceptedAudioPaths.has(source.path) || acceptedAudioFileNames.has(fileName)
          || acceptedAudioTuples.has(tuple)) {
          workInvalid = true;
        }
        acceptedAudioPaths.add(source.path);
        acceptedAudioFileNames.add(fileName);
        acceptedAudioTuples.add(tuple);
      }
    }
  }
  const batches = Array.isArray(context?.batches) ? context.batches : [];
  const candidateBatches = batches.filter((batch) => batch?.batchId === expected.releaseCandidateBatchId);
  if (candidateBatches.length !== 1 || candidateBatches[0]?.feature !== expected.feature
    || candidateBatches[0]?.status !== 'accepted'
    || batches.some((batch) => batch?.batchId !== expected.releaseCandidateBatchId && batch?.status !== 'published')) {
    workInvalid = true;
  }
  const authors = Array.isArray(context?.authors) ? context.authors : [];
  if (new Set(authors.map((author) => author?.authorId).filter((id) => typeof id === 'string' && id.length > 0)).size < 2) {
    workInvalid = true;
  }
  if (workInvalid) blockers.push('ACCEPT_WORK_INCOMPLETE');

  const voices = Array.isArray(context?.voiceEvidence) ? context.voiceEvidence : [];
  if (voices.length !== 3 || voices.some((voice) => voice?.result !== 'pass' || Object.hasOwn(voice ?? {}, 'status')
    || !workIds.has(voice?.workId) || !Number.isInteger(voice?.acceptedAudioCount)
    || voice.acceptedAudioCount !== works.find((work) => work?.workId === voice?.workId)?.acceptedAudioSources?.length)
    || new Set(voices.map((voice) => voice?.workId)).size !== 3) {
    blockers.push('ACCEPT_VOICE_INCOMPLETE');
  }
  if (voices.some((voice) => !candidateMatches(voice, expected))) blockers.push('ACCEPT_COMMIT_MISMATCH');

  const f001 = context?.f001;
  const f001Items = [f001?.baseline, f001?.contentInvariant, f001?.distInvariant];
  if (!isRecord(f001) || f001Items.some((item) => item?.result !== 'pass' || Object.hasOwn(item ?? {}, 'status'))
    || f001?.distInvariant?.distSha256 !== expected.distSha256
    || f001?.distInvariant?.artifactDigest !== expected.artifactDigest) {
    blockers.push('ACCEPT_F001_REGRESSION');
  }
  if (f001Items.some((item) => !candidateMatches(item, expected))) blockers.push('ACCEPT_COMMIT_MISMATCH');

  // WorkRightsDecision/PolicyDecision/ArtworkDecision自体はselection時点ではrelease tupleを持たない。
  // release adapterが不変の判断結果を{ result|status, candidate }へ包み、ここでcandidateを結合する。
  const workRightsItems = [context?.rights?.selection, context?.rights?.predeploy];
  const policyItems = [context?.policy?.selection, context?.policy?.predeploy];
  const artwork = context?.artwork;
  if (workRightsItems.some((item) => !isRecord(item) || item.result !== 'unchanged'
      || Object.hasOwn(item, 'status'))
    || policyItems.some((item) => !isRecord(item) || !['unchanged', 'changed-reviewed'].includes(item.status)
      || Object.hasOwn(item, 'result'))
    || !isRecord(artwork) || artwork.result !== 'pass' || Object.hasOwn(artwork, 'status')) {
    blockers.push('ACCEPT_RIGHTS_BLOCKED');
  }
  const rightsItems = [...workRightsItems, ...policyItems, artwork];
  if (rightsItems.some((item) => !candidateMatches(item, expected))) blockers.push('ACCEPT_COMMIT_MISMATCH');

  const capacity = context?.capacity;
  if (!isRecord(capacity) || Object.hasOwn(capacity, 'status')
    || capacity.evidenceKind !== 'actual' || capacity.phase !== 'release'
    || !['pass', 'pass_with_warning'].includes(capacity.result)) {
    blockers.push('ACCEPT_CAPACITY_BLOCKED');
  }
  if (!candidateMatches(capacity, expected)) blockers.push('ACCEPT_COMMIT_MISMATCH');

  const security = context?.security;
  if (!isRecord(security) || security.status !== 'pass' || Object.hasOwn(security, 'result')) {
    blockers.push('ACCEPT_SECURITY_BLOCKED');
  }
  if (!candidateMatches(security, expected)) blockers.push('ACCEPT_COMMIT_MISMATCH');

  const browser = context?.browser;
  const regression = context?.regression;
  if (!isRecord(browser) || browser.status !== 'passed' || Object.hasOwn(browser, 'result')
    || !exactStringSet(browser.viewports, REQUIRED_F002_VIEWPORTS)
    || !exactStringSet(browser.accessibility, REQUIRED_F002_ACCESSIBILITY)
    || !exactStringSet(browser.automatedBrowsers, REQUIRED_AUTOMATED_BROWSER_SCOPES)
    || !isRecord(regression) || regression.status !== 'passed' || Object.hasOwn(regression, 'result')
    || !Number.isInteger(regression.unitTests) || regression.unitTests < 337
    || !Number.isInteger(regression.browserTests) || regression.browserTests < 78
    || regression.f002Tests !== 'passed') {
    blockers.push('ACCEPT_BROWSER_INCOMPLETE');
  }
  if (!candidateMatches(browser, expected) || !candidateMatches(regression, expected)) {
    blockers.push('ACCEPT_COMMIT_MISMATCH');
  }

  const qtEvidence = Array.isArray(context?.qtEvidence) ? context.qtEvidence : [];
  const qtById = new Map();
  let qtInvalid = qtEvidence.length !== REQUIRED_F002_QT_IDS.length;
  let qtTupleInvalid = false;
  for (const evidence of qtEvidence) {
    const executedAt = parseRfc3339Instant(evidence?.executedAt);
    if (!isRecord(evidence) || typeof evidence.id !== 'string' || qtById.has(evidence.id)
      || evidence.status !== 'passed' || Object.hasOwn(evidence, 'result')
      || executedAt === null || now === null || executedAt > now
      || !Array.isArray(evidence.evidenceRefs) || evidence.evidenceRefs.length === 0
      || evidence.evidenceRefs.some((ref) => !isCanonicalWorkspaceRelativePath(ref))) {
      qtInvalid = true;
    } else {
      qtById.set(evidence.id, evidence);
    }
    if (!candidateMatches(evidence, expected)) qtTupleInvalid = true;
  }
  if (REQUIRED_F002_QT_IDS.some((id) => !qtById.has(id))) qtInvalid = true;
  if (qtInvalid) blockers.push('ACCEPT_BROWSER_INCOMPLETE');
  if (qtTupleInvalid) blockers.push('ACCEPT_COMMIT_MISMATCH');

  if (blockers.length > 0) return { status: 'blocked', blockers: [...new Set(blockers)] };
  return {
    status: 'ready_for_approval',
    ...expected,
  };
}

// @des DES-F001-016 @des DES-F001-018 @fun FUN-F001-035
export async function runReleaseChecks(context) {
  const blockers = [];
  const feature = context?.feature;
  if (!FEATURE_ID.test(feature ?? '')) blockers.push('INVALID_FEATURE');
  const now = parseRfc3339Instant(context?.now);
  if (now === null) blockers.push('INVALID_CHECK_TIME');
  if (!SHA40.test(context?.releaseCommit ?? '')) blockers.push('INVALID_RELEASE_COMMIT');
  if (!SHA256.test(context?.catalogHash ?? '')) blockers.push('INVALID_CATALOG_HASH');
  const automatedChecks = Array.isArray(context?.automatedChecks) ? context.automatedChecks : [];
  const automatedById = new Map();
  let automatedInvalid = automatedChecks.length === 0;
  for (const item of automatedChecks) {
    if (!isRecord(item) || typeof item.id !== 'string' || automatedById.has(item.id)) {
      automatedInvalid = true;
      continue;
    }
    automatedById.set(item.id, item);
    const completedAt = parseRfc3339Instant(item.completedAt);
    if (item.status !== 'passed' || !nonBlankEvidence(item.evidence)
      || item.releaseCommit !== context?.releaseCommit || item.catalogHash !== context?.catalogHash
      || completedAt === null || now === null || completedAt > now) automatedInvalid = true;
  }
  if (REQUIRED_AUTOMATED_CHECKS.some((id) => !automatedById.has(id)) || automatedInvalid) blockers.push('AUTOMATED_CHECK_INCOMPLETE');

  if (feature !== 'F002') {
    const manual = exactEvidenceSet(context?.manualBrowsers, REQUIRED_MANUAL_BROWSERS, 'name');
    if (manual.invalid) blockers.push('MANUAL_BROWSER_SET_INVALID');
    for (const name of REQUIRED_MANUAL_BROWSERS) {
      if (!browserEvidenceValid(manual.byKey.get(name), context, now, { installed: true })) {
        blockers.push(`MANUAL_BROWSER_EVIDENCE:${name}`);
      }
    }
  }

  const automatedBrowsers = exactEvidenceSet(context?.automatedBrowsers, REQUIRED_AUTOMATED_BROWSER_SCOPES, 'scope');
  if (automatedBrowsers.invalid) blockers.push('AUTOMATED_BROWSER_SET_INVALID');
  for (const scope of REQUIRED_AUTOMATED_BROWSER_SCOPES) {
    if (!browserEvidenceValid(automatedBrowsers.byKey.get(scope), context, now, {
      installed: false,
      requireReviewer: feature !== 'F002',
    })) {
      blockers.push(`AUTOMATED_BROWSER_EVIDENCE:${scope}`);
    }
  }

  const risks = exactEvidenceSet(context?.browserRisks, REQUIRED_BROWSER_RISK_SCOPES, 'scope');
  if (risks.invalid) blockers.push('BROWSER_RISK_SET_INVALID');
  const deviceTests = Array.isArray(context?.deviceTests) ? context.deviceTests : [];
  const deviceTestsByScope = new Map();
  if (feature !== 'F002' && !Array.isArray(context?.deviceTests)) blockers.push('DEVICE_TEST_SET_INVALID');
  for (const deviceTest of deviceTests) {
    if (!REQUIRED_BROWSER_RISK_SCOPES.has(deviceTest?.scope) || deviceTestsByScope.has(deviceTest?.scope)) {
      blockers.push('DEVICE_TEST_SET_INVALID');
    } else {
      deviceTestsByScope.set(deviceTest.scope, deviceTest);
    }
  }
  for (const scope of REQUIRED_BROWSER_RISK_SCOPES) {
    const risk = risks.byKey.get(scope);
    const assessedAt = parseRfc3339Instant(risk?.assessedAt);
    const resolvedAt = parseRfc3339Instant(risk?.resolvedAt);
    const triggers = Array.isArray(risk?.triggers) ? risk.triggers : [];
    const uniqueTriggers = new Set(triggers);
    const triggered = triggers.length > 0;
    const riskInvalid = !isRecord(risk)
      || triggers.length !== uniqueTriggers.size
      || triggers.some((trigger) => !BROWSER_RISK_TRIGGERS.has(trigger))
      || risk.requiresDeviceTest !== (feature === 'F002' ? false : triggered)
      || (feature !== 'F002' && risk.authorizedReviewer !== true)
      || !nonBlankEvidence(risk.rationale)
      || (feature !== 'F002' && !nonBlankEvidence(risk.reviewer))
      || assessedAt === null || now === null || assessedAt > now
      || (triggered && (resolvedAt === null || resolvedAt < assessedAt || resolvedAt > now));
    if (riskInvalid) blockers.push(`BROWSER_RISK_INVALID:${scope}`);
    if (triggered && feature === 'F002') {
      blockers.push(`AUTOMATED_BROWSER_RISK_UNRESOLVED:${scope}`);
    } else if (triggered) {
      const automatedCheckedAt = parseRfc3339Instant(automatedBrowsers.byKey.get(scope)?.checkedAt);
      const deviceTest = deviceTestsByScope.get(scope);
      const deviceCheckedAt = parseRfc3339Instant(deviceTest?.checkedAt);
      if (assessedAt === null || resolvedAt === null || automatedCheckedAt === null
        || automatedCheckedAt < assessedAt || automatedCheckedAt > resolvedAt
        || !browserEvidenceValid(deviceTest, context, now, { installed: true })
        || deviceCheckedAt === null || deviceCheckedAt < assessedAt || deviceCheckedAt > resolvedAt) {
        blockers.push(`DEVICE_TEST_REQUIRED:${scope}`);
      }
    }
  }

  const hosted = context?.hostedBuild;
  const hostedObservedAt = parseRfc3339Instant(hosted?.observedAt);
  const repositoryPath = githubRepositoryPath(hosted?.repositoryUrl);
  const expectedRunUrl = repositoryPath && positiveIdentifier(hosted?.runId)
    ? `https://github.com/${repositoryPath}/actions/runs/${hosted.runId}`
    : null;
  if (!positiveIdentifier(hosted?.repositoryId)
    || expectedRunUrl === null || hosted?.runUrl !== expectedRunUrl
    || hosted?.event !== 'push' || hosted?.ref !== `refs/heads/feature/${feature}`
    || hosted?.headSha !== context?.releaseCommit
    || hosted?.workflowPath !== '.github/workflows/pages.yml' || hosted?.workflowSha !== context?.releaseCommit
    || hosted?.conclusion !== 'success'
    || !positiveIdentifier(hosted?.artifactId) || hosted?.artifactName !== 'github-pages'
    || !SHA256.test((hosted?.artifactDigest ?? '').replace(/^sha256:/, ''))
    || (feature !== 'F002' && (!nonBlankEvidence(hosted?.reviewer) || hosted?.authorizedReviewer !== true))
    || hosted?.deploymentAbsent !== true
    || hostedObservedAt === null || now === null || hostedObservedAt > now) blockers.push('HOSTED_BUILD_EVIDENCE');
  if (hosted?.artifactCatalogHash !== context?.catalogHash) blockers.push('HOSTED_BUILD_HASH_MISMATCH');

  const visibility = context?.visibilityPlan;
  if (!positiveIdentifier(visibility?.repositoryId)
    || visibility?.currentVisibility !== 'private' || visibility?.pagesEnabled !== false
    || visibility?.pagesDeployEnabled !== false || visibility?.pagesDeployCommit !== null
    || githubRepositoryPath(visibility?.repositoryUrl) === null) blockers.push('VISIBILITY_PLAN_UNSAFE');
  if (visibility?.releaseCommit !== context?.releaseCommit || visibility?.catalogHash !== context?.catalogHash) blockers.push('VISIBILITY_PLAN_HASH_MISMATCH');
  const visibilityObservedAt = parseRfc3339Instant(visibility?.observedAt);
  if (visibilityObservedAt === null || now === null || visibilityObservedAt > now
    || !nonBlankEvidence(visibility?.evidence)) blockers.push('VISIBILITY_PLAN_STALE');
  if (hosted?.repositoryId !== visibility?.repositoryId || hosted?.repositoryUrl !== visibility?.repositoryUrl) blockers.push('HOSTED_REPOSITORY_MISMATCH');
  if (!SHA256.test(visibility?.pagesHash ?? '') || hosted?.pagesHashBefore !== visibility?.pagesHash
    || hosted?.pagesHashAfter !== visibility?.pagesHash) blockers.push('HOSTED_PAGES_HASH_CHANGED');

  for (const key of ['budget', 'csp', 'credits', 'artwork']) {
    const item = context?.[key];
    const completedAt = parseRfc3339Instant(item?.completedAt);
    if (item?.ok !== true || !nonBlankEvidence(item?.evidence) || completedAt === null || now === null || completedAt > now) blockers.push(`${key.toUpperCase()}_CHECK_FAILED`);
  }
  if (!Array.isArray(context?.policies) || context.policies.length === 0 || context.policies.some((item) => {
    const checkedAt = parseRfc3339Instant(item?.checkedAt);
    const validUntil = parseRfc3339Instant(item?.validUntil);
    return item?.status !== 'passed' || !validHttpsUrl(item?.url) || !nonBlankEvidence(item?.evidence)
      || checkedAt === null || validUntil === null || now === null || checkedAt > now || validUntil < now || validUntil < checkedAt;
  })) blockers.push('POLICY_EVIDENCE_INVALID');

  if (feature === 'F002' && context?.securityContext === undefined) {
    blockers.push('SECURITY_CHECK_FAILED');
  } else if (context?.securityContext !== undefined) {
    const security = await runF002SecurityChecks(context.securityContext);
    if (security.status !== 'pass') blockers.push('SECURITY_CHECK_FAILED');
  }

  let f002Acceptance;
  if (feature === 'F002') {
    f002Acceptance = await acceptF002Release(context?.f002Acceptance);
    if (f002Acceptance.status === 'blocked') blockers.push(...f002Acceptance.blockers);
    const hostedArtifactDigest = (hosted?.artifactDigest ?? '').replace(/^sha256:/, '');
    if (f002Acceptance.status === 'ready_for_approval'
      && (f002Acceptance.releaseCandidateBatchId !== context?.releaseCandidateBatchId
        || f002Acceptance.feature !== feature
        || f002Acceptance.releaseCommit !== context?.releaseCommit
        || f002Acceptance.distSha256 !== context?.distSha256
        || f002Acceptance.artifactDigest !== hostedArtifactDigest)) {
      blockers.push('ACCEPT_COMMIT_MISMATCH');
    }
  }

  if (blockers.length > 0) return { status: 'blocked', blockers: [...new Set(blockers)] };
  return {
    status: 'ready_for_approval',
    releaseCommit: context.releaseCommit,
    catalogHash: context.catalogHash,
    ...(f002Acceptance?.status === 'ready_for_approval' ? {
      releaseCandidateBatchId: f002Acceptance.releaseCandidateBatchId,
      distSha256: f002Acceptance.distSha256,
      artifactDigest: f002Acceptance.artifactDigest,
    } : {}),
    evidence: {
      hostedRunUrl: hosted.runUrl,
      artifactDigest: hosted.artifactDigest,
      visibilityObservedAt: visibility.observedAt,
    },
  };
}

// @des DES-F001-016 @fun FUN-F001-042
export function validateReleaseVisibilityEvidence(evidence) {
  const blockers = [];
  const feature = evidence?.feature;
  if (!FEATURE_ID.test(feature ?? '')) blockers.push('RELEASE_FEATURE_INVALID');
  const commit = evidence?.releaseCommit;
  if (!SHA40.test(commit ?? '')) blockers.push('RELEASE_COMMIT_INVALID');
  const trustedApprovals = Array.isArray(evidence?.trustedQueueApprovals) ? evidence.trustedQueueApprovals : [];
  const approvalIds = new Set();
  let approvalSetInvalid = trustedApprovals.length === 0;
  for (const record of trustedApprovals) {
    if (!isRecord(record) || !/^Q-\d{3,}$/.test(record.id ?? '') || approvalIds.has(record.id)) {
      approvalSetInvalid = true;
    } else {
      approvalIds.add(record.id);
    }
  }
  if (approvalSetInvalid) blockers.push('TRUSTED_APPROVAL_SET_INVALID');
  const approval = trustedApprovals.find((record) => record?.id === evidence?.approvalId);
  if (!approval) blockers.push('APPROVAL_RECORD_NOT_FOUND');
  if (!/^Q-\d{3,}$/.test(evidence?.approvalId ?? '')
    || evidence?.approvalStatus !== 'closed' || evidence?.approvalAnswer !== '承認'
    || approval?.type !== 'approval' || approval?.status !== evidence?.approvalStatus
    || approval?.answer !== evidence?.approvalAnswer) blockers.push('APPROVAL_INVALID');
  if (approval?.source !== 'pf-release' || approval?.target_mode !== 'reference'
    || approval?.target !== feature || approval?.approvalTargetCommit !== evidence?.approvalTargetCommit
    || approval?.approvalTargetCommit !== commit || approval?.approvedAt !== evidence?.approvedAt) {
    blockers.push('APPROVAL_GATE_MISMATCH');
  }
  for (const candidate of [evidence?.approvalTargetCommit, evidence?.pagesDeployCommit, evidence?.artifactCommit, evidence?.deploymentCommit]) {
    if (!SHA40.test(candidate ?? '') || candidate !== commit) blockers.push('RELEASE_COMMIT_CHAIN_MISMATCH');
  }
  const approvedAt = parseRfc3339Instant(evidence?.approvedAt);
  const privateAt = parseRfc3339Instant(evidence?.privateObservedAt);
  const publicAt = parseRfc3339Instant(evidence?.publicObservedAt);
  const pagesAt = parseRfc3339Instant(evidence?.pagesEnabledAt);
  const deployEnabledAt = parseRfc3339Instant(evidence?.pagesDeployEnabledAt);
  const deployDisabledAt = parseRfc3339Instant(evidence?.pagesDeployDisabledAt);
  const audit = evidence?.visibilityAuditEvent;
  const auditAt = parseRfc3339Instant(audit?.occurredAt);
  if ([approvedAt, privateAt, publicAt, pagesAt, deployEnabledAt, deployDisabledAt].some((value) => value === null)
    || !(approvedAt <= privateAt && privateAt < publicAt && publicAt <= pagesAt
      && pagesAt <= deployEnabledAt && deployEnabledAt <= deployDisabledAt)) blockers.push('VISIBILITY_TIME_ORDER_INVALID');
  if (evidence?.privateObserved !== true || evidence?.publicObserved !== true
    || audit?.from !== 'private' || audit?.to !== 'public'
    || !nonBlankEvidence(audit?.id) || audit?.releaseCommit !== commit
    || auditAt === null || privateAt === null || publicAt === null || auditAt < privateAt || auditAt > publicAt) blockers.push('VISIBILITY_AUDIT_INVALID');
  if (evidence?.pagesDeployEnabledAfter !== false || evidence?.pagesDeployCommitAfter !== null) blockers.push('DEPLOY_VARIABLES_NOT_DISABLED');
  if (!SHA256.test(evidence?.catalogHash ?? '')) blockers.push('CATALOG_HASH_INVALID');
  for (const candidate of [evidence?.artifactCatalogHash, evidence?.deploymentCatalogHash, evidence?.pagesCatalogHash, evidence?.pagesHash]) {
    if (!SHA256.test(candidate ?? '') || candidate !== evidence?.catalogHash) blockers.push('CATALOG_HASH_CHAIN_MISMATCH');
  }
  const artifactDigest = (evidence?.artifactDigest ?? '').replace(/^sha256:/, '');
  const deploymentArtifactDigest = (evidence?.deploymentArtifactDigest ?? '').replace(/^sha256:/, '');
  if (!SHA256.test(artifactDigest) || !SHA256.test(deploymentArtifactDigest) || artifactDigest !== deploymentArtifactDigest) blockers.push('ARTIFACT_DIGEST_INVALID');
  if (!nonBlankEvidence(evidence?.deploymentId)) blockers.push('DEPLOYMENT_ID_MISSING');
  if (evidence?.pagesStatus !== 200) blockers.push('PAGES_NOT_OK');
  if (!validHttpsUrl(evidence?.repositoryUrl, (url) => url.hostname === 'github.com' && url.pathname.split('/').filter(Boolean).length === 2)
    || !validHttpsUrl(evidence?.pagesUrl)) blockers.push('RELEASE_URL_INVALID');
  if (blockers.length > 0) return { status: 'blocked', blockers: [...new Set(blockers)] };
  return {
    status: 'released',
    releaseCommit: commit,
    artifactDigest: evidence.artifactDigest,
    deploymentId: evidence.deploymentId,
    pagesHash: evidence.pagesCatalogHash,
  };
}
