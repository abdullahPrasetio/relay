import { TOUR_SCHEMA_VERSION, compareVersions } from './state.js';

/** Availability predicates stay declarative so the catalog is serializable. */
export function featureAvailable(feature, context = {}) {
  if (!feature?.when) return true;
  if (feature.when === 'cloud') return context.cloudSignedIn === true;
  if (feature.when === 'request') return context.hasRequest !== false;
  return true;
}

function sortSteps(features) {
  return [...features].sort((a, b) => {
    const pa = Number.isFinite(a.priority) ? a.priority : 100;
    const pb = Number.isFinite(b.priority) ? b.priority : 100;
    return pa - pb;
  });
}

export function coreFeatures(features, state, context = {}) {
  return sortSteps(
    (features || []).filter(
      (feature) =>
        feature.tour === 'essentials' &&
        !state.seen?.[feature.id] &&
        featureAvailable(feature, context)
    )
  );
}

export function surfaceFeatures(features, state, surface, context = {}) {
  if (!surface) return [];
  return sortSteps(
    (features || []).filter(
      (feature) =>
        feature.auto !== false &&
        feature.tour !== 'essentials' &&
        feature.surface === surface &&
        !state.seen?.[feature.id] &&
        featureAvailable(feature, context)
    )
  );
}

/**
 * Existing installs must not get the first-run tour. Mark everything that was
 * already part of this release as seen; only explicit `announce` entries for
 * the current version stay pending.
 */
export function baselineForExisting(features, currentVersion) {
  const seen = {};
  const now = new Date().toISOString();
  for (const feature of features || []) {
    if (!feature?.id) continue;
    const isCurrentAnnouncement =
      feature.announce === true &&
      compareVersions(feature.introducedIn, currentVersion) === 0;
    if (isCurrentAnnouncement) continue;
    if (compareVersions(feature.introducedIn, currentVersion) <= 0) {
      seen[feature.id] = { action: 'completed', version: currentVersion, at: now };
    }
  }
  return {
    schemaVersion: TOUR_SCHEMA_VERSION,
    lastAppVersion: currentVersion,
    enabled: true,
    seen,
  };
}

export function announcedForCurrent(features, currentVersion) {
  return sortSteps(
    (features || []).filter(
      (feature) =>
        feature.announce === true &&
        compareVersions(feature.introducedIn, currentVersion) === 0
    )
  );
}

export function newFeatures(features, state, currentVersion, context = {}) {
  return sortSteps(
    (features || []).filter(
      (feature) =>
        (feature.auto !== false || feature.announce === true) &&
        !state.seen?.[feature.id] &&
        compareVersions(feature.introducedIn, state.lastAppVersion) > 0 &&
        compareVersions(feature.introducedIn, currentVersion) <= 0 &&
        featureAvailable(feature, context)
    )
  );
}
