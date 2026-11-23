import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { kindOf } from '../lib/customCategories'
import type { CustomCategoryKind } from '../lib/types'
import { useResizableWidth } from '../lib/useResizableWidth'
import { channelKeyBelongsToPlaylist } from '../lib/channelIdentity'
import { visibleCategories, hiddenCategories } from '../lib/categoryVisibility'

export function Sidebar(): JSX.Element | null {
  const viewMode = useAppStore((s) => s.viewMode)
  const categories = useAppStore((s) => s.categories)
  const playlists = useAppStore((s) => s.playlists)
  const selectedPlaylistId = useAppStore((s) => s.selectedPlaylistId)
  const profiles = useAppStore((s) => s.profiles)
  const setPlaylistEnabled = useAppStore((s) => s.setPlaylistEnabled)
  const settings = useAppStore((s) => s.settings)
  const selectedCategoryId = useAppStore((s) => s.selectedCategoryId)
  const requestCategory = useAppStore((s) => s.requestCategory)
  const lockedCategoryIds = useAppStore((s) => s.settings.lockedCategoryIds)
  const parentalPin = useAppStore((s) => s.settings.parentalPin)
  const unlockedCategoryIds = useAppStore((s) => s.unlockedCategoryIds)
  const sidebarWidth = useAppStore((s) => s.settings.sidebarWidth)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const hiddenChannelKeys = useAppStore((s) => s.settings.hiddenChannelKeys)
  const selectedPlaylistIdForCount = useAppStore((s) => s.selectedPlaylistId)
  const primaryPlaylistIdForCount = useAppStore((s) => s.primaryPlaylistId)
  // Hidden channels belonging to the playlist being browsed (see lib/channelIdentity): a channel
  // hidden on another playlist is not what this control offers to reveal.
  const hiddenCount = hiddenChannelKeys.filter((key) =>
    channelKeyBelongsToPlaylist(key, selectedPlaylistIdForCount, primaryPlaylistIdForCount)
  ).length
  const showHidden = useAppStore((s) => s.showHiddenLiveChannels)
  const setShowHidden = useAppStore((s) => s.setShowHiddenLiveChannels)
  // Provider-category hide (0.49.0): the toggle action, the read, and the collapsed-by-default
  // reveal section's own open state (session-local — the persisted state is the hidden set).
  const toggleCategoryHidden = useAppStore((s) => s.toggleCategoryHidden)
  const [showHiddenCategories, setShowHiddenCategories] = useState(false)
  // One render helper for BOTH category paths (grouped and flat): filters out the hidden set,
  // and every visible row carries the hide affordance — a span (not a nested button, which
  // would be invalid HTML) whose click stops propagation so hiding never also selects.
  function renderCategoryButtons(
    cats: Array<{ category_id: string; category_name: string }>,
    playlistId: string | null
  ): Array<JSX.Element> {
    return visibleCategories(cats, playlistId, settings.hiddenCategoryIds).map((cat) => (
      <button
        key={`${playlistId ?? 'primary'}:${cat.category_id}`}
        className={
          (playlists.length > 1
            ? selectedPlaylistId === playlistId && selectedCategoryId === cat.category_id
            : selectedCategoryId === cat.category_id)
            ? 'category active'
            : 'category'
        }
        onClick={() => requestCategory(cat.category_id, playlistId ?? undefined)}
      >
        {isLocked(cat.category_id) && <span className="category-lock">🔒</span>}
        {cat.category_name}
        <span
          className="category-hide"
          onClick={(e) => {
            e.stopPropagation()
            toggleCategoryHidden(playlistId, cat.category_id)
          }}
          title="Hide this category from the sidebar"
        >
          ⊖
        </span>
      </button>
    ))
  }

  const customCategories = useAppStore((s) => s.settings.customCategories)
  const selectedCustomCategoryId = useAppStore((s) => s.selectedCustomCategoryId)
  const requestCustomCategory = useAppStore((s) => s.requestCustomCategory)
  const openCustomCategories = useAppStore((s) => s.openCustomCategories)
  const renameCustomCategory = useAppStore((s) => s.renameCustomCategory)
  const deleteCustomCategory = useAppStore((s) => s.deleteCustomCategory)
  // Inline rename, so the two things a user reaches for most (renaming, deleting a category they
  // just made) don't require opening the manager. Deleting is confirmed because it discards the
  // curation, even though it never touches the channels themselves.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  function commitRename(id: string): void {
    renameCustomCategory(id, renameDraft)
    setRenamingId(null)
  }

  function confirmDelete(id: string, name: string): void {
    if (window.confirm(`Delete the category "${name}"? The channels themselves are not removed.`)) {
      deleteCustomCategory(id)
    }
  }

  const { width, startDrag } = useResizableWidth(sidebarWidth, 1, {
    min: 160,
    max: 360,
    onCommit: (w) => updateSettings({ sidebarWidth: w })
  })

  // "My Categories" are per-kind: the Live TV sections list live-channel groupings, the Movies
  // tab lists movie ones, Series lists series ones — one section, filtered to whichever catalog
  // this tab actually browses.
  const categoryKind: CustomCategoryKind = viewMode === 'movies' ? 'movie' : viewMode === 'series' ? 'series' : 'live'
  const myCategories = customCategories.filter((cat) => kindOf(cat) === categoryKind)

  if (viewMode === 'favorites' || viewMode === 'history' || viewMode === 'sports') return null

  // Namespaced by section since Xtream doesn't guarantee category_id uniqueness across
  // Live/Movies/Series — see useAppStore's requestCategory and setCategoryLocked.
  const isLocked = (categoryId: string): boolean => {
    const lockKey = `${viewMode}:${categoryId}`
    return !!parentalPin && lockedCategoryIds.includes(lockKey) && !unlockedCategoryIds.includes(lockKey)
  }

  return (
    // The resize handle lives in this non-scrolling wrapper, not inside the scrollable
    // <nav> — a position:absolute child of a scrolled overflow:auto element scrolls with
    // it, which would carry the handle out of view once the category list is long enough
    // to scroll (240 categories on a real test account made this very reproducible).
    <div className="sidebar" style={{ width }}>
      <nav className="sidebar-scroll">
        {/* "My Categories" sits ABOVE everything else — the user's own groupings are the ones
            they reach for daily, and the provider's hundreds of categories are the fallback.
            Lives in the same scroll container so a long provider list can't push it out of
            reach. Present on every tab that has a catalog to group (Live TV, Multi-View, Movies,
            Series), filtered to that tab's kind. */}
        {(
          <div className="my-categories">
            <div className="my-categories-header">
              <span className="my-categories-title">My Categories</span>
              <button
                className="my-categories-manage"
                onClick={openCustomCategories}
                title="Create, rename, fill and reorder your own categories"
              >
                Manage
              </button>
            </div>
            {myCategories.length === 0 ? (
              <p className="my-categories-empty">None yet — Manage to create one.</p>
            ) : (
              myCategories.map((cat) => (
                <div key={cat.id} className="my-categories-row">
                  {renamingId === cat.id ? (
                    <input
                      className="my-categories-rename"
                      // A callback ref rather than autoFocus: this input is mounted dynamically, and
                      // prop-based autofocus only applies to elements present in the initial parse.
                      ref={(el) => el?.focus()}
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(cat.id)
                        if (e.key === 'Escape') {
                          // Stop the app's central Escape handler from closing something else
                          // behind the sidebar while the user is just backing out of a rename.
                          e.stopPropagation()
                          setRenamingId(null)
                        }
                      }}
                      onBlur={() => commitRename(cat.id)}
                      aria-label={`New name for ${cat.name}`}
                    />
                  ) : (
                    <button
                      className={selectedCustomCategoryId === cat.id ? 'category active' : 'category'}
                      onClick={() => requestCustomCategory(cat.id)}
                      title={`${cat.streamIds.length} channel${cat.streamIds.length === 1 ? '' : 's'}`}
                    >
                      {cat.name}
                      <span className="category-count">{cat.streamIds.length}</span>
                    </button>
                  )}
                  <span className="my-categories-actions">
                    <button
                      className="icon-button"
                      title="Rename"
                      aria-label={`Rename ${cat.name}`}
                      onClick={() => {
                        setRenameDraft(cat.name)
                        setRenamingId(cat.id)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-button"
                      title="Delete this category"
                      aria-label={`Delete ${cat.name}`}
                      onClick={() => confirmDelete(cat.id, cat.name)}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        )}
        {viewMode === 'live' && hiddenCount > 0 && (
          <button className={showHidden ? 'category active' : 'category'} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? 'Hide hidden channels' : `Show hidden channels (${hiddenCount})`}
          </button>
        )}
        {/* With more than one playlist connected the categories are grouped per playlist, so it is
            always clear which account a channel came from and which line-up you are browsing. With
            one, this collapses to precisely the flat list it has always been. */}
        {playlists.length > 1
          ? playlists.map((playlist) => (
              <div key={playlist.profileId} className="category-group">
                <div className="category-group-head" title={playlist.name}>
                  {playlist.name}
                  {playlist.error && <span className="category-group-error" title={playlist.error}> ⚠</span>}
                </div>
                <button
                  className={
                    selectedPlaylistId === playlist.profileId && selectedCategoryId === null && selectedCustomCategoryId === null
                      ? 'category active'
                      : 'category'
                  }
                  onClick={() => requestCategory(null, playlist.profileId)}
                >
                  All
                </button>
                {renderCategoryButtons(playlist.categories, playlist.profileId)}
                {playlist.categories.length === 0 && (
                  <div className="category-group-empty">{playlist.error ? 'Not connected' : 'No categories'}</div>
                )}
              </div>
            ))
          : (
              <>
                <button
                  className={selectedCategoryId === null && selectedCustomCategoryId === null ? 'category active' : 'category'}
                  onClick={() => requestCategory(null)}
                >
                  All
                </button>
                {renderCategoryButtons(categories, null)}
              </>
            )}
        {(() => {
          // The reveal section (0.49.0): one row per playlist group with hidden categories, or a
          // single row on the flat path — collapsed by default, restore-only (un-hiding never
          // selects; selecting a visible category is the normal path).
          const groups: Array<{ profileId: string | null; name: string | null; cats: typeof categories }> =
            playlists.length > 1
              ? playlists.map((playlist) => ({
                  profileId: playlist.profileId,
                  name: playlist.name,
                  cats: hiddenCategories(playlist.categories, playlist.profileId, settings.hiddenCategoryIds)
                }))
              : [{ profileId: null, name: null, cats: hiddenCategories(categories, null, settings.hiddenCategoryIds) }]
          const total = groups.reduce((sum, g) => sum + g.cats.length, 0)
          if (total === 0) return null
          return (
            <div className="hidden-categories">
              <button
                className="category hidden-categories-toggle"
                onClick={() => setShowHiddenCategories(!showHiddenCategories)}
              >
                {showHiddenCategories ? 'Hide hidden categories' : `Show hidden categories (${total})`}
              </button>
              {showHiddenCategories &&
                groups.map((group, gi) =>
                  group.cats.map((cat) => (
                    <button
                      key={`hidden-${group.profileId ?? 'primary'}:${group.name ?? ''}:${cat.category_id}:${gi}`}
                      className="category category-hidden-row"
                      onClick={() => toggleCategoryHidden(group.profileId, cat.category_id)}
                      title="Restore this category to the list"
                    >
                      ⊙ {cat.category_name}
                    </button>
                  ))
                )}
            </div>
          )
        })()}
      </nav>
      {/* Where a playlist is shown or hidden. Hiding is modelled as "not connected" (see
          AppSettings.enabledPlaylistIds): the point of hiding is to stop carrying a few thousand
          channels, so its catalogue is not loaded at all — which also means the re-show control
          cannot live on the group it hides, hence this list. */}
      {profiles.length > 1 && (
        <div className="sidebar-playlists">
          <div className="sidebar-playlists-head">Playlists</div>
          {profiles.map((profile) => {
            const enabled = settings.enabledPlaylistIds.includes(profile.id)
            return (
              <button
                key={profile.id}
                className="sidebar-playlist-toggle"
                onClick={() => void setPlaylistEnabled(profile.id, !enabled)}
                title={enabled ? `Hide ${profile.name} (stops loading it)` : `Show ${profile.name}`}
              >
                <span aria-hidden="true">{enabled ? '👁' : '⊘'}</span>
                <span className="sidebar-playlist-name">{profile.name}</span>
              </button>
            )
          })}
        </div>
      )}
      <div className="resize-handle resize-handle--right" onMouseDown={startDrag} />
    </div>
  )
}
