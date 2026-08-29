import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useAppStore } from '../store/useAppStore'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// Without this, an uncaught exception anywhere in Player's render or effects (e.g. an invalid
// hls.js config) takes down the entire app to a blank screen with no visible error, since React
// unmounts the whole tree above the nearest boundary once one throws during commit. Scoped to
// just Player so a future bug here fails to "closed, with a message" instead of "everything gone."
export class PlayerErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Player crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="player-crash-overlay">
          <p>Playback crashed unexpectedly.</p>
          <p className="player-crash-detail">{this.state.error.message}</p>
          <button
            onClick={() => {
              useAppStore.getState().stop()
              this.setState({ error: null })
            }}
          >
            Close
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
