import http from 'node:http';

import { validateVoiceConfig } from './cache.ts';
import {
  VoiceContractError,
  type VoiceConfig,
  type VoicevoxClient,
  type VoicevoxSpeaker,
} from './types.ts';

const ALLOWED_BASES = new Set(['http://127.0.0.1:50021/', 'http://[::1]:50021/']);
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/i;
const WAV_MEDIA_TYPE = /^(?:audio\/wav|audio\/wave|audio\/x-wav)(?:\s*;|$)/i;
const FORBIDDEN_QUERY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_QUERY_DEPTH = 64;
const MAX_QUERY_NODES = 100_000;
const MAX_QUERY_STRING_LENGTH = 32_768;

export interface VoicevoxRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  timeoutMs: number;
  followRedirects: false;
  useProxy: false;
}

export interface VoicevoxResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
  finalUrl: string;
  remoteAddress: string;
}

export interface VoicevoxConnector {
  request(request: VoicevoxRequest): Promise<VoicevoxResponse>;
}

function isLoopback(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function contentType(response: VoicevoxResponse): string {
  return response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function decodeJson(response: VoicevoxResponse, label: string): unknown {
  if (!JSON_MEDIA_TYPE.test(contentType(response))) {
    throw new VoiceContractError('voice-response-media-type', `${label}のmedia typeがJSONではありません`);
  }
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new VoiceContractError('voice-response-malformed', `${label}のJSONが不正です`, { cause: error });
  }
}

interface QueryValidationState {
  nodes: number;
}

function ownPropertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch (error) {
    throw new VoiceContractError('voice-query-malformed', 'audio queryのpropertyを検証できません', { cause: error });
  }
}

function sanitizeQueryValue(value: unknown, depth: number, state: QueryValidationState): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_QUERY_NODES || depth > MAX_QUERY_DEPTH) {
    throw new VoiceContractError('voice-query-malformed', 'audio queryの構造が上限を超えています');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new VoiceContractError('voice-query-malformed', 'audio queryに有限でない数値があります');
    }
    return value;
  }
  if (typeof value === 'string') {
    if (Array.from(value).length > MAX_QUERY_STRING_LENGTH || /[\uD800-\uDFFF]/u.test(value)) {
      throw new VoiceContractError('voice-query-malformed', 'audio queryの文字列が不正です');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new VoiceContractError('voice-query-malformed', 'audio queryにJSON外の値があります');
  }

  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    throw new VoiceContractError('voice-query-malformed', 'audio queryのobjectを検証できません', { cause: error });
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new VoiceContractError('voice-query-prototype-forbidden', 'audio queryの配列prototypeが不正です');
    }
    if (value.length > MAX_QUERY_NODES) {
      throw new VoiceContractError('voice-query-malformed', 'audio queryの配列要素数が上限を超えています');
    }
    const expectedKeys = new Set([...Array.from({ length: value.length }, (_, index) => String(index)), 'length']);
    if (keys.length !== expectedKeys.size || keys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))) {
      throw new VoiceContractError('voice-query-malformed', 'audio queryの配列に予期しないpropertyがあります');
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = ownPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new VoiceContractError('voice-query-malformed', 'audio queryの配列にaccessorまたは欠損があります');
      }
      result.push(sanitizeQueryValue(descriptor.value, depth + 1, state));
    }
    return result;
  }

  if (prototype !== Object.prototype) {
    throw new VoiceContractError('voice-query-prototype-forbidden', 'audio queryのobject prototypeが不正です');
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || FORBIDDEN_QUERY_KEYS.has(key)) {
      throw new VoiceContractError('voice-query-key-forbidden', 'audio queryに危険なpropertyがあります');
    }
    const descriptor = ownPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new VoiceContractError('voice-query-malformed', 'audio queryにaccessorまたは非公開propertyがあります');
    }
    result[key] = sanitizeQueryValue(descriptor.value, depth + 1, state);
  }
  return result;
}

function fixedAudioQuery(value: unknown, config: VoiceConfig): Record<string, unknown> {
  const sanitized = sanitizeQueryValue(value, 0, { nodes: 0 });
  if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    throw new VoiceContractError('voice-query-malformed', 'audio queryはobjectである必要があります');
  }
  const query = sanitized as Record<string, unknown>;
  query.speedScale = config.speedScale;
  query.pitchScale = config.pitchScale;
  query.intonationScale = config.intonationScale;
  query.volumeScale = config.volumeScale;
  query.outputSamplingRate = config.outputSamplingRate;
  query.outputStereo = false;
  return query;
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested);
  }
  return Object.freeze(value);
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * NodeのHTTP socketを直接使用する低水準connector。URLはclient側でIP literalに固定され、
 * redirectと環境proxyを解釈しない。
 * @des DES-F001-008,DES-F001-017,DES-F001-019 @fun FUN-F001-017
 */
export class NodeVoicevoxConnector implements VoicevoxConnector {
  constructor(private readonly maxResponseBytes = 104_857_600) {}

  request(request: VoicevoxRequest): Promise<VoicevoxResponse> {
    return new Promise((resolve, reject) => {
      const operation = http.request(
        {
          protocol: 'http:',
          hostname: request.url.hostname.replace(/^\[|\]$/g, ''),
          port: 50021,
          method: request.method,
          path: `${request.url.pathname}${request.url.search}`,
          headers: request.headers,
          timeout: request.timeoutMs,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > this.maxResponseBytes) {
              operation.destroy(new VoiceContractError('voice-response-too-large', 'VOICEVOX応答が上限を超えました'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: { 'content-type': headerValue(response.headers, 'content-type') },
              body: new Uint8Array(Buffer.concat(chunks)),
              finalUrl: request.url.href,
              remoteAddress: response.socket.remoteAddress ?? '',
            });
          });
        },
      );
      operation.once('timeout', () => {
        operation.destroy(new VoiceContractError('voice-timeout', 'VOICEVOX要求がtimeoutしました'));
      });
      operation.once('error', reject);
      if (request.body) operation.write(request.body);
      operation.end();
    });
  }
}

