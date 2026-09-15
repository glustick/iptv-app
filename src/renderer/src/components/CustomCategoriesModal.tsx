import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

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
  const catalog = useAppStore((s) => s.numericChannelCatalog)
  const selectedCustomCategoryId = useAppStore((s) => s.selectedCustomCategoryId)
  const createCustomCategory = useAppStore((s) => s.createCustomCategory)
  const renameCustomCategory = useAppStore((s) => s.renameCustomCategory)
  const deleteCustomCategory = useAppStore((s) => s.deleteCustomCategory)
  const addChannelsToCustomCategory = useAppStore((s) => s.addChannelsToCustomCategory)
  const removeChannelFromCustomCategory = useAppStore((s) => s.removeChannelFromCustomCategory)
  const reorderCustomCategoryChannels = useAppStore((s) => s.reorderCustomCategoryChannels)
  const reorderCustomCategories = useAppStore((s) => s.reorderCustomCategories)
  const ensureChannelCatalog = useAppStore((s) => s.ensureChannelCatalog)
  const requestCustomCategory = useAppStore((s) => s.requestCustomCategory)

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

  // Default to whatever the sidebar has selected (or the first category) rather than opening on
  // an empty right-hand pane the user has to fill by clicking.
  const active =
    categories.find((c) => c.id === editingId) ??
    categories.find((c) => c.id === selectedCustomCategoryId) ??
    categories[0] ??
    null

  useEffect(() => {
    setNameDraft(active?.name ?? '')
  }, [active?.id, active?.name])

  useEffect(() => {
    if (open) void ensureChannelCatalog()
  }, [open, ensureChannelCatalog])

  if (!open) return null

  const byId = new Map((catalog ?? []).map((s) => [s.stream_id, s]))
  const missingCount = active ? active.streamIds.length - active.streamIds.filter((id) => byId.has(id)).length : 0

  const query = search.trim().toLowerCase()
  const candidates = (catalog ?? []).filter(
    (s) => (active ? !active.streamIds.includes(s.stream_id) : false) && (!query || s.name.toLowerCase().includes(query))
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
        <div className="custom-cat-body">
          <ul className="custom-cat-list">
            {categories.length === 0 && <li className="settings-hint">No categories yet — create your first one below.</li>}
            {categories.map((cat, index) => (
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
                    disabled={index === categories.length - 1}
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
                  setEditingId(createCustomCategory(newName))
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
                  Channels in this category — drag to reorder ({active.streamIds.length})
                </h4>
                {missingCount > 0 && (
                  <p className="settings-hint">
                    {missingCount} channel{missingCount === 1 ? '' : 's'} in this category belong to a different provider —
                    they&apos;re kept in place and reappear if you connect to that provider again.
                  </p>
                )}
                {active.streamIds.length === 0 ? (
                  <p className="settings-hint">No channels yet — add some from the list below.</p>
                ) : (
                  <ul className="custom-cat-channels">
                    {active.streamIds.map((streamId, index) => {
                      const channel = byId.get(streamId)
                      const isMissing = channel === undefined
                      return (
                        <li
                          key={streamId}
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
                            {channel?.name ?? `Channel #${streamId}`}
                            {isMissing && <span className="custom-cat-missing"> (not in this provider)</span>}
                          </span>
                          <span className="custom-cat-channel-actions">
                            <button
                              className="icon-button"
                              disabled={index === 0}
                              onClick={() => move(index, -1)}
                              aria-label={`Move ${channel?.name ?? streamId} up`}
                              title="Move up"
                            >
                              ⬆
                            </button>
                            <button
                              className="icon-button"
                              disabled={index === active.streamIds.length - 1}
                              onClick={() => move(index, 1)}
                              aria-label={`Move ${channel?.name ?? streamId} down`}
                              title="Move down"
                            >
                              ⬇
                            </button>
                            <button
                              className="danger-link"
                              onClick={() => removeChannelFromCustomCategory(active.id, streamId)}
                              aria-label={`Remove ${channel?.name ?? streamId} from this category`}
                            >
                              Remove
                            </button>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}

                <h4 className="custom-cat-heading">Add channels</h4>
                <input
                  type="text"
                  placeholder={catalog ? `Search ${candidates.length} available channels…` : 'Loading your channel list…'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={!catalog}
                />
                <div className="epg-mapping-options custom-cat-candidates">
                  {shownCandidates.map((channel) => (
                    <button
                      key={channel.stream_id}
                      type="button"
                      className="epg-mapping-option"
                      onClick={() => addChannelsToCustomCategory(active.id, [channel.stream_id])}
                    >
                      {channel.name} <small>#{channel.stream_id}</small>
                    </button>
                  ))}
                  {catalog && candidates.length === 0 && (
                    <p className="epg-mapping-empty">
                      {query ? 'No channels match.' : 'Every channel is already in this category.'}
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
