import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { canonicalJson } from '../content/artifacts.ts';
import {
  POLICY_MAX_RESPONSE_BYTES,
  POLICY_TRANSPORT_VERSION,
  ProductionPolicyTransport,
  capturePolicyObservation,
  comparePolicySnapshots,
  createPolicyDefinitions,
  fetchPolicyObservation,
  validateSelectionPolicySnapshots,
  type FetchedPolicyResponse,
  type ImpactReview,
  type PolicyDefinition,
  type PolicyObservation,
  type PolicyTransportResponse,
} from './policy-snapshots.ts';

const DNS_ADDRESS = '93.184.216.34';
const NOW = '2026-07-25T12:00:00.000Z';
const RELEASE_COMMIT = 'a'.repeat(40);

function response(
  definition: PolicyDefinition,
  body: Uint8Array = new TextEncoder().encode('policy'),
  overrides: Partial<PolicyTransportResponse> = {},
): PolicyTransportResponse {
  return {
    status: 200,
    mediaType: 'text/html',
    body,
    finalUrl: definition.url,
    elapsedMs: 14_999,
    fetchedAt: NOW,
    transportVersion: POLICY_TRANSPORT_VERSION,
    security: {
      dnsAddresses: [DNS_ADDRESS],
      connectedAddress: DNS_ADDRESS,
      tlsAuthorized: true,
      hostnameVerified: true,
      redirectsFollowed: 0,
      proxyUsed: false,
      attempts: 1,
    },
    ...overrides,
  };
}

async function fetched(definition: PolicyDefinition, body?: Uint8Array): Promise<FetchedPolicyResponse> {
  return fetchPolicyObservation(definition, { request: async () => response(definition, body) });
}

function observation(
  definition: PolicyDefinition,
  phase: 'selection' | 'predeploy',
  contentSha256 = 'b'.repeat(64),
): PolicyObservation {
  return {
    batchId: definition.batchId,
    policyId: definition.policyId,
    url: definition.url,
    finalUrl: definition.url,
    status: 200,
    mediaType: 'text/html',
    responseBytes: 6,
    fetchedAt: NOW,
    observedAt: NOW,
    contentSha256,
    transportVersion: POLICY_TRANSPORT_VERSION,
    versionOrLabel: definition.versionOrLabel,
    reviewer: '権利確認担当',
    decisionSummary: '公開用途と表示条件を確認',
    phase,
    ...(phase === 'predeploy' ? { releaseCommit: RELEASE_COMMIT, runId: 'run-23' } : {}),
  };
}

describe('UT-F002-035 規約取得のexact allowlistと安全transport', () => {
  it('5件のcanonical HTTPSだけを1回取得し、8 MiB/14,999 ms境界を許可する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-allowlist-'));
    const definitions = createPolicyDefinitions(workspace, workspace);
    expect(definitions.map((item) => item.url)).toEqual([
      'https://www.aozora.gr.jp/guide/kijyunn.html',
      'https://voicevox.hiroshiba.jp/term/',
      'https://zunko.jp/con_ongen_kiyaku.html',
      'https://zunko.jp/guideline.html',
      'https://openai.com/policies/terms-of-use/',
    ]);
    const request = vi.fn(async (definition: PolicyDefinition) =>
      response(definition, new Uint8Array(POLICY_MAX_RESPONSE_BYTES)));
    await expect(fetchPolicyObservation(definitions[0]!, { request })).resolves.toMatchObject({
      policyId: 'aozora-handling',
      elapsedMs: 14_999,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('allowlist差分、+1 byte、15,000 ms、redirect、proxy、rebindをfail-closedにする', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-negative-'));
    const definition = createPolicyDefinitions(workspace, workspace)[0]!;
    const request = vi.fn(async () => response(definition));
    await expect(fetchPolicyObservation(
      { ...definition, url: `${definition.url}?x=1` },
      { request },
    )).rejects.toMatchObject({ code: 'POLICY_URL_NOT_ALLOWED' });
    expect(request).not.toHaveBeenCalled();
    await expect(fetchPolicyObservation(definition, {
      request: async () => response(definition, new Uint8Array(POLICY_MAX_RESPONSE_BYTES + 1)),
    })).rejects.toMatchObject({ code: 'POLICY_TOO_LARGE' });
    await expect(fetchPolicyObservation(definition, {
      request: async () => response(definition, undefined, { elapsedMs: 15_000 }),
    })).rejects.toMatchObject({ code: 'POLICY_TIMEOUT' });
    await expect(fetchPolicyObservation(definition, {
      request: async () => response(definition, undefined, { finalUrl: 'https://example.com/' }),
    })).rejects.toMatchObject({ code: 'POLICY_REDIRECTED' });
    await expect(fetchPolicyObservation(definition, {
      request: async () => response(definition, undefined, {
        security: { ...response(definition).security, proxyUsed: true as false },
      }),
    })).rejects.toMatchObject({ code: 'POLICY_PROXY_FORBIDDEN' });
    await expect(fetchPolicyObservation(definition, {
      request: async () => response(definition, undefined, {
        security: { ...response(definition).security, connectedAddress: '93.184.216.35' },
      }),
    })).rejects.toMatchObject({ code: 'POLICY_DNS_REBIND' });
  });

  it('実adapterはDNS全回答publicとIP pin/TLS/redirect/proxy無効をsocket境界へ強制する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-adapter-'));
    const definition = createPolicyDefinitions(workspace, workspace)[0]!;
    const pinned = vi.fn(async (request) => {
      expect(request).toMatchObject({
        address: DNS_ADDRESS,
        hostHeader: 'www.aozora.gr.jp',
        serverName: 'www.aozora.gr.jp',
        rejectUnauthorized: true,
        checkServerIdentity: true,
        followRedirects: false,
        useEnvironmentProxy: false,
        maxBytes: POLICY_MAX_RESPONSE_BYTES,
      });
      return response(definition);
    });
    const transport = new ProductionPolicyTransport({
      resolver: async () => [{ address: DNS_ADDRESS, family: 4 }],
      pinnedSocketFactory: pinned,
    });
    await expect(fetchPolicyObservation(definition, transport)).resolves.toMatchObject({ status: 200 });
    expect(pinned).toHaveBeenCalledTimes(1);

    const privateTransport = new ProductionPolicyTransport({
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
      pinnedSocketFactory: pinned,
    });
    await expect(fetchPolicyObservation(definition, privateTransport)).rejects.toMatchObject({ code: 'POLICY_DNS_PRIVATE' });
    expect(pinned).toHaveBeenCalledTimes(1);
  });
});

