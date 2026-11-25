import { useCallback, useEffect, useRef, useState } from 'react';
import {
  detectNotificationEvents,
  dispatchNotification,
  getNotificationCapabilities,
  loadNotificationPrefs,
  requestDesktopPermission,
  saveNotificationPrefs,
} from '../engine/notificationService.js';

/**
 * React hook for subscribing a view to tournament notifications (desktop + in-app toast + chime).
 * Automatically persists per-tournament preferences (including claimed player) in localStorage.
 */
export function useTournamentNotifications(state) {
  const tournamentId = state?.tournamentId || 't-default';
  const [prefs, setPrefs] = useState(() => loadNotificationPrefs(tournamentId));
  const [caps, setCaps] = useState(() => getNotificationCapabilities());
  const [activeToast, setActiveToast] = useState(null);
  const prevStateRef = useRef(state);
  const toastTimerRef = useRef(null);

  // Reload per-tournament preferences when switching tournaments
  useEffect(() => {
    setPrefs(loadNotificationPrefs(tournamentId));
    prevStateRef.current = state;
  }, [tournamentId]);

  const showToast = useCallback((event) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setActiveToast(event);
    toastTimerRef.current = setTimeout(() => setActiveToast(null), 6000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setActiveToast(null);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // Watch state transitions and emit notifications
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (!prev || !state || prev === state || prev.tournamentId !== state.tournamentId) return;

    const events = detectNotificationEvents(prev, state, prefs);
    if (events.length === 0) return;

    for (const ev of events) {
      dispatchNotification(ev, prefs);
    }
    showToast(events[events.length - 1]);
  }, [state, prefs, showToast]);

  const updatePrefs = useCallback(
    (partial) => {
      setPrefs((current) => saveNotificationPrefs(tournamentId, { ...current, ...partial }));
    },
    [tournamentId]
  );

  const claimPlayer = useCallback(
    (playerId) => {
      updatePrefs({ claimedPlayerId: playerId || null, enabled: Boolean(playerId) || prefs.enabled });
    },
    [updatePrefs, prefs.enabled]
  );

  const requestPermission = useCallback(async () => {
    const result = await requestDesktopPermission();
    setCaps(getNotificationCapabilities());
    if (result === 'granted') {
      updatePrefs({ enabled: true, desktopEnabled: true });
    }
    return result;
  }, [updatePrefs]);

  const testNotification = useCallback(() => {
    const ev = {
      id: `test:${Date.now()}`,
      type: 'test',
      tag: 'pp-test',
      title: '🏓 Notifications Ready',
      body: 'You will be alerted here when your match is on deck or starting.',
    };
    dispatchNotification(ev, { ...prefs, enabled: true });
    showToast(ev);
  }, [prefs, showToast]);

  return {
    prefs,
    capabilities: caps,
    activeToast,
    dismissToast,
    updatePrefs,
    claimPlayer,
    requestPermission,
    testNotification,
  };
}
