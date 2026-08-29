import { FormEvent, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { ProfileKind } from '../lib/types'

export function LoginScreen(): JSX.Element {
  const profiles = useAppStore((s) => s.profiles)
  const status = useAppStore((s) => s.status)
  const error = useAppStore((s) => s.error)
  const addProfile = useAppStore((s) => s.addProfile)
  const connect = useAppStore((s) => s.connect)
  const removeProfile = useAppStore((s) => s.removeProfile)

  const [kind, setKind] = useState<ProfileKind>('xtream')
  const [name, setName] = useState('')
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [m3uUrl, setM3uUrl] = useState('')
  const [epgUrl, setEpgUrl] = useState('')

  const connecting = status === 'connecting'

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (kind === 'xtream') {
      if (!server || !username || !password) return
      await addProfile({ kind: 'xtream', name: name || server, server, username, password })
    } else {
      if (!m3uUrl) return
      await addProfile({ kind: 'm3u', name: name || m3uUrl, m3uUrl, epgUrl: epgUrl || undefined })
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>Connect to your IPTV provider</h1>

        <div className="login-kind-toggle">
          <button
            type="button"
            className={kind === 'xtream' ? 'active' : ''}
            onClick={() => setKind('xtream')}
          >
            Xtream Codes
          </button>
          <button type="button" className={kind === 'm3u' ? 'active' : ''} onClick={() => setKind('m3u')}>
            M3U Playlist
          </button>
        </div>

        {kind === 'xtream' ? (
          <p className="login-subtitle">
            Enter the Xtream Codes portal URL and account credentials your provider gave you.
          </p>
        ) : (
          <p className="login-subtitle">
            Enter a playlist URL (and, if your provider gives you one separately, an EPG guide URL). Live TV only —
            a bare M3U playlist has no structured movie/series catalog the way Xtream does.
          </p>
        )}

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Profile name (optional)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Provider" />
          </label>

          {kind === 'xtream' ? (
            <>
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
            </>
          ) : (
            <>
              <label>
                Playlist (M3U) URL
                <input
                  value={m3uUrl}
                  onChange={(e) => setM3uUrl(e.target.value)}
                  placeholder="http://example.com/playlist.m3u"
                  required
                />
              </label>
              <label>
                EPG guide URL (optional)
                <input
                  value={epgUrl}
                  onChange={(e) => setEpgUrl(e.target.value)}
                  placeholder="http://example.com/epg.xml"
                />
              </label>
            </>
          )}

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
                      {p.kind === 'm3u' ? p.m3uUrl : `${p.username}@${p.server}`}
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