export interface ProductionVoicevoxClientOptions {
  baseUrl: string | URL;
  config: VoiceConfig;
  connector?: VoicevoxConnector;
  workspaceRoot?: string;
  timeoutMs?: number;
  proxy?: false;
}

/** @des DES-F001-008,DES-F001-017,DES-F001-019 @fun FUN-F001-017 */
export class ProductionVoicevoxClient implements VoicevoxClient {
  readonly config: Readonly<VoiceConfig>;
  readonly workspaceRoot?: string;
  readonly baseUrl: URL;
  private readonly connector: VoicevoxConnector;
  private readonly timeoutMs: number;

  constructor(options: ProductionVoicevoxClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!ALLOWED_BASES.has(this.baseUrl.href)) {
      throw new VoiceContractError(
        'voice-endpoint-not-allowed',
        'VOICEVOX接続先はhttp://127.0.0.1:50021またはhttp://[::1]:50021だけです',
      );
    }
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new VoiceContractError('voice-endpoint-not-allowed', 'VOICEVOX接続先へ認証情報やqueryを指定できません');
    }
    if (options.proxy !== undefined && options.proxy !== false) {
      throw new VoiceContractError('voice-proxy-forbidden', 'VOICEVOX接続でproxyは使用できません');
    }
    const configSnapshot = deepFreeze(validateVoiceConfig(options.config));
    this.config = configSnapshot;
    Object.defineProperty(this, 'config', {
      value: configSnapshot,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    if (this.config.speakerName !== 'ずんだもん') {
      throw new VoiceContractError('voice-speaker-mismatch', 'production speaker名はずんだもんへ固定してください');
    }
    this.workspaceRoot = options.workspaceRoot;
    this.connector = options.connector ?? new NodeVoicevoxConnector();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) {
      throw new VoiceContractError('voice-timeout-invalid', 'timeoutは1..60000msで指定してください');
    }
  }

  private endpoint(pathname: string, parameters?: Readonly<Record<string, string>>): URL {
    if (!pathname.startsWith('/') || pathname.includes('..')) {
      throw new VoiceContractError('voice-path-invalid', 'VOICEVOX pathが不正です');
    }
    const url = new URL(pathname, this.baseUrl);
    for (const [name, value] of Object.entries(parameters ?? {})) url.searchParams.set(name, value);
    if (url.origin !== this.baseUrl.origin) throw new VoiceContractError('voice-endpoint-not-allowed', '接続先originが変化しました');
    return url;
  }

  private async request(
    method: 'GET' | 'POST',
    pathname: string,
    parameters?: Readonly<Record<string, string>>,
    body?: Uint8Array,
  ): Promise<VoicevoxResponse> {
    const url = this.endpoint(pathname, parameters);
    const response = await this.connector.request({
      url,
      method,
      headers: body ? { 'content-type': 'application/json', accept: 'application/json, audio/wav' } : { accept: 'application/json' },
      body,
      timeoutMs: this.timeoutMs,
      followRedirects: false,
      useProxy: false,
    });
    if (response.finalUrl !== url.href || (response.status >= 300 && response.status < 400)) {
      throw new VoiceContractError('voice-redirect-forbidden', 'VOICEVOX redirectを拒否しました');
    }
    if (!isLoopback(response.remoteAddress)) {
      throw new VoiceContractError('voice-remote-not-loopback', 'VOICEVOX接続先socketがloopbackではありません');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new VoiceContractError('voice-http-error', `VOICEVOXがHTTP ${response.status}を返しました`);
    }
    return response;
  }

  async getVersion(): Promise<string> {
    const value = decodeJson(await this.request('GET', '/version'), 'version');
    if (typeof value !== 'string' || !value.trim() || hasControlCharacter(value)) {
      throw new VoiceContractError('voice-version-malformed', 'VOICEVOX版が妥当な文字列ではありません');
    }
    return value;
  }

  async getSpeakers(): Promise<VoicevoxSpeaker[]> {
    const value = decodeJson(await this.request('GET', '/speakers'), 'speakers');
    if (!Array.isArray(value)) throw new VoiceContractError('voice-speakers-malformed', '話者一覧が配列ではありません');
    return value as VoicevoxSpeaker[];
  }

  async createAudioQuery(text: string): Promise<unknown> {
    const response = await this.request('POST', '/audio_query', {
      text,
      speaker: String(this.config.styleId),
    });
    return fixedAudioQuery(decodeJson(response, 'audio query'), this.config);
  }

  async synthesize(query: unknown): Promise<Uint8Array> {
    let body: Uint8Array;
    try {
      body = new TextEncoder().encode(JSON.stringify(fixedAudioQuery(query, this.config)));
    } catch (error) {
      if (error instanceof VoiceContractError) throw error;
      throw new VoiceContractError('voice-query-malformed', 'audio queryをserializeできません', { cause: error });
    }
    const response = await this.request('POST', '/synthesis', { speaker: String(this.config.styleId) }, body);
    if (!WAV_MEDIA_TYPE.test(contentType(response))) {
      throw new VoiceContractError('voice-not-wav', 'synthesis応答がWAVではありません');
    }
    return response.body;
  }
}
