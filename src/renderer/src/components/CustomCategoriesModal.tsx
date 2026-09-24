import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { kindOf } from '../lib/customCategories'
import { channelEntryFor } from '../lib/channelIdentity'
import type { CustomCategoryKind, LiveStream, SeriesItem, VodStream } from '../lib/types'

// The manager for "My Categories" (the sidebar's own section above the provider categories).
// Three jobs, all persisted into settings.customCategories the moment they happen: create/rename/
// delete a category, put channels in it, and put them in the order they should appear in the
// grid. Reordering is drag-and-drop AND ⬆⬇ buttons — the buttons aren't just a fallback for
// people who don't drag, they're the keyboard-accessible path to the same thing.
const CHANNEL_LIST_CAP = 60

export function CustomCategoriesModal(): JSX.Element | null {
  const open = useAppStore((s) => s.customCategoriesOpen)
  const close = useAppStore((s) => s.closeCustomCategories)
  const categories = useAppStore((s) => s.settings.customCategories)
  const liveCatalog = useAppStore((s) => s.numericChannelCatalog)
  const vodCatalog = useAppStore((s) => s.vodCatalog)
  const seriesCatalog = useAppStore((s) => s.seriesCatalog)
  const viewMode = useAppStore((s) => s.viewMode)
  const selectedCustomCategoryId = useAppStore((s) => s.selectedCustomCategoryId)
  const createCustomCategory = useAppStore((s) => s.createCustomCategory)
  const renameCustomCategory = useAppStore((s) => s.renameCustomCategory)
  const deleteCustomCategory = useAppStore((s) => s.deleteCustomCategory)
  const addChannelsToCustomCategory = useAppStore((s) => s.addChannelsToCustomCategory)
  const removeChannelFromCustomCategory = useAppStore((s) => s.removeChannelFromCustomCategory)
  const reorderCustomCategoryChannels = useAppStore((s) => s.reorderCustomCategoryChannels)
  // Membership entries are resolved through the playlist they came from, so the catalog's own
  // channel keys have to be built with the same primary the store uses (see channelEntryFor).
  const primaryPlaylistId = useAppStore((s) => s.primaryPlaylistId)
  const reorderCustomCategories = useAppStore((s) => s.reorderCustomCategories)
  const ensureCustomCategoryCatalog = useAppStore((s) => s.ensureCustomCategoryCatalog)
  const requestCustomCategory = useAppStore((s) => s.requestCustomCategory)

  // Which kind of grouping is being managed. Initialised from the tab the user was on, and reset
  // to it every time the modal opens, so opening it from Movies lands on Movies.
  const [tab, setTab] = useState<CustomCategoryKind>('live')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [search, setSearch] = useState('')
  // Index being dragged / currently hovered as a drop target, both over the DISPLAYED order
  // (which is the stored order — see CustomCategory).
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  // Separate drag state for the category list on the left — a drag in one list must never
  // highlight rows in the other.
  const [catDragIndex, setCatDragIndex] = useState<number | null>(null)
  const [catOverIndex, setCatOverIndex] = useState<number | null>(null)

  const tabCategories = categories.filter((cat) => kindOf(cat) === tab)

  // Default to whatever the sidebar has selected (or the first category OF THIS KIND) rather than
  // opening on an empty right-hand pane the user has to fill by clicking.
  const active =
    tabCategories.find((c) => c.id === editingId) ??
    tabCategories.find((c) => c.id === selectedCustomCategoryId) ??
    tabCategories[0] ??
    null

  useEffect(() => {
    setNameDraft(active?.name ?? '')
  }, [active?.id, active?.name])

  // Opening the manager jumps to the kind the user was browsing, and loads that kind's catalog
  // for the "add" list. Switching tabs loads the newly-selected kind's.
  useEffect(() => {
    if (!open) return
    setTab(viewMode === 'movies' ? 'movie' : viewMode === 'series' ? 'series' : 'live')
    setEditingId(null)
  }, [open, viewMode])

  useEffect(() => {
    if (open) void ensureCustomCategoryCatalog(tab)
  }, [open, tab, ensureCustomCategoryCatalog])

  if (!open) return null

  // One catalog per kind, and one id accessor for all three shapes (live/VOD use stream_id,
  // series uses series_id) — the stored ids and the ordering logic are identical.
  const catalogItems: Array<LiveStream | VodStream | SeriesItem> =
    (tab === 'movie' ? vodCatalog : tab === 'series' ? seriesCatalog : liveCatalog) ?? []
  const itemId = (item: LiveStream | VodStream | SeriesItem): number => ('series_id' in item ? item.series_id : item.stream_id)
  // What actually gets stored for an item. Live channels are keyed per playlist (a plain id for the
  // ones on the primary playlist — the shape every entry written before multi-playlist has — and a
  // qualified key for the rest); movies and series only exist on the primary, so they stay numeric.
  const itemEntry = (item: LiveStream | VodStream | SeriesItem): number | string =>
    tab === 'live'
      ? channelEntryFor((item as LiveStream).playlistId, itemId(item), primaryPlaylistId)
      : itemId(item)
  const catalogLoaded = catalogItems.length > 0
  const itemNoun = tab === 'live' ? 'channel' : tab === 'movie' ? 'movie' : 'series'

  // String-keyed: a stored entry may be `42` or `'42'`, and the two must be the same channel.
  const byEntry = new Map(catalogItems.map((item) => [String(itemEntry(item)), item]))
  const missingCount = active ? active.streamIds.length - active.streamIds.filter((id) => byEntry.has(String(id))).length : 0

  const query = search.trim().toLowerCase()
  const candidates = catalogItems.filter(
    (item) =>
      (active ? !active.streamIds.some((id) => String(id) === String(itemEntry(item))) : false) &&
      (!query || item.name.toLowerCase().includes(query))
  )
  const shownCandidates = candidates.slice(0, CHANNEL_LIST_CAP)

  function move(index: number, delta: number): void {
    if (!active) return
    reorderCustomCategoryChannels(active.id, index, index + delta)
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-card custom-cat-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>My Categories</h2>
          <button className="modal-close" onClick={close}>
            ✕
          </button>
        </div>

        <p className="settings-hint custom-cat-list-hint">
          Drag the ⠿ handles (or use ⬆⬇) to set the order these categories appear in the sidebar.
        </p>
        <div className="custom-cat-tabs">
          {(['live', 'movie', 'series'] as const).map((kind) => (
            <button
              key={kind}
              className={tab === kind ? 'choice-button active' : 'choice-button'}
              onClick={() => setTab(kind)}
            >
              {kind === 'live' ? 'Live TV' : kind === 'movie' ? 'Movies' : 'Series'}
            </button>
          ))}
        </div>

        <div className="custom-cat-body">
          <ul className="custom-cat-list">
            {tabCategories.length === 0 && (
              <li className="settings-hint">No {tab === 'live' ? 'live TV' : itemNoun} categories yet — create one below.</li>
            )}
            {tabCategories.map((cat, index) => (
              <li
                key={cat.id}
                draggable
                onDragStart={(e) => {
                  setCatDragIndex(index)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (catOverIndex !== index) setCatOverIndex(index)
                }}
                onDragEnd={() => {
                  setCatDragIndex(null)
                  setCatOverIndex(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (catDragIndex !== null) reorderCustomCategories(catDragIndex, index)
                  setCatDragIndex(null)
                  setCatOverIndex(null)
                }}
                className={
                  'custom-cat-channel' +
                  (catDragIndex === index ? ' dragging' : '') +
                  (catOverIndex === index && catDragIndex !== index ? ' drop-target' : '')
                }
              >
                <span className="custom-cat-handle" title="Drag to reorder" aria-hidden="true">
                  ⠿
                </span>
                <button
                  className={active?.id === cat.id ? 'custom-cat-name-button active' : 'custom-cat-name-button'}
                  onClick={() => setEditingId(cat.id)}
                >
                  {cat.name}
                </button>
                <span className="category-count">{cat.streamIds.length}</span>
                <span className="custom-cat-channel-actions">
                  <button
                    className="icon-button"
                    disabled={index === 0}
                    onClick={() => reorderCustomCategories(index, index - 1)}
                    aria-label={`Move ${cat.name} up`}
                    title="Move up"
                  >
                    ⬆
                  </button>
                  <button
                    className="icon-button"
                    disabled={index === tabCategories.length - 1}
                    onClick={() => reorderCustomCategories(index, index + 1)}
                    aria-label={`Move ${cat.name} down`}
                    title="Move down"
                  >
                    ⬇
                  </button>
                </span>
              </li>
            ))}
            <li className="pin-set-row custom-cat-new">
              <input
                type="text"
                placeholder="New category name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                disabled={!newName.trim()}
                onClick={() => {
                  setEditingId(createCustomCategory(newName, tab))
                  setNewName('')
                }}
              >
                Create
              </button>
            </li>
          </ul>

          <div className="custom-cat-detail">
            {!active ? (
              <p className="settings-hint">Create a category to start adding channels to it.</p>
            ) : (
              <>
                <div className="custom-cat-actions">
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') renameCustomCategory(active.id, nameDraft)
                    }}
                    aria-label="Category name"
                  />
                  <button
                    className="secondary-button"
                    disabled={!nameDraft.trim() || nameDraft.trim() === active.name}
                    onClick={() => renameCustomCategory(active.id, nameDraft)}
                  >
                    Rename
                  </button>
                  <button className="secondary-button" onClick={() => requestCustomCategory(active.id)}>
                    View in guide
                  </button>
                  <button
                    className="danger-link"
                    onClick={() => {
                      if (window.confirm(`Delete the category "${active.name}"? The channels themselves are not removed.`)) {
                        deleteCustomCategory(active.id)
                        setEditingId(null)
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>

                <h4 className="custom-cat-heading">
                  {tab === 'live' ? 'Channels' : tab === 'movie' ? 'Movies' : 'Series'} in this category — drag to
                  reorder ({active.streamIds.length})
                </h4>
                {missingCount > 0 && (
                  <p className="settings-hint">
                    {missingCount} entr{missingCount === 1 ? 'y' : 'ies'} in this category belong to a different provider —
                    they&apos;re kept in place and reappear if you connect to that provider again.
                  </p>
                )}
                {active.streamIds.length === 0 ? (
                  <p className="settings-hint">Nothing here yet — add some from the list below.</p>
                ) : (
                  <ul className="custom-cat-channels">
                    {active.streamIds.map((entry, index) => {
                      const channel = byEntry.get(String(entry))
                      const isMissing = channel === undefined
                      return (
                        <li
                          key={String(entry)}
                          draggable
                          onDragStart={(e) => {
                            setDragIndex(index)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragOver={(e) => {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (overIndex !== index) setOverIndex(index)
                          }}
                          onDragEnd={() => {
                            setDragIndex(null)
                            setOverIndex(null)
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            if (dragIndex !== null) reorderCustomCategoryChannels(active.id, dragIndex, index)
                            setDragIndex(null)
                            setOverIndex(null)
                          }}
                          className={
                            'custom-cat-channel' +
                            (dragIndex === index ? ' dragging' : '') +
                            (overIndex === index && dragIndex !== index ? ' drop-target' : '')
                          }
                        >
                          <span className="custom-cat-handle" title="Drag to reorder" aria-hidden="true">
                            ⠿
                          </span>
                          <span className="custom-cat-channel-name">
                            {channel?.name ?? `Channel #${entry}`}
                            {isMissing && <span className="custom-cat-missing"> (not in this provider)</span>}
                          </span>
                          <span className="custom-cat-channel-actions">
                            <button
                              className="icon-button"
                              disabled={index === 0}
                              onClick={() => move(index, -1)}
                              aria-label={`Move ${channel?.name ?? entry} up`}
                              title="Move up"
                            >
                              ⬆
                            </button>
                            <button
                              className="icon-button"
                              disabled={index === active.streamIds.length - 1}
                              onClick={() => move(index, 1)}
                              aria-label={`Move ${channel?.name ?? entry} down`}
                              title="Move down"
                            >
                              ⬇
                            </button>
                            <button
                              className="danger-link"
                              onClick={() => removeChannelFromCustomCategory(active.id, entry)}
                              aria-label={`Remove ${channel?.name ?? entry} from this category`}
                            >
                              Remove
                            </button>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}

                <h4 className="custom-cat-heading">Add {tab === 'live' ? 'channels' : itemNoun}</h4>
                <input
                  type="text"
                  placeholder={catalogLoaded ? `Search ${candidates.length} available ${itemNoun}…` : `Loading your ${itemNoun} list…`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={!catalogLoaded}
                />
                <div className="epg-mapping-options custom-cat-candidates">
                  {shownCandidates.map((item) => (
                    <button
                      key={String(itemEntry(item))}
                      type="button"
                      className="epg-mapping-option"
                      onClick={() => addChannelsToCustomCategory(active.id, [itemEntry(item)])}
                    >
                      {item.name} <small>#{itemId(item)}</small>
                    </button>
                  ))}
                  {catalogLoaded && candidates.length === 0 && (
                    <p className="epg-mapping-empty">
                      {query ? `No ${itemNoun} match.` : `Every ${itemNoun} is already in this category.`}
                    </p>
                  )}
                  {candidates.length > CHANNEL_LIST_CAP && (
                    <p className="epg-mapping-empty">
                      Showing the first {CHANNEL_LIST_CAP} of {candidates.length} — refine the search to narrow it down.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
