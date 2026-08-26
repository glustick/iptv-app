import { FormEvent, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

export function LoginScreen(): JSX.Element {
  const profiles = useAppStore((s) => s.profiles)
  const status = useAppStore((s) => s.status)
  const error = useAppStore((s) => s.error)
  const addProfile = useAppStore((s) => s.addProfile)
  const connect = useAppStore((s) => s.connect)
  const removeProfile = useAppStore((s) => s.removeProfile)

  const [name, setName] = useState('')
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const connecting = status === 'connecting'

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!server || !username || !password) return
    await addProfile({ name: name || server, server, username, password })
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>Connect to your Xtream provider</h1>
        <p className="login-subtitle">
          Enter the Xtream Codes portal URL and account credentials your provider gave you.
        </p>

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Profile name (optional)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Provider" />
          </label>
          <label>
            Server URL
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="http://example.com:8080"
              required
            />
          </label>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </form>

        {profiles.length > 0 && (
          <div className="saved-profiles">
            <h2>Saved profiles</h2>
            <ul>
              {profiles.map((p) => (
                <li key={p.id}>
                  <button className="profile-connect" onClick={() => connect(p.id)} disabled={connecting}>
                    {p.name}
                    <span className="profile-meta">
                      {p.username}@{p.server}
                    </span>
                  </button>
                  <button className="profile-remove" onClick={() => removeProfile(p.id)} title="Remove">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
