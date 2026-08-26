import { useAppStore } from '../store/useAppStore'

export function Sidebar(): JSX.Element | null {
  const viewMode = useAppStore((s) => s.viewMode)
  const categories = useAppStore((s) => s.categories)
  const selectedCategoryId = useAppStore((s) => s.selectedCategoryId)
  const requestCategory = useAppStore((s) => s.requestCategory)
  const lockedCategoryIds = useAppStore((s) => s.settings.lockedCategoryIds)
  const parentalPin = useAppStore((s) => s.settings.parentalPin)
  const unlockedCategoryIds = useAppStore((s) => s.unlockedCategoryIds)

  if (viewMode === 'favorites') return null

  const isLocked = (categoryId: string): boolean =>
    !!parentalPin && lockedCategoryIds.includes(categoryId) && !unlockedCategoryIds.includes(categoryId)

  return (
    <nav className="sidebar">
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
  )
}
