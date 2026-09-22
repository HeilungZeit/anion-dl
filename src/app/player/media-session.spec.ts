import { describe, expect, it } from 'bun:test';

import { describeNowPlaying } from './media-session';

describe('describeNowPlaying', () => {
  it('ставит серию и озвучку в строку исполнителя', () => {
    expect(
      describeNowPlaying({ title: 'Фрирен', episode: '5', dubbing: 'AniLibria' })
    ).toEqual({ title: 'Фрирен', artist: '5 серия · AniLibria' });
  });

  it('обходится без озвучки', () => {
    expect(describeNowPlaying({ title: 'Фрирен', episode: '5' })).toEqual({
      title: 'Фрирен',
      artist: '5 серия',
    });
  });
});
