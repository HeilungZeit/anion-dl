import { describe, expect, test } from 'bun:test';

import { toVideos } from './cvh.service';
import { isCvhDubbing, isCvhLocator, voiceOf } from './video-source';

describe('toVideos', () => {
  test('делает из серии плейлиста обычный Video с локатором и меткой', () => {
    const [video] = toVideos([
      { vkId: '9956747926256', voice: 'AniDUB', episode: 3 },
    ]);

    expect(video.videoId).toBe(9956747926256);
    expect(video.iframeUrl).toBe('cvh:9956747926256');
    expect(video.number).toBe('3');
    expect(video.data.dubbing).toBe('AniDUB (CVH)');
    expect(video.data.player).not.toContain('Kodik');
  });

  test('схлопывает повторы одной озвучки и серии', () => {
    const videos = toVideos([
      { vkId: '1', voice: 'AniDUB', episode: 1 },
      { vkId: '2', voice: 'AniDUB', episode: 1 },
      { vkId: '3', voice: 'Субтитры', episode: 1 },
    ]);

    expect(videos.map((video) => video.iframeUrl)).toEqual([
      'cvh:1',
      'cvh:3',
    ]);
  });
});

describe('метка источника', () => {
  test('одноимённые студии двух источников различаются', () => {
    expect(isCvhDubbing('AniDUB')).toBe(false);
    expect(isCvhDubbing('AniDUB (CVH)')).toBe(true);
    expect(voiceOf('AniDUB (CVH)')).toBe('AniDUB');
    expect(voiceOf('AniDUB')).toBe('AniDUB');
  });

  test('локатор Kodik не принимается за CDNVideoHub', () => {
    expect(isCvhLocator('https://kodikplayer.com/seria/1/abc/720p')).toBe(false);
    expect(isCvhLocator('cvh:1')).toBe(true);
  });
});
