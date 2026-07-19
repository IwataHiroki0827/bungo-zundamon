import { expect, type Page } from '@playwright/test';

export const PAGES_PATH = '/bungo-zundamon/';

declare global {
  interface Window {
    __audioInstances: Array<EventTarget & {
      currentTime: number;
      paused: boolean;
      src: string;
    }>;
    __audioFetches: string[];
    __audioPlayFailure: boolean;
    __cspViolations: string[];
  }
}

/**
 * 本番コードのAudioPort境界へ、network取得だけ実際に行う決定的なadapterを注入する。
 * Chromiumのcodec/autoplay差ではなく、アプリの状態遷移と遅延取得契約を検査する。
 */
export async function installDeterministicAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__audioInstances = [];
    window.__audioFetches = [];
    window.__audioPlayFailure = false;
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push(`${event.violatedDirective}:${event.blockedURI}`);
    });

    function DeterministicAudio(): HTMLAudioElement {
      // NativeAudioを生成するとWebKitがsrc設定時に実メディアのerrorを発火し、
      // 決定的adapterの状態遷移へ混入する。EventTargetだけを持つ純粋なdoubleにする。
      const audio = new EventTarget() as HTMLAudioElement;
      let paused = true;
      let currentTime = 0;
      let src = '';
      let pending: Promise<void> = Promise.resolve();
      Object.defineProperty(audio, 'paused', { configurable: true, get: () => paused });
      Object.defineProperty(audio, 'currentTime', {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; },
      });
      Object.defineProperty(audio, 'src', {
        configurable: true,
        get: () => src,
        set: (value: string) => { src = value; },
      });
      audio.preload = 'none';
      audio.load = (): void => {
        const requested = audio.src;
        window.__audioFetches.push(requested);
        pending = fetch(requested).then((response) => {
          if (!response.ok) throw new Error(`audio-http-${response.status}`);
        });
      };
      audio.play = async (): Promise<void> => {
        if (window.__audioPlayFailure) {
          throw new DOMException('play rejected by test adapter', 'NotAllowedError');
        }
        await pending;
        paused = false;
      };
      audio.pause = (): void => { paused = true; };
      window.__audioInstances.push(audio);
      return audio;
    }

    Object.defineProperty(window, 'Audio', {
      configurable: true,
      writable: true,
      value: DeterministicAudio,
    });
  });
}

export async function openAuthor(page: Page): Promise<void> {
  await page.goto('#/');
  await expect(page.getByRole('heading', { level: 1, name: '文豪ずんだもん' })).toBeVisible();
  await page.getByRole('link', { name: '作品と台詞を聴く' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'あくたがわずんのすけ' })).toBeVisible();
}

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}