describe('UT-F002-010 規約観測contextとraw非公開', () => {
  it('F002 selection metadataはcanonicalで5件すべてをhashだけ記録する', async () => {
    const workspace = process.cwd();
    const raw = await readFile(join(workspace, 'content', 'batches', 'F002', 'policy-observations.json'), 'utf8');
    const document = JSON.parse(raw) as {
      schemaVersion: string;
      batchId: string;
      phase: string;
      observations: PolicyObservation[];
    };
    expect(raw).toBe(canonicalJson(document));
    expect(document).toMatchObject({ schemaVersion: '1.0.0', batchId: 'F002', phase: 'selection' });
    expect(document.observations.map((item) => item.policyId)).toEqual(
      createPolicyDefinitions(workspace, workspace).map((item) => item.policyId),
    );
    expect(document.observations.every((item) =>
      item.batchId === 'F002' && item.phase === 'selection' &&
      item.releaseCommit === undefined && item.runId === undefined &&
      !Object.prototype.hasOwnProperty.call(item, 'body'))).toBe(true);
    const predeploy = document.observations.map((item) => ({
      ...item,
      phase: 'predeploy' as const,
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
    }));
    expect(comparePolicySnapshots(document.observations, predeploy, [], {
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
      batchId: 'F002',
    })).toMatchObject({ status: 'unchanged', reasonCodes: [] });
  });

  it('selection/predeployを区別しrawを.cache/rightsだけへatomic保存する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-capture-'));
    const definition = createPolicyDefinitions(workspace, workspace)[0]!;
    const transportResponse = await fetched(definition);
    const selected = await capturePolicyObservation(
      definition,
      transportResponse,
      { phase: 'selection' },
      new Date(NOW),
      '権利確認担当',
      '選定時点で条件を確認',
    );
    const snapshotPath = join(workspace, '.cache', 'rights', 'F002', definition.policyId, `${selected.contentSha256}.snapshot`);
    expect(await readFile(snapshotPath, 'utf8')).toBe('policy');
    expect(selected).not.toHaveProperty('releaseCommit');
    expect(selected).not.toHaveProperty('body');

    await expect(capturePolicyObservation(
      definition,
      transportResponse,
      { phase: 'predeploy', releaseCommit: RELEASE_COMMIT, runId: 'run-23' },
      new Date(NOW),
      '権利確認担当',
      'deploy直前に条件を確認',
    )).resolves.toMatchObject({ phase: 'predeploy', releaseCommit: RELEASE_COMMIT, runId: 'run-23' });
  });

  it('context混線、secret、public workspaceを拒否する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-context-'));
    const definition = createPolicyDefinitions(workspace, workspace)[0]!;
    const transportResponse = await fetched(definition);
    await expect(capturePolicyObservation(
      definition,
      transportResponse,
      { phase: 'selection', releaseCommit: RELEASE_COMMIT },
      new Date(NOW),
      '担当',
      '確認',
    )).rejects.toMatchObject({ code: 'POLICY_RESPONSE_UNBOUND' });
    await expect(capturePolicyObservation(
      definition,
      transportResponse,
      { phase: 'selection' },
      new Date(NOW),
      '担当',
      `github_pat_${'x'.repeat(30)}`,
    )).rejects.toMatchObject({ code: 'POLICY_RESPONSE_UNBOUND' });

    const publicRoot = join(workspace, 'public');
    const publicDefinition = createPolicyDefinitions(workspace, publicRoot)[0]!;
    await expect(capturePolicyObservation(
      publicDefinition,
      { ...transportResponse, requestedUrl: publicDefinition.url },
      { phase: 'selection' },
      new Date(NOW),
      '担当',
      '確認',
    )).rejects.toMatchObject({ code: 'POLICY_SNAPSHOT_WRITE_FAILED' });
  });

  it('型を偽装したFetchedPolicyResponseのsecurity・時刻・transport・media・timeoutを再検証する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-forged-response-'));
    const definition = createPolicyDefinitions(workspace, workspace)[0]!;
    const valid = await fetched(definition);
    const forged: FetchedPolicyResponse[] = [
      {
        ...valid,
        security: { ...valid.security, dnsAddresses: ['127.0.0.1'], connectedAddress: '127.0.0.1' },
      },
      { ...valid, fetchedAt: 'not-an-instant' },
      { ...valid, transportVersion: 'forged-transport' },
      { ...valid, mediaType: 'application/octet-stream' },
      { ...valid, elapsedMs: 99_999 },
      { ...valid, security: { ...valid.security, tlsAuthorized: false as true } },
      { ...valid, security: { ...valid.security, hostnameVerified: false as true } },
      { ...valid, security: { ...valid.security, redirectsFollowed: 1 as 0 } },
      { ...valid, security: { ...valid.security, attempts: 2 as 1 } },
    ];
    for (const item of forged) {
      await expect(capturePolicyObservation(
        definition,
        item,
        { phase: 'selection' },
        new Date(NOW),
        '権利確認担当',
        '選定時点で条件を確認',
      )).rejects.toBeInstanceOf(Error);
    }
  });

  it('trusted project rootと異なるpublic/content nested workspaceにはrawを1件も書かない', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'policy-trusted-root-'));
    for (const trackedDirectory of ['public', 'content']) {
      const nested = join(projectRoot, trackedDirectory, 'nested');
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, 'package.json'), '{"name":"forged-marker"}\n');
      await writeFile(join(nested, '.gitignore'), '.cache/\n');
      const definition = createPolicyDefinitions(projectRoot, nested)[0]!;
      const transportResponse = await fetched(definition);
      await expect(capturePolicyObservation(
        definition,
        transportResponse,
        { phase: 'selection' },
        new Date(NOW),
        '権利確認担当',
        '選定時点で条件を確認',
      )).rejects.toMatchObject({ code: 'POLICY_SNAPSHOT_WRITE_FAILED' });
      await expect(access(join(nested, '.cache'))).rejects.toBeInstanceOf(Error);
    }
  });
});

