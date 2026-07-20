import { promoteBatchSourceArtifactTree } from './batch-production.ts';
import type { WorkspaceRelativePath } from './batch.ts';

const workspace = process.argv[2];
const artifactRoot = process.argv[3];
if (!workspace || !artifactRoot) throw new Error('workspace/artifactRoot are required');

await promoteBatchSourceArtifactTree(
  workspace,
  artifactRoot as WorkspaceRelativePath,
  [{ path: 'value.bin', bytes: new TextEncoder().encode('new-value') }],
  {
    afterPhase: async (phase) => {
      if (phase === 'old-moved') {
        process.stdout.write('old-moved\n');
        await new Promise<never>(() => setInterval(() => undefined, 1_000));
      }
    },
  },
);
