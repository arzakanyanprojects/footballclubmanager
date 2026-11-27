import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard,
  Users,
  Shapes,
  CalendarCheck,
  CalendarClock,
  FileSignature,
  Settings as SettingsIcon,
  Shield,
  UserRound,
  WifiOff,
  LogOut,
} from 'lucide-react';
import { I18nProvider, useT } from './i18n';
import { DataVersion, useRpc } from './lib';
import { ToastProvider, ConfirmProvider, ClubCtx, Button, BrandLogo, useClub, useConfirm } from './components/ui';
import Setup from './pages/Setup';
import Dashboard from './pages/Dashboard';
import Students from './pages/Students';
import StudentProfile from './pages/StudentProfile';
import Groups from './pages/Groups';
import Payments from './pages/Payments';
import Attendance from './pages/Attendance';
import Contracts from './pages/Contracts';
import Settings from './pages/Settings';
import Schedule from './pages/Schedule';
import { HdmProvider } from './components/Hdm';
import { ThermalProvider } from './components/Thermal';
import { LocksProvider } from './components/Locks';
import { MessengerProvider } from './components/Messenger';
import { StudentFormHost } from './components/StudentFormHost';
import { UpdateBanner } from './components/Updates';
import { AutomationToasts } from './components/Automations';
import { AuthGate, useAuth } from './components/Auth';

// perm: the tick needed to see the menu (see Settings → Users). Settings is always shown (This computer tab).
// Students opens for anyone who sees students, payments, attendance or contracts (their lists start there).
const NAV = [
  { id: 'students', icon: Users, perms: ['students.view', 'payments.view'] },
  { id: 'dashboard', icon: LayoutDashboard, perms: ['reports.dashboard'] },
  { id: 'groups', icon: Shapes, perms: ['groups.view'] },
  { id: 'attendance', icon: CalendarCheck, perms: ['attendance.view'] },
  { id: 'schedule', icon: CalendarClock, perms: ['schedule.view'] },
  { id: 'contracts', icon: FileSignature, perms: ['contracts.view'] },
  { id: 'settings', icon: SettingsIcon },
];

