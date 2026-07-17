import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('application shell', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<main id="app"></main>';
  });

  it('サイト名を見出しとして描画する', async () => {
    await import('./main');
    expect(document.querySelector('h1')?.textContent).toBe('文豪ずんだもん');
  });
});
