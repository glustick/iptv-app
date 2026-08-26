import { useAppStore } from '../store/useAppStore'

export function Sidebar(): JSX.Element {
  const categories = useAppStore((s) => s.categories)
  const selectedCategoryId = useAppStore((s) => s.selectedCategoryId)
  const selectCategory = useAppStore((s) => s.selectCategory)

  return (
    <nav className="sidebar">
      <button
        className={selectedCategoryId === null ? 'category active' : 'category'}
        onClick={() => selectCategory(null)}
      >
        All
      </button>
      {categories.map((cat) => (
        <button
          key={cat.category_id}
          className={selectedCategoryId === cat.category_id ? 'category active' : 'category'}
          onClick={() => selectCategory(cat.category_id)}
        >
          {cat.category_name}
        </button>
      ))}
    </nav>
  )
}
