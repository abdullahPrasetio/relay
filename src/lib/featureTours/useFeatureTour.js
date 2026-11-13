import { useCallback, useEffect, useRef, useState } from 'react';
import { FEATURE_TOURS } from './catalog.js';
import {
  compareVersions,
  loadTourState,
  markAllSeen,
  markSeen,
  resetTourState,
  writeTourState,
} from './state.js';
import {
  announcedForCurrent,
  baselineForExisting,
  coreFeatures,
  manualFeatures,
  newFeatures,
  pendingAnnouncements,
  surfaceFeatures,
} from './queue.js';

/**
 * Owns the tour queue and the persistent seen-state. App passes the current
 * surface so tips are contextual instead of a single 40-step modal.
 */
export function useFeatureTour({
  enabled = true,
  ready = false,
  appVersion = '',
  hasUserData = false,
  surface = '',
  context = {},
}) {
  const initialRef = useRef(null);
  if (!initialRef.current) initialRef.current = loadTourState();
  const [state, setState] = useState(initialRef.current.state);
  const [storageError, setStorageError] = useState(initialRef.current.error);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [whatsNew, setWhatsNew] = useState(null);
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const queueKind = useRef('surface');
  const initialized = useRef(false);
  const surfaceRef = useRef('');
  const contextRef = useRef(context);
  contextRef.current = context;

  const persist = useCallback((next) => {
    setState(next);
    if (!writeTourState(next)) setStorageError(true);
    return next;
  }, []);

  // First boot: fresh installs get the welcome card; existing installs get a
  // baseline so they are not forced through a first-run tour after upgrading.
  useEffect(() => {
    if (!ready || !enabled || !appVersion || initialized.current) return;
    initialized.current = true;

    if (!state.enabled) {
      setSurfaceReady(false);
      return;
    }

    const loaded = initialRef.current;
    if (!loaded.exists) {
      if (!hasUserData) {
        setWelcomeOpen(true);
        return;
      }
      const baseline = baselineForExisting(FEATURE_TOURS, appVersion);
      const announced = announcedForCurrent(FEATURE_TOURS, appVersion);
      if (announced.length) {
        // Keep lastAppVersion old until the user acknowledges the announcements,
        // so closing the app mid-tour does not silently lose them.
        persist({ ...baseline, lastAppVersion: '0.0.0' });
        setWhatsNew(announced);
        setSurfaceReady(false);
      } else {
        persist(baseline);
        setSurfaceReady(true);
      }
      return;
    }

    const pending = pendingAnnouncements(
      FEATURE_TOURS,
      state,
      appVersion,
      contextRef.current
    );
    const fresh =
      compareVersions(appVersion, state.lastAppVersion) > 0
        ? newFeatures(FEATURE_TOURS, state, appVersion, contextRef.current)
        : [];
    const announced = [...pending, ...fresh].filter(
      (feature, index, list) => list.findIndex((entry) => entry.id === feature.id) === index
    );
    if (announced.length > 0) {
      setWhatsNew(announced);
      setSurfaceReady(false);
      return;
    }
    if (compareVersions(appVersion, state.lastAppVersion) > 0) {
      persist({ ...state, lastAppVersion: appVersion });
    }
    setSurfaceReady(true);
  }, [ready, enabled, appVersion, hasUserData, persist, state]);

  // Availability can change without a surface change (for example, signing in
  // to Relay Cloud reveals the comments tip). Let the surface effect re-evaluate.
  useEffect(() => {
    surfaceRef.current = '';
  }, [context.cloudSignedIn, context.hasRequest]);

  // A surface becomes eligible only after the welcome/update prompt is resolved
  // and no other queue is active, so two tours never fight for the screen.
  useEffect(() => {
    if (!ready || !enabled || !state.enabled || !surfaceReady || !surface) return;
    if (welcomeOpen || whatsNew || guideOpen) return;
    if (surfaceRef.current === surface) return;

    const steps = surfaceFeatures(FEATURE_TOURS, state, surface, contextRef.current);
    const switchingSurface = queueKind.current === 'surface' && queue.length > 0;
    if (queue.length > 0 && !switchingSurface) return;

    surfaceRef.current = surface;
    if (steps.length > 0) {
      queueKind.current = 'surface';
      setQueue(steps);
      setIndex(0);
    } else if (switchingSurface) {
      setQueue([]);
      setIndex(0);
    }
  }, [
    ready,
    enabled,
    state,
    surfaceReady,
    surface,
    welcomeOpen,
    whatsNew,
    guideOpen,
    queue.length,
  ]);

  const finishQueue = useCallback(() => {
    const kind = queueKind.current;
    setQueue([]);
    setIndex(0);
    if (kind === 'new' || kind === 'core') {
      setState((prev) => {
        if (compareVersions(prev.lastAppVersion, appVersion) >= 0) return prev;
        const next = { ...prev, lastAppVersion: appVersion };
        if (!writeTourState(next)) setStorageError(true);
        return next;
      });
    }
  }, [appVersion]);

  const advance = useCallback(
    (action) => {
      const step = queue[index];
      if (!step) return;
      persist(markSeen(state, [step.id], action, appVersion));
      if (index + 1 < queue.length) setIndex(index + 1);
      else finishQueue();
    },
    [queue, index, state, appVersion, persist, finishQueue]
  );

  const next = useCallback(() => advance('completed'), [advance]);
  const skipStep = useCallback(() => advance('skipped'), [advance]);
  const back = useCallback(() => setIndex((value) => Math.max(0, value - 1)), []);

  const skipTour = useCallback(() => {
    // Skipping the first-run tour means "do not walk me through the product".
    // Contextual tours only skip their own remaining steps, so a later area
    // can still introduce itself once.
    if (queueKind.current === 'core') {
      const current = FEATURE_TOURS.filter(
        (feature) => compareVersions(feature.introducedIn, appVersion) <= 0
      );
      persist(markAllSeen(state, current, 'skipped', appVersion));
    } else {
      const remaining = queue.slice(index);
      if (remaining.length > 0) {
        persist(markAllSeen(state, remaining, 'skipped', appVersion));
      }
    }
    finishQueue();
  }, [queue, index, state, appVersion, persist, finishQueue]);

  const startWelcome = useCallback(() => {
    setWelcomeOpen(false);
    setSurfaceReady(true);
    const nextState = { ...state, lastAppVersion: appVersion };
    persist(nextState);
    const core = coreFeatures(FEATURE_TOURS, nextState, contextRef.current);
    if (core.length > 0) {
      queueKind.current = 'core';
      setQueue(core);
      setIndex(0);
    }
  }, [state, appVersion, persist]);

  const skipWelcome = useCallback(() => {
    setWelcomeOpen(false);
    setSurfaceReady(true);
    const current = FEATURE_TOURS.filter(
      (feature) => compareVersions(feature.introducedIn, appVersion) <= 0
    );
    const nextState = markAllSeen(state, current, 'skipped', appVersion);
    nextState.lastAppVersion = appVersion;
    persist(nextState);
  }, [state, appVersion, persist]);

  const dismissWhatsNew = useCallback(() => {
    const list = whatsNew || [];
    const nextState = markAllSeen(state, list, 'skipped', appVersion);
    nextState.lastAppVersion = appVersion;
    persist(nextState);
    setWhatsNew(null);
    setSurfaceReady(true);
  }, [whatsNew, state, appVersion, persist]);

  const showWhatsNewFeature = useCallback(
    (feature) => {
      const list = whatsNew || [];
      const ordered = feature
        ? [feature, ...list.filter((entry) => entry.id !== feature.id)]
        : list;
      setWhatsNew(null);
      setSurfaceReady(true);
      if (ordered.length > 0) {
        queueKind.current = 'new';
        setQueue(ordered);
        setIndex(0);
      }
    },
    [whatsNew]
  );

  const openGuide = useCallback(() => setGuideOpen(true), []);
  const closeGuide = useCallback(() => setGuideOpen(false), []);

  const startManualTour = useCallback(
    (surfaceName) => {
      const steps = manualFeatures(FEATURE_TOURS, surfaceName, contextRef.current);
      if (steps.length === 0) {
        setGuideOpen(true);
        return false;
      }
      setWelcomeOpen(false);
      setWhatsNew(null);
      setGuideOpen(false);
      setSurfaceReady(true);
      queueKind.current = 'manual';
      setQueue(steps);
      setIndex(0);
      return true;
    },
    []
  );

  const showFeature = useCallback((feature) => {
    if (!feature) return;
    setGuideOpen(false);
    setSurfaceReady(true);
    queueKind.current = 'guide';
    setQueue([feature]);
    setIndex(0);
  }, []);

  const setEnabled = useCallback(
    (value) => {
      const nextState = { ...state, enabled: value !== false };
      persist(nextState);
      if (value === false) {
        setQueue([]);
        setIndex(0);
        setWelcomeOpen(false);
        setWhatsNew(null);
      } else {
        surfaceRef.current = '';
        setSurfaceReady(true);
      }
    },
    [state, persist]
  );

  const reset = useCallback(() => {
    const nextState = resetTourState();
    nextState.enabled = true;
    // A reset replays contextual tips, not the version-update announcement.
    nextState.lastAppVersion = appVersion;
    persist(nextState);
    setQueue([]);
    setIndex(0);
    setWelcomeOpen(false);
    setWhatsNew(null);
    setSurfaceReady(true);
    surfaceRef.current = '';
  }, [persist, appVersion]);

  return {
    features: FEATURE_TOURS,
    seen: state.seen,
    enabled: state.enabled,
    storageError,
    welcomeOpen,
    whatsNew,
    current: queue[index] || null,
    index,
    total: queue.length,
    guideOpen,
    startWelcome,
    skipWelcome,
    dismissWhatsNew,
    showWhatsNewFeature,
    next,
    back,
    skipStep,
    skipTour,
    openGuide,
    closeGuide,
    startManualTour,
    showFeature,
    setEnabled,
    reset,
  };
}
