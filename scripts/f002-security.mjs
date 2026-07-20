import { parseDocument } from 'yaml';

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
const REMOTE_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/;
const LOCAL_ACTION = /^\.\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function cspContent(value) {
  if (typeof value !== 'string') return null;
  const meta = value.match(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0];
  if (!meta) return value;
  return meta.match(/content=(["'])(.*?)\1/i)?.[2] ?? null;
}

function cspViolations(value) {
  const content = cspContent(value);
  if (!content) return 1;
  const directives = new Map();
  let violations = 0;
  for (const directive of content.split(';').map((item) => item.trim()).filter(Boolean)) {
    const [name, ...sources] = directive.split(/\s+/);
    if (!name || directives.has(name)) violations += 1;
    else directives.set(name, sources);
  }
  for (const [name, sources] of Object.entries(REQUIRED_CSP)) {
    if (JSON.stringify(directives.get(name)) !== JSON.stringify(sources)) violations += 1;
  }
  if (/unsafe-inline|unsafe-eval|\bdata:|\bblob:|https?:|\*/iu.test(content)) violations += 1;
  return violations;
}

function parseWorkflow(source) {
  if (typeof source !== 'string') return null;
  try {
    const document = parseDocument(source, {
      maxAliasCount: 0,
      merge: false,
      prettyErrors: false,
      schema: 'core',
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) return null;
    const value = document.toJS({ maxAliasCount: 0 });
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function exactObject(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => value[key] === item);
}

function workflowViolations(source) {
  const workflow = parseWorkflow(source);
  if (!workflow) return 1;
  let violations = 0;
  if (!exactObject(workflow.permissions, { contents: 'read' })) violations += 1;
  const jobs = isRecord(workflow.jobs) ? Object.values(workflow.jobs) : [];
  if (jobs.length === 0) return violations + 1;
  const steps = jobs.flatMap((job) => isRecord(job) && Array.isArray(job.steps) ? job.steps : []);
  const usesSteps = steps.filter((step) => isRecord(step) && typeof step.uses === 'string');
  if (usesSteps.length === 0) violations += 1;
  for (const step of usesSteps) {
    const uses = step.uses;
    if (uses.startsWith('./')) {
      if (!LOCAL_ACTION.test(uses)) violations += 1;
      continue;
    }
    const marker = uses.lastIndexOf('@');
    const action = marker > 0 ? uses.slice(0, marker) : '';
    const reference = marker > 0 ? uses.slice(marker + 1) : '';
    if (!REMOTE_ACTION.test(action) || !SHA40.test(reference)) violations += 1;
    if (action === 'actions/checkout' && (!isRecord(step.with) || step.with['persist-credentials'] !== false)) {
      violations += 1;
    }
  }
  const checkoutSteps = usesSteps.filter((step) => step.uses.startsWith('actions/checkout@'));
  if (checkoutSteps.length !== 1 || !isRecord(checkoutSteps[0]?.with)
    || checkoutSteps[0].with['persist-credentials'] !== false) violations += 1;
  const build = isRecord(workflow.jobs?.build) ? workflow.jobs.build : null;
  const deploy = isRecord(workflow.jobs?.deploy) ? workflow.jobs.deploy : null;
  if (!isRecord(workflow.jobs) || Object.keys(workflow.jobs).some((name) => !['build', 'deploy'].includes(name))) violations += 1;
  if (!build || !exactObject(build.permissions, { contents: 'read' })) violations += 1;
  if (!deploy || !exactObject(deploy.permissions, { pages: 'write', 'id-token': 'write' })) violations += 1;
  return violations;
}

function safeRequest(request, origin, basePath) {
  if (!isRecord(request) || typeof request.url !== 'string') return null;
  try {
    const url = new URL(request.url, origin);
    return url.origin === origin && url.pathname.startsWith(basePath);
  } catch {
    return false;
  }
}

function addCode(codes, count, code) {
  if (count > 0) codes.push(code);
}

function validRoute(value) {
  return value === '#/' || value === '#/credits' || /^#\/authors\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function inspectStaticContext(context) {
  const counts = {
    cspViolations: 0,
    unsafeDomSinks: 0,
    storageOrForms: 0,
    secrets: 0,
    workflowViolations: 0,
    unknownResults: 0,
  };
  if (!isRecord(context)) counts.unknownResults += 1;
  const routes = Array.isArray(context?.distRoutes) ? context.distRoutes : [];
  const expectedRoutes = Array.isArray(context?.expectedRoutes) ? context.expectedRoutes : [];
  if (routes.length === 0 || expectedRoutes.length === 0) counts.unknownResults += 1;
  const routeNames = new Set();
  for (const route of routes) {
    if (!isRecord(route) || !validRoute(route.route) || routeNames.has(route.route)) {
      counts.unknownResults += 1;
      continue;
    }
    routeNames.add(route.route);
    counts.cspViolations += cspViolations(route.csp);
  }
  if (expectedRoutes.some((route) => !validRoute(route) || !routeNames.has(route))
    || routeNames.size !== expectedRoutes.length) counts.unknownResults += 1;

  const dom = context?.domSinkScan;
  if (!isRecord(dom) || dom.status !== 'passed' || !safeInteger(dom.unsafeSinkCount)) counts.unknownResults += 1;
  else counts.unsafeDomSinks += dom.unsafeSinkCount;
  const privacy = context?.privacyScan;
  const privacyFields = ['cookieAccessCount', 'localStorageCount', 'sessionStorageCount', 'indexedDbCount', 'formCount'];
  if (!isRecord(privacy) || privacy.status !== 'passed' || privacyFields.some((key) => !safeInteger(privacy[key]))) {
    counts.unknownResults += 1;
  } else counts.storageOrForms += privacyFields.reduce((total, key) => total + privacy[key], 0);
  const secrets = context?.secretScan;
  if (!isRecord(secrets) || secrets.status !== 'passed' || !safeInteger(secrets.matches)) counts.unknownResults += 1;
  else counts.secrets += secrets.matches;
  counts.workflowViolations += workflowViolations(context?.workflow);
  return counts;
}

/** build成果物から実測できる静的項目だけを判定する。full release securityの代用にはしない。 */
export async function runF002StaticSecurityChecks(context) {
  const counts = inspectStaticContext(context);
  const codes = [];
  addCode(codes, counts.cspViolations, 'SECURITY_CSP_VIOLATION');
  addCode(codes, counts.unsafeDomSinks, 'SECURITY_UNSAFE_DOM');
  addCode(codes, counts.secrets, 'SECURITY_SECRET_FOUND');
  addCode(codes, counts.storageOrForms, 'SECURITY_STORAGE_OR_FORM');
  addCode(codes, counts.workflowViolations, 'SECURITY_WORKFLOW_INVALID');
  addCode(codes, counts.unknownResults, 'SECURITY_UNKNOWN_RESULT');
  return Object.freeze({
    scope: 'static-build',
    status: codes.length === 0 ? 'static-pass' : 'blocked',
    counts: Object.freeze(counts),
    codes: Object.freeze([...new Set(codes)]),
  });
}

/** @des DES-F002-012 DES-F002-016 @fun FUN-F002-029 */
export async function runF002SecurityChecks(context) {
  const counts = {
    cspViolations: 0,
    externalRequests: 0,
    openRedirects: 0,
    unsafeDomSinks: 0,
    storageOrForms: 0,
    externalTtsRequests: 0,
    secrets: 0,
    dependencyHighOrCritical: 0,
    workflowViolations: 0,
    catalogUnsafeAccepted: 0,
    unknownResults: 0,
  };

  if (!isRecord(context)) counts.unknownResults += 1;
  const routes = Array.isArray(context?.distRoutes) ? context.distRoutes : [];
  const expectedRoutes = Array.isArray(context?.expectedRoutes) ? context.expectedRoutes : [];
  if (routes.length === 0 || expectedRoutes.length === 0) counts.unknownResults += 1;
  const routeNames = new Set();
  for (const route of routes) {
    if (!isRecord(route) || !validRoute(route.route) || routeNames.has(route.route)) {
      counts.unknownResults += 1;
      continue;
    }
    routeNames.add(route.route);
    counts.cspViolations += cspViolations(route.csp);
  }
  if (expectedRoutes.some((route) => !validRoute(route) || !routeNames.has(route)) || routeNames.size !== expectedRoutes.length) {
    counts.unknownResults += 1;
  }

  let origin = null;
  let basePath = null;
  try {
    const application = new URL(context?.applicationOrigin);
    if (!['http:', 'https:'].includes(application.protocol) || application.username || application.password
      || application.pathname !== '/' || application.search || application.hash) throw new Error();
    origin = application.origin;
    basePath = context?.publicBasePath;
    if (typeof basePath !== 'string' || !basePath.startsWith('/') || !basePath.endsWith('/')) throw new Error();
  } catch {
    counts.unknownResults += 1;
  }
  const requestEvidence = context?.requestLog;
  const observedRoutes = isRecord(requestEvidence) && Array.isArray(requestEvidence.observedRoutes)
    ? requestEvidence.observedRoutes
    : [];
  const observedRouteSet = new Set(observedRoutes);
  const requestLog = isRecord(requestEvidence) && Array.isArray(requestEvidence.requests)
    ? requestEvidence.requests
    : null;
  if (!isRecord(requestEvidence) || requestEvidence.status !== 'passed'
    || requestEvidence.source !== 'browser-observer' || !requestLog
    || observedRoutes.length !== expectedRoutes.length
    || observedRouteSet.size !== expectedRoutes.length
    || observedRoutes.some((route) => !validRoute(route) || !expectedRoutes.includes(route))) {
    counts.unknownResults += 1;
  }
  for (const request of requestLog ?? []) {
    if (!validRoute(request?.route) || !observedRouteSet.has(request.route)
      || !['asset', 'audio', 'navigation', 'tts', 'api'].includes(request?.kind)) {
      counts.unknownResults += 1;
    }
    const safe = origin && basePath ? safeRequest(request, origin, basePath) : null;
    if (safe === null) counts.unknownResults += 1;
    else if (!safe) counts.externalRequests += 1;
    if (request?.kind === 'navigation' && safe !== true) counts.openRedirects += 1;
    if (request?.kind === 'tts') counts.externalTtsRequests += 1;
  }

  const dom = context?.domSinkScan;
  if (!isRecord(dom) || dom.status !== 'passed' || !safeInteger(dom.unsafeSinkCount)) counts.unknownResults += 1;
  else counts.unsafeDomSinks += dom.unsafeSinkCount;
  const privacy = context?.privacyScan;
  const privacyFields = ['cookieAccessCount', 'localStorageCount', 'sessionStorageCount', 'indexedDbCount', 'formCount'];
  if (!isRecord(privacy) || privacy.status !== 'passed' || privacyFields.some((key) => !safeInteger(privacy[key]))) {
    counts.unknownResults += 1;
  } else {
    counts.storageOrForms += privacyFields.reduce((total, key) => total + privacy[key], 0);
  }
  const secrets = context?.secretScan;
  if (!isRecord(secrets) || secrets.status !== 'passed' || !safeInteger(secrets.matches)) counts.unknownResults += 1;
  else counts.secrets += secrets.matches;
  const audit = context?.dependencyAudit;
  if (!isRecord(audit) || audit.status !== 'passed' || audit.source !== 'npm-audit' || audit.audited !== true
    || !safeInteger(audit.high) || !safeInteger(audit.critical)) {
    counts.unknownResults += 1;
  } else counts.dependencyHighOrCritical += audit.high + audit.critical;
  const catalog = context?.catalogFixtures;
  if (!isRecord(catalog) || catalog.status !== 'passed' || catalog.source !== 'malicious-fixture-suite'
    || !safeInteger(catalog.caseCount) || catalog.caseCount === 0 || !safeInteger(catalog.unsafeAccepted)) counts.unknownResults += 1;
  else counts.catalogUnsafeAccepted += catalog.unsafeAccepted;
  counts.workflowViolations += workflowViolations(context?.workflow);

  const codes = [];
  addCode(codes, counts.cspViolations, 'SECURITY_CSP_VIOLATION');
  addCode(codes, counts.externalRequests + counts.openRedirects, 'SECURITY_EXTERNAL_REQUEST');
  addCode(codes, counts.unsafeDomSinks, 'SECURITY_UNSAFE_DOM');
  addCode(codes, counts.secrets, 'SECURITY_SECRET_FOUND');
  addCode(codes, counts.storageOrForms, 'SECURITY_STORAGE_OR_FORM');
  addCode(codes, counts.dependencyHighOrCritical, 'SECURITY_DEPENDENCY_HIGH');
  addCode(codes, counts.externalTtsRequests, 'SECURITY_EXTERNAL_TTS');
  addCode(codes, counts.workflowViolations, 'SECURITY_WORKFLOW_INVALID');
  addCode(codes, counts.catalogUnsafeAccepted, 'SECURITY_CATALOG_UNSAFE');
  addCode(codes, counts.unknownResults, 'SECURITY_UNKNOWN_RESULT');
  return Object.freeze({
    scope: 'full-release',
    status: codes.length === 0 ? 'pass' : 'blocked',
    counts: Object.freeze(counts),
    codes: Object.freeze([...new Set(codes)]),
  });
}
