import { describe, expect, test } from 'bun:test';

import { BookmarkStatus, type CreateBookmarkPayload } from './account.types';
import { createBookmarkBody, updateBookmarkBody } from './bookmarks.service';

const create: CreateBookmarkPayload = {
  yumiId: 1,
  yumiSlug: 'title',
  title: 'Title',
  poster: {
    fullsize: '', big: '', small: '', medium: '', huge: '', mega: '',
  },
  status: BookmarkStatus.Watching,
};

describe('bookmark payloads', () => {
  test('create never sends watchedEpisodes', () => {
    const unsafe = { ...create, watchedEpisodes: 17 };
    expect(createBookmarkBody(unsafe)).not.toHaveProperty('watchedEpisodes');
  });

  test('update never sends watchedEpisodes', () => {
    const unsafe = {
      status: BookmarkStatus.Watched,
      watchedEpisodes: 17,
    };
    expect(updateBookmarkBody(unsafe)).toEqual({
      status: BookmarkStatus.Watched,
      totalEpisodes: undefined,
      animeStatus: undefined,
    });
  });
});