export default function App() {
  const [appState, setState] = useState(null);
  // Only a real state is kept: a refused change (e.g. { ok: false, error: 'FORBIDDEN' }) leaves the screen as it was.
  const setAppState = (s) => {
    if (s && s.config) return setState(s);
    if (s && s.error) window.dispatchEvent(new CustomEvent('fc-refused', { detail: s.error }));
  };

  useEffect(() => {
    window.fc.state().then(setAppState);
  }, []);

  const theme = appState?.config.theme;
  useEffect(() => {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);

  if (!appState) return null;
  return (
    <I18nProvider lang={appState.config.language}>
      <ToastProvider>
        <ConfirmProvider>
          <CloseGuard isHost={appState.config.mode === 'host'} />
          <AutomationToasts />
          {/* A new version: downloads, then restarts by itself 3 minutes later (see electron/updater.js). */}
          <UpdateBanner />
          {appState.config.mode ? (
            <Shell appState={appState} setAppState={setAppState} />
          ) : (
            <Setup appState={appState} onDone={setAppState} />
          )}
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

// Asks in the app's own confirm window when the main window's × is clicked.
function CloseGuard({ isHost }) {
  const t = useT();
  const confirm = useConfirm();
  const asking = useRef(false);
  useEffect(
    () =>
      window.fc.onCloseRequested(async () => {
        if (asking.current) return;
        asking.current = true;
        const ok = await confirm({
          title: t('app.closeTitle'),
          text: isHost ? t('app.closeHostText') : t('app.closeText'),
          confirmLabel: t('app.close'),
        });
        asking.current = false;
        if (ok) window.fc.confirmClose();
      }),
    [confirm, isHost, t]
  );
  return null;
}

function Shell({ appState, setAppState }) {
  const [version, setVersion] = useState(0);
  const [online, setOnline] = useState(appState.online !== false);
  const [route, setRoute] = useState({ page: 'students' });

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener('fc-local-change', bump);
    const offData = window.fc.onDataChanged(bump);
    const offConn = window.fc.onConnection((v) => {
      setOnline(v !== false);
      if (v) bump();
    });
    return () => {
      window.removeEventListener('fc-local-change', bump);
      offData();
      offConn();
    };
  }, []);

  const nav = (page, params = {}) => setRoute({ page, ...params });

  return (
    <DataVersion.Provider value={version}>
      <ClubProvider>
        <AuthGate>
          <SignedIn appState={appState} setAppState={setAppState} route={route} nav={nav} online={online} />
        </AuthGate>
      </ClubProvider>
    </DataVersion.Provider>
  );
}

function SignedIn({ appState, setAppState, route, nav, online }) {
  const auth = useAuth();
  const allowed = NAV.filter((n) => !n.perms || auth.canAny(...n.perms));
  // A page this user can't open (e.g. after signing in as someone else) falls back to the first allowed one.
  const shown = allowed.some((n) => n.id === route.page) ? route : { page: allowed[0].id };
  const operator = auth.user ? auth.user.full_name || auth.user.username : appState.config.operator;
  return (
    <HdmProvider settings={appState.config.hdm} operator={operator}>
      <ThermalProvider settings={appState.config.thermal} operator={operator}>
        <LocksProvider>
          <MessengerProvider>
            <StudentFormHost>
              <Layout route={shown} nav={nav} navItems={allowed} appState={appState} online={online}>
                <Page route={shown} nav={nav} appState={appState} setAppState={setAppState} />
              </Layout>
            </StudentFormHost>
          </MessengerProvider>
        </LocksProvider>
      </ThermalProvider>
    </HdmProvider>
  );
}

function ClubProvider({ children }) {
  const { data } = useRpc('settings.get');
  return <ClubCtx.Provider value={data || { currency: 'AMD', club_name: '' }}>{children}</ClubCtx.Provider>;
}

function Page({ route, nav, appState, setAppState }) {
  const props = { nav, route, appState, setAppState };
  switch (route.page) {
    case 'students':
      return route.id ? <StudentProfile key={route.id} id={route.id} {...props} /> : <Students {...props} />;
    case 'groups':
      return <Groups {...props} />;
    case 'payments':
      return <Payments {...props} />;
    case 'attendance':
      return <Attendance {...props} />;
    case 'schedule':
      return <Schedule {...props} />;
    case 'contracts':
      return <Contracts {...props} />;
    case 'settings':
      return <Settings {...props} />;
    default:
      return <Dashboard {...props} />;
  }
}

function Layout({ route, nav, navItems, appState, online, children }) {
  const t = useT();
  const auth = useAuth();
  const club = useClub();
  const isHost = appState.config.mode === 'host';
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <BrandLogo size={36} />
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">{club?.club_name || 'FC Manager'}</div>
            <div className="brand-sub">FC Manager</div>
          </div>
        </div>
        <nav className="nav">
          {navItems.map((n) => (
            <button key={n.id} className={`nav-item ${route.page === n.id ? 'active' : ''}`} onClick={() => nav(n.id)}>
              <n.icon size={18} />
              {t(`nav.${n.id}`)}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="conn">
            <span className={`conn-dot ${online ? '' : 'off'}`} />
            {isHost ? t('conn.host') : online ? t('conn.connected') : t('conn.offline')}
          </div>
          {auth.user ? (
            <div className="operator">
              <UserRound size={14} />
              <span className="grow">{auth.user.full_name || auth.user.username}</span>
              <button className="signout" title={t('auth.signOut')} onClick={auth.logout}>
                <LogOut size={14} />
              </button>
            </div>
          ) : (
            appState.config.operator && (
              <div className="operator">
                <UserRound size={14} />
                {appState.config.operator}
              </div>
            )
          )}
        </div>
      </aside>
      <main className="main">
        {!online && (
          <div className="offline-banner">
            <WifiOff size={16} />
            {t('conn.offlineBanner', { host: appState.config.hostAddress })}
            <Button size="sm" variant="ghost" onClick={() => nav('settings', { tab: 'network' })}>
              {t('nav.settings')}
            </Button>
          </div>
        )}
        <div className="page">{children}</div>
      </main>
    </div>
  );
}
