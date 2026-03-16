import { StrictMode, useState, useCallback, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppProvider } from './AppContext.tsx'
import LandingPage, { type GoogleUser } from './LandingPage.tsx'
import SetupScreen from './SetupScreen.tsx'

type Stage = 'landing' | 'setup' | 'app';

function Root() {
  const [stage, setStage] = useState<Stage>(() => {
    const hasUser    = !!localStorage.getItem('google_user');
    const hasUpstox  = !!localStorage.getItem('upstox_token');
    const hasNubra   = !!(localStorage.getItem('nubra_raw_cookie') || localStorage.getItem('nubra_session_token'));
    // If already fully set up before, go straight to app
    if (hasUser && hasUpstox && hasNubra) return 'app';
    if (hasUser) return 'setup';
    return 'landing';
  });

  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(() => {
    try { const s = localStorage.getItem('google_user'); return s ? JSON.parse(s) : null; } catch { return null; }
  });

  // Handle Google OAuth callback — ?google_user=... in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('google_user');
    if (raw) {
      try {
        const user: GoogleUser = JSON.parse(decodeURIComponent(raw));
        setGoogleUser(user);
        localStorage.setItem('google_user', JSON.stringify(user));
        window.history.replaceState({}, '', window.location.pathname);
        setStage('setup');
      } catch { /* ignore */ }
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
