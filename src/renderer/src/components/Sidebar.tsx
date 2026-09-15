import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { kindOf } from '../lib/customCategories'
import type { CustomCategoryKind } from '../lib/types'
import { useResizableWidth } from '../lib/useResizableWidth'

export function Sidebar(): JSX.Element | null {
  const viewMode = useAppStore((s) => s.viewMode)
  const categories = useAppStore((s) => s.categories)
  const selectedCategoryId = useAppStore((s) => s.selectedCategoryId)
  const requestCategory = useAppStore((s) => s.requestCategory)
  const lockedCategoryIds = useAppStore((s) => s.settings.lockedCategoryIds)
  const parentalPin = useAppStore((s) => s.settings.parentalPin)
  const unlockedCategoryIds = useAppStore((s) => s.unlockedCategoryIds)
  const sidebarWidth = useAppStore((s) => s.settings.sidebarWidth)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const hiddenCount = useAppStore((s) => s.settings.hiddenLiveStreamIds.length)
  const showHidden = useAppStore((s) => s.showHiddenLiveChannels)
  const setShowHidden = useAppStore((s) => s.setShowHiddenLiveChannels)

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

  if (viewMode === 'favorites' || viewMode === 'history') return null

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
        <button
          className={selectedCategoryId === null && selectedCustomCategoryId === null ? 'category active' : 'category'}
          onClick={() => requestCategory(null)}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat.category_id}
            className={selectedCategoryId === cat.category_id ? 'category active' : 'category'}
            onClick={() => requestCategory(cat.category_id)}
          >
            {isLocked(cat.category_id) && <span className="category-lock">🔒</span>}
            {cat.category_name}
          </button>
        ))}
      </nav>
      <div className="resize-handle resize-handle--right" onMouseDown={startDrag} />
    </div>
  )
}
