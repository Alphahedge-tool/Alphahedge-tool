import { StrictMode, useState, useCallback, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppProvider } from './AppContext.tsx'
import LandingPage, { type GoogleUser } from './LandingPage.tsx'
import SetupScreen from './SetupScreen.tsx'
type Stage = 'landing' | 'setup' | 'app';

function Root() {
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(() => {
    try { const s = localStorage.getItem('google_user'); return s ? JSON.parse(s) : null; } catch { return null; }
  });

  const [stage, setStage] = useState<Stage>(() => {
    try {
      const hasUser   = !!localStorage.getItem('google_user');
      const hasNubra  = !!(localStorage.getItem('nubra_session_token') || localStorage.getItem('nubra_raw_cookie'));
      const hasUpstox = !!localStorage.getItem('upstox_token');
      if (hasUser && hasNubra && hasUpstox) return 'app';   // tokens valid → straight to app
      if (hasUser) return 'setup';                           // user exists but need tokens → setup
    } catch { /* ignore */ }
    return 'landing';
  });

  // Handle Google OAuth callback — ?google_user=... or ?auth_error=... in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('google_user');
    const authError = params.get('auth_error');
    if (raw) {
      try {
        const user: GoogleUser = JSON.parse(decodeURIComponent(raw));
        setGoogleUser(user);
        localStorage.setItem('google_user', JSON.stringify(user));
        window.history.replaceState({}, '', window.location.pathname);
        // Always go through setup so tokens are validated/refreshed
        setStage('setup');
      } catch { /* ignore */ }
    } else if (authError) {
      window.history.replaceState({}, '', window.location.pathname);
      setStage('landing');
    }
  }, []);

  const onEnterApp = useCallback((user?: GoogleUser) => {
    if (user) { setGoogleUser(user); localStorage.setItem('google_user', JSON.stringify(user)); }
    setStage('setup');
  }, []);

  const onSignOut = useCallback(() => {
    localStorage.removeItem('google_user');
    setGoogleUser(null);
    setStage('landing');
  }, []);

  if (stage === 'app') {
    return <AppProvider onSignOut={onSignOut}><App /></AppProvider>;
  }
  if (stage === 'setup') {
    return <SetupScreen googleUser={googleUser} onReady={() => setStage('app')} />;
  }
  return <LandingPage onEnter={onEnterApp} googleUser={googleUser} onSignOut={onSignOut} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
