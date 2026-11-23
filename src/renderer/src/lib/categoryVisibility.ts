/**
 * Per-provider-category visibility (0.49.0) — the sidebar-navigation twin of the per-channel
 * hidden keys (lib/channelIdentity + settings.hiddenChannelKeys). A provider's category list
 * can be enormous and mostly junk ("VOD 4", "XX体育5"); hiding is sidebar-only on purpose:
 * the EPG mapping editor, My Categories and the bulk apply keep full catalogue access, and
 * the numeric entry resolution (findChannelByNumber) is the one consumer that honours it.
 */

/** The composite key a hidden category is stored under — playlist-scoped, because with more
 *  than one playlist connected the same category_id is NOT unique across providers (see
 *  Sidebar's own key comment). The primary playlist's categories key with the bare id, exactly
 *  like channelIdentity keys a primary channel. */
export function categoryVisibilityKey(playlistId: string | null, categoryId: string): string {
  return playlistId ? `${playlistId}:${categoryId}` : categoryId
}

export interface CategorisedLike {
  category_id: string
}

/** The categories still visible in the sidebar: everything not in the hidden set. */
export function visibleCategories<T extends CategorisedLike>(
  categories: T[],
  playlistId: string | null,
  hiddenKeys: string[]
): T[] {
  return categories.filter((cat) => !hiddenKeys.includes(categoryVisibilityKey(playlistId, cat.category_id)))
}

/** The hidden ones, in their original order — the "Show hidden" section renders from this. */
export function hiddenCategories<T extends CategorisedLike>(
  categories: T[],
  playlistId: string | null,
  hiddenKeys: string[]
): T[] {
  return categories.filter((cat) => hiddenKeys.includes(categoryVisibilityKey(playlistId, cat.category_id)))
}
