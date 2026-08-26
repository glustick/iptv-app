import { FormEvent, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

export function PinPrompt(): JSX.Element | null {
  const categoryId = useAppStore((s) => s.pinPromptCategoryId)
  const error = useAppStore((s) => s.pinPromptError)
  const submitPinAttempt = useAppStore((s) => s.submitPinAttempt)
  const cancelPinPrompt = useAppStore((s) => s.cancelPinPrompt)
  const [pin, setPin] = useState('')

  if (!categoryId) return null

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    submitPinAttempt(pin)
    setPin('')
  }

  return (
    <div className="modal-overlay" onClick={cancelPinPrompt}>
      <div className="modal-card pin-card" onClick={(e) => e.stopPropagation()}>
        <h2>Enter PIN</h2>
        <p className="modal-plot">This category is parental-locked.</p>
        <form onSubmit={handleSubmit} className="pin-form">
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          {error && <div className="login-error">{error}</div>}
          <div className="pin-actions">
            <button type="button" className="secondary-button" onClick={cancelPinPrompt}>
              Cancel
            </button>
            <button type="submit">Unlock</button>
          </div>
        </form>
      </div>
    </div>
  )
}
