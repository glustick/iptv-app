import { formatPlaybackPosition, type ContinueWatchingEntry } from '../lib/continueWatching'

/** A shelf card's own data: the stored position plus the catalogue's name and artwork. */
export interface ContinueWatchingItem extends ContinueWatchingEntry {
  name: string
  image: string
  extension: string
}

interface Props {
  items: ContinueWatchingItem[]
  onResume: (item: ContinueWatchingItem) => void
  onDismiss: (key: string) => void
}

/**
 * Half-watched films, above the Movies grid — the web sibling's Continue watching shelf
 * (v0.92.0), brought to the desktop. Resume and dismiss are deliberately SIBLINGS: a button
 * inside a button is invalid HTML and browsers disagree about which one a click belongs to,
 * which is the same rule the web's guide reminder bell follows.
 */
export function ContinueWatchingShelf({ items, onResume, onDismiss }: Props): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <section className="continue-watching" aria-label="Continue watching">
      <h3 className="section-heading">Continue watching</h3>
      <div className="continue-watching-row">
        {items.map((item) => (
          <div className="continue-card" key={item.key}>
            <button
              className="continue-card-main"
              onClick={() => onResume(item)}
              title={`Resume ${item.name} at ${formatPlaybackPosition(item.positionSeconds)}`}
            >
              <span className="continue-card-art">
                {item.image ? (
                  <img className="continue-card-poster" src={item.image} alt="" loading="lazy" />
                ) : (
                  <span className="continue-card-poster placeholder" />
                )}
                <span className="continue-card-progress" aria-hidden="true">
                  <span className="continue-card-progress-fill" style={{ width: `${item.fraction * 100}%` }} />
                </span>
              </span>
              <span className="continue-card-name">{item.name}</span>
              <span className="continue-card-position">
                {formatPlaybackPosition(item.positionSeconds)} of {formatPlaybackPosition(item.durationSeconds)}
              </span>
            </button>
            <button
              className="continue-card-dismiss"
              onClick={() => onDismiss(item.key)}
              title="Remove from continue watching"
              aria-label={`Remove ${item.name} from continue watching`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
