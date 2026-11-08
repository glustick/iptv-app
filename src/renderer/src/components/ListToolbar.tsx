import { listOrderOptions, type ListOrder, type ListOrderKind } from '../lib/listOrder'

interface Props {
  kind: ListOrderKind
  order: ListOrder
  onOrderChange: (order: ListOrder) => void
  /** How many rows the current filter shows, and how many there were before it. */
  shown: number
  total: number
  filtering: boolean
  /** "films" / "series" — the count reads "1 of 340 films", never a bare "1 of 340". */
  noun: string
}

/**
 * The row above a catalogue list: the filter's own count (the web sibling's "1 of 3", which stops
 * a narrowed list looking like an empty category) and the ordering choice. Deliberately a native
 * <select> — the same call this app makes for the favorites group picker and the quality ceiling,
 * because a five-item picker does not need a custom menu.
 */
export function ListToolbar({ kind, order, onOrderChange, shown, total, filtering, noun }: Props): JSX.Element {
  return (
    <div className="list-toolbar">
      {filtering ? (
        <span className="list-count">
          {shown} of {total} {noun}
        </span>
      ) : (
        <span />
      )}
      <label className="list-order">
        <span className="list-order-label">Order</span>
        <select
          className="list-order-select"
          value={order}
          onChange={(e) => {
            const next = e.target.value
            // The options are the only values this can produce; checked rather than cast so a
            // hand-edited DOM cannot put an unknown order into the stored preference.
            if (next === 'provider' || next === 'az' || next === 'newest') onOrderChange(next)
          }}
        >
          {listOrderOptions(kind).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
