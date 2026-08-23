import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/content/artifacts.ts';
import { voiceConfigHashV2, type VoiceConfigV2 } from '../src/voice/cache.ts';
import { inspectWav } from '../src/voice/generation.ts';

/**
 * F008専用の一時運用script。generateVoiceDiff(src/voice/generation.ts、共有・変更禁止)は
 * staging directoryをmkdir(recursive:false)で毎回新規作成する前提のため、プロセスが外部要因で
 * 中断されるとstagingへ書き出し済みのWAVはpersistent cache(.cache/voice/)へ昇格されないまま
 * 失われ、次回起動時に全件再生成になる(CHG-F008-003)。
 *
 * このscriptは既にstagingへ実生成済みの正当なWAV(VOICEVOXから実際に取得した実データ、
 * 捏造ではない)を、planVoiceDiffが期待するcache format(.cache/voice/{configHash}/
 * {audioId}.wav + .json)へ複製するだけで、新規のWAV生成は一切行わない。次回の
 * f008-prepare-voice.ts実行時にhit判定されるようにする、副作用のない後処理。
 */

const workIdArgument = process.argv[2];
if (!workIdArgument || !/^[0-9]{6}$/u.test(workIdArgument)) {
  throw new Error('work IDを6桁数値で指定してください');
}
const WORK_ID = workIdArgument;
const BATCH_ID = 'F008';

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function main(): Promise<void> {
  const workspace = await fileURLToPath(new URL('..', import.meta.url));
  const configPath = resolve(workspace, 'content', 'batches', BATCH_ID, 'voice-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as VoiceConfigV2;
  const configHash = voiceConfigHashV2(config);
  const cacheDir = resolve(workspace, '.cache', 'voice', configHash);
  await mkdir(cacheDir, { recursive: true });

  const stageDir = resolve(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, `.voice-stage-${WORK_ID}`);
  let files: string[];
  try {
    files = (await readdir(stageDir)).filter((name) => name.endsWith('.wav'));
  } catch {
    process.stdout.write(canonicalJson({ ok: true, promoted: 0, note: 'staging directoryがありません' }));
    return;
  }

  let promoted = 0;
  let skipped = 0;
  for (const file of files) {
    const audioId = file.replace(/\.wav$/u, '');
    const wavPath = join(stageDir, file);
    const wav = await readFile(wavPath);
    const targetWav = join(cacheDir, `${audioId}.wav`);
    const targetMeta = join(cacheDir, `${audioId}.json`);
    try {
      await readFile(targetMeta);
      skipped++;
      continue;
    } catch {
      // 未昇格、続けて昇格する
    }
    const durationMs = inspectWav(wav).durationMs;
    const metadata = {
      schemaVersion: '2' as const,
      audioId,
      configHash,
      sha256: sha256(wav),
      bytes: wav.byteLength,
      durationMs,
    };
    await writeFile(targetWav, wav);
    await writeFile(targetMeta, canonicalJson(metadata), 'utf8');
    promoted++;
  }
  process.stdout.write(canonicalJson({ ok: true, promoted, skipped, configHash }));
}

await main();