describe('UT-F002-011 2時点snapshot比較とchange review gate', () => {
  it('selection rights入力はallowlist全5件のexact schemaだけを受理する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-selection-validation-'));
    const selection = createPolicyDefinitions(workspace, workspace)
      .map((item) => observation(item, 'selection'));
    expect(validateSelectionPolicySnapshots(selection, 'F002')).toHaveLength(5);

    const variants: readonly (readonly PolicyObservation[])[] = [
      selection.slice(1),
      [...selection, selection[0]!],
      selection.map((item, index) => index === 0
        ? { ...item, contentSha256: 'not-a-hash' }
        : item) as PolicyObservation[],
      selection.map((item, index) => index === 0
        ? { ...item, unexpected: true } as unknown as PolicyObservation
        : item),
    ];
    for (const variant of variants) {
      expect(() => validateSelectionPolicySnapshots(variant, 'F002')).toThrowError(
        expect.objectContaining({ code: 'POLICY_OBSERVATION_INVALID' }),
      );
    }
  });

  it('同hashをunchanged、完全な変更reviewをchanged-reviewedとする', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-compare-'));
    const definitions = createPolicyDefinitions(workspace, workspace);
    const selection = definitions.map((item) => observation(item, 'selection'));
    const predeploy = definitions.map((item) => observation(item, 'predeploy'));
    expect(comparePolicySnapshots(selection, predeploy, [], {
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
    })).toMatchObject({ status: 'unchanged', reasonCodes: [] });

    const changed = predeploy.map((item) => item.policyId === 'openai-terms'
      ? { ...item, contentSha256: 'c'.repeat(64) }
      : item);
    const review: ImpactReview = {
      policyId: 'openai-terms',
      selectionSha256: 'b'.repeat(64),
      predeploySha256: 'c'.repeat(64),
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
      impacts: ['artwork', 'credit'],
      decision: 'approved',
      reviewer: '権利確認担当',
      reviewedAt: NOW,
      summary: '画像とcreditへの影響を再確認',
    };
    expect(comparePolicySnapshots(selection, changed, [review], {
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
    })).toMatchObject({ status: 'changed-reviewed', impacts: ['artwork', 'credit'] });
  });

  it('欠落、candidate混線、未review変更、stale reviewをblockedにする', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-blocked-'));
    const definitions = createPolicyDefinitions(workspace, workspace);
    const selection = definitions.map((item) => observation(item, 'selection'));
    const predeploy = definitions.map((item) => observation(item, 'predeploy'));
    expect(comparePolicySnapshots(selection.slice(1), predeploy, [], {
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
    })).toMatchObject({ status: 'blocked', reasonCodes: ['POLICY_OBSERVATION_MISSING'] });
    expect(comparePolicySnapshots(selection, [
      { ...predeploy[0]!, releaseCommit: 'd'.repeat(40) },
      ...predeploy.slice(1),
    ], [], {
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
    })).toMatchObject({ status: 'blocked' });
    const changed = [{ ...predeploy[0]!, contentSha256: 'c'.repeat(64) }, ...predeploy.slice(1)];
    expect(comparePolicySnapshots(selection, changed, [], {
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
    })).toMatchObject({ status: 'blocked', reasonCodes: ['POLICY_HASH_CHANGED_UNREVIEWED'] });
  });

  it('attacker URL/status/bytes/hash/reviewer/summaryと不正candidate contextをunchangedにしない', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-forged-observation-'));
    const definitions = createPolicyDefinitions(workspace, workspace);
    const selection = definitions.map((item) => observation(item, 'selection'));
    const predeploy = definitions.map((item) => observation(item, 'predeploy'));
    const forged = selection.map((item) => ({
      ...item,
      url: 'https://attacker.example/policy',
      finalUrl: 'https://attacker.example/policy',
      status: 500,
      mediaType: 'application/octet-stream',
      responseBytes: -1,
      fetchedAt: 'invalid',
      observedAt: 'invalid',
      contentSha256: 'not-a-hash',
      transportVersion: 'forged',
      versionOrLabel: 'attacker',
      reviewer: '',
      decisionSummary: '',
    })) as unknown as PolicyObservation[];
    const forgedDecision = comparePolicySnapshots(forged, predeploy, [], {
      releaseCommit: RELEASE_COMMIT,
      runId: 'run-23',
    });
    expect(forgedDecision.status).toBe('blocked');
    expect(forgedDecision.reasonCodes).toContain('POLICY_OBSERVATION_INVALID');
    expect(forgedDecision.reasonCodes).not.toEqual([]);

    const invalidExpected = comparePolicySnapshots(selection, predeploy, [], {
      releaseCommit: 'not-a-sha',
      runId: '',
    });
    expect(invalidExpected.status).toBe('blocked');
    expect(invalidExpected.reasonCodes).toContain('POLICY_REVIEW_STALE');
    expect(invalidExpected.reasonCodes).not.toEqual([]);
  });

  it('観測batch・phase・exact schemaの混線をblockedにする', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'policy-schema-observation-'));
    const definitions = createPolicyDefinitions(workspace, workspace);
    const selection = definitions.map((item) => observation(item, 'selection'));
    const predeploy = definitions.map((item) => observation(item, 'predeploy'));
    const variants = [
      selection.map((item, index) => index === 0 ? { ...item, batchId: 'F999' } : item),
      selection.map((item, index) => index === 0 ? { ...item, phase: 'predeploy' as const } : item),
      selection.map((item, index) => index === 0 ? { ...item, unexpected: true } as unknown as PolicyObservation : item),
    ];
    for (const variant of variants) {
      expect(comparePolicySnapshots(variant, predeploy, [], {
        releaseCommit: RELEASE_COMMIT,
        runId: 'run-23',
      })).toMatchObject({ status: 'blocked' });
    }
  });
});
