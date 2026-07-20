import { useState } from 'react';
import { api, setAuthToken, AuthError } from '../api';

// One-time unlock per device: the password is checked against the server's
// SECRET_PASSWORD and then kept in localStorage — never asked again here.

export default function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (!value || checking) return;
    setChecking(true);
    setError(false);
    setAuthToken(value);
    try {
      await api.status(); // any gated call proves the password
      onUnlock();
    } catch (err) {
      if (err instanceof AuthError) {
        setError(true);
        setValue('');
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="gate">
      <span className="brand-dot big" />
      <h1>Memory</h1>
      <p>This is a private memory. Enter the password once to use it on this device.</p>
      <input
        type="password"
        autoFocus
        placeholder="Password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <p className="gate-error">That's not it — try again.</p>}
      <button className="gate-btn" disabled={!value || checking} onClick={submit}>
        {checking ? 'Checking…' : 'Unlock'}
      </button>
    </div>
  );
}
