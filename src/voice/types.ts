export const VOICE_WARNING_BYTES = 500_000_000;
export const VOICE_HARD_LIMIT_BYTES = 750_000_000;
export const MAX_SINGLE_ASSET_BYTES = 104_857_600;

export interface VoiceConfig {
  engineVersion: string;
  speakerUuid: string;
  speakerName: 'ずんだもん' | string;
  styleId: number;
  styleName: string;
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  outputSamplingRate: 24_000 | 48_000 | number;
  presetVersion: string;
}

export interface SpeechItem {
  candidateId: string;
  speechText?: string;
  text?: string;
  approved?: boolean;
  config?: VoiceConfig;
}

export interface AudioAsset {
  audioId: string;
  path: string;
  sha256: string;
  bytes: number;
  durationMs: number;
  configHash: string;
  candidateIds: string[];
}

export interface VoiceFailure {
  audioId: string;
  candidateIds: string[];
  reasonCode: string;
}

export interface VoiceGenerationResult {
  assets: AudioAsset[];
  failures: VoiceFailure[];
  attempted: number;
  succeeded: number;
  failed: number;
  configHash: string;
}

export interface VoicevoxSpeakerStyle {
  id: number;
  name: string;
}

export interface VoicevoxSpeaker {
  name: string;
  speaker_uuid: string;
  styles: VoicevoxSpeakerStyle[];
}

export interface VoicevoxClient {
  readonly config: Readonly<VoiceConfig>;
  readonly workspaceRoot?: string;
  getVersion(): Promise<string>;
  getSpeakers(): Promise<VoicevoxSpeaker[]>;
  createAudioQuery(text: string): Promise<unknown>;
  synthesize(query: unknown): Promise<Uint8Array>;
}

export class VoiceContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VoiceContractError';
  }
}

export class VoiceStageError extends VoiceContractError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'VoiceStageError';
  }
}
