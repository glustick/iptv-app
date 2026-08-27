import { useAppStore } from '../store/useAppStore'
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

  const { width, startDrag } = useResizableWidth(sidebarWidth, 1, {
    min: 160,
    max: 360,
    onCommit: (w) => updateSettings({ sidebarWidth: w })
  })

  if (viewMode === 'favorites') return null

  const isLocked = (categoryId: string): boolean =>
    !!parentalPin && lockedCategoryIds.includes(categoryId) && !unlockedCategoryIds.includes(categoryId)

  return (
    // The resize handle lives in this non-scrolling wrapper, not inside the scrollable
    // <nav> — a position:absolute child of a scrolled overflow:auto element scrolls with
    // it, which would carry the handle out of view once the category list is long enough
    // to scroll (240 categories on a real test account made this very reproducible).
    <div className="sidebar" style={{ width }}>
      <nav className="sidebar-scroll">
        <button
          className={selectedCategoryId === null ? 'category active' : 'category'}
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
