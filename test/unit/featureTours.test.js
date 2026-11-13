import { describe, expect, it } from 'vitest';
import { FEATURE_TOURS } from '../../src/lib/featureTours/catalog.js';
import {
  announcedForCurrent,
  baselineForExisting,
  coreFeatures,
  featureAvailable,
  manualFeatures,
  newFeatures,
  pendingAnnouncements,
  surfaceFeatures,
} from '../../src/lib/featureTours/queue.js';
import {
  TOUR_STORAGE_KEY,
  compareVersions,
  emptyTourState,
  loadTourState,
  markSeen,
  normalizeTourState,
  writeTourState,
} from '../../src/lib/featureTours/state.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

const sample = (overrides = {}) => ({
  id: 'sample.feature',
  surface: 'request',
  group: 'Sample',
  title: 'Sample',
  body: 'Sample body',
  anchor: '[data-tour="sample"]',
  introducedIn: '0.26.0',
  ...overrides,
});

describe('feature tour catalog', () => {
  it('has unique ids and complete copy for every entry', () => {
    const ids = new Set();
    for (const feature of FEATURE_TOURS) {
      expect(feature.id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
      expect(ids.has(feature.id)).toBe(false);
      ids.add(feature.id);
      expect(feature.group).toBeTruthy();
      expect(feature.title).toBeTruthy();
      expect(feature.body).toBeTruthy();
      expect(feature.anchor).toMatch(/^\[data-tour="[^"]+"\]$/);
      expect(feature.introducedIn).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('keeps the first-run tour separate from contextual surface tips', () => {
    const essentials = FEATURE_TOURS.filter((feature) => feature.tour === 'essentials');
    expect(essentials.length).toBeGreaterThan(0);
    expect(essentials.every((feature) => feature.surface === 'global')).toBe(true);
    expect(
      FEATURE_TOURS.filter((feature) => feature.tour !== 'essentials' && feature.auto !== false)
        .every((feature) => feature.surface !== 'global')
    ).toBe(true);
  });
});

describe('feature tour state', () => {
  it('compares stable and prerelease versions numerically', () => {
    expect(compareVersions('0.26.0', '0.25.9')).toBe(1);
    expect(compareVersions('0.26.0-beta.1', '0.26.0')).toBe(-1);
    expect(compareVersions('0.26.0', '0.26.0-beta.1')).toBe(1);
    expect(compareVersions('0.27.0', '0.26.99')).toBe(1);
    expect(compareVersions('v0.26.0', '0.26.0')).toBe(0);
  });

  it('normalizes malformed state instead of throwing', () => {
    expect(normalizeTourState(null)).toEqual(emptyTourState());
    expect(normalizeTourState({ seen: 'nope', enabled: false, lastAppVersion: ' 1.2.3 ' })).toEqual({
      schemaVersion: 2,
      lastAppVersion: '1.2.3',
      enabled: false,
      seen: {},
    });
    expect(
      normalizeTourState({
        seen: {
          good: { action: 'skipped', version: '1.0.0', at: 'now' },
          bad: { action: 'other' },
          worse: null,
        },
      }).seen
    ).toEqual({
      good: { action: 'skipped', version: '1.0.0', at: 'now' },
      bad: { action: 'completed', version: '', at: '' },
    });
  });

  it('reopens the beta Feature Guide announcement from schema 1 once', () => {
    const migrated = normalizeTourState({
      schemaVersion: 1,
      lastAppVersion: '0.27.0-beta.2',
      seen: {
        'help.featureGuide': { action: 'completed', version: '0.27.0-beta.2', at: 'now' },
        'request.send': { action: 'completed', version: '0.26.0', at: 'now' },
      },
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.seen['help.featureGuide']).toBeUndefined();
    expect(migrated.seen['request.send']).toBeTruthy();
    expect(
      normalizeTourState({
        schemaVersion: 2,
        seen: { 'help.featureGuide': { action: 'skipped' } },
      }).seen['help.featureGuide']
    ).toBeTruthy();
  });

  it('loads absent and corrupt values as absent', () => {
    expect(loadTourState(memoryStorage()).exists).toBe(false);
    expect(loadTourState(memoryStorage({ [TOUR_STORAGE_KEY]: '{bad' }))).toMatchObject({
      exists: false,
      error: true,
    });
  });

  it('round-trips state and marks individual features', () => {
    const storage = memoryStorage();
    const seen = markSeen(emptyTourState(), ['request.send'], 'completed', '0.26.0');
    expect(writeTourState(seen, storage)).toBe(true);
    const loaded = loadTourState(storage);
    expect(loaded.exists).toBe(true);
    expect(loaded.state.seen['request.send'].action).toBe('completed');
  });
});

describe('feature tour queue', () => {
  it('marks every current feature as seen for an existing install', () => {
    const features = [
      sample({ id: 'old', introducedIn: '0.26.0' }),
      sample({ id: 'new', introducedIn: '0.27.0' }),
    ];
    const baseline = baselineForExisting(features, '0.27.0');
    expect(baseline.seen.old).toBeTruthy();
    expect(baseline.seen.new).toBeTruthy();
  });

  it('keeps announcements from an earlier beta pending on a later beta', () => {
    const features = [
      sample({ id: 'old', introducedIn: '0.26.0' }),
      sample({
        id: 'help',
        introducedIn: '0.27.0-beta.1',
        announce: true,
        auto: false,
      }),
    ];
    const baseline = baselineForExisting(features, '0.27.0-beta.2');
    expect(baseline.seen.old).toBeTruthy();
    expect(baseline.seen.help).toBeUndefined();
    expect(announcedForCurrent(features, '0.27.0-beta.2').map((f) => f.id)).toEqual(['help']);
  });

  it('keeps current-version announcements pending for an existing install', () => {
    const features = [
      sample({ id: 'old', introducedIn: '0.26.0' }),
      sample({ id: 'new', introducedIn: '0.27.0', announce: true }),
    ];
    const baseline = baselineForExisting(features, '0.27.0');
    expect(baseline.seen.old).toBeTruthy();
    expect(baseline.seen.new).toBeUndefined();
    expect(announcedForCurrent(features, '0.27.0').map((feature) => feature.id)).toEqual(['new']);
  });

  it('returns unseen core and surface steps in priority order', () => {
    const features = [
      sample({ id: 'core.b', tour: 'essentials', surface: 'global', priority: 20 }),
      sample({ id: 'core.a', tour: 'essentials', surface: 'global', priority: 10 }),
      sample({ id: 'request.b', priority: 20 }),
      sample({ id: 'request.a', priority: 10 }),
      sample({ id: 'request.seen' }),
      sample({ id: 'guide.only', auto: false }),
    ];
    const state = markSeen(emptyTourState(), ['request.seen'], 'skipped', '0.26.0');
    expect(coreFeatures(features, state).map((feature) => feature.id)).toEqual(['core.a', 'core.b']);
    expect(surfaceFeatures(features, state, 'request').map((feature) => feature.id)).toEqual([
      'request.a',
      'request.b',
    ]);
  });

  it('queues only newer unseen features on update', () => {
    const features = [
      sample({ id: 'old', introducedIn: '0.26.0' }),
      sample({ id: 'new', introducedIn: '0.27.0' }),
      sample({ id: 'manual', introducedIn: '0.27.0', auto: false }),
      sample({ id: 'announced-manual', introducedIn: '0.27.0', auto: false, announce: true }),
    ];
    const state = { ...emptyTourState(), lastAppVersion: '0.26.0' };
    expect(newFeatures(features, state, '0.27.0').map((feature) => feature.id)).toEqual([
      'new',
      'announced-manual',
    ]);
    expect(newFeatures(features, state, '0.26.0')).toEqual([]);
  });

  it('keeps a beta announcement visible even when the app version is unchanged', () => {
    const features = [
      sample({
        id: 'help.featureGuide',
        introducedIn: '0.27.0-beta.1',
        announce: true,
        auto: false,
      }),
    ];
    const state = { ...emptyTourState(), lastAppVersion: '0.27.0-beta.1' };
    expect(pendingAnnouncements(features, state, '0.27.0-beta.1').map((f) => f.id)).toEqual([
      'help.featureGuide',
    ]);
    expect(
      newFeatures(features, { ...state, lastAppVersion: '0.26.0' }, '0.27.0-beta.1').map(
        (f) => f.id
      )
    ).toEqual(['help.featureGuide']);
  });

  it('manual replay includes seen surface steps and falls back to essentials', () => {
    const features = [
      sample({ id: 'core', tour: 'essentials', surface: 'global' }),
      sample({ id: 'request.seen', surface: 'request', priority: 20 }),
      sample({ id: 'request.other', surface: 'request', priority: 10 }),
      sample({ id: 'docs.only', surface: 'docs' }),
    ];
    const state = markSeen(emptyTourState(), ['request.seen'], 'skipped', '0.27.0');
    expect(manualFeatures(features, 'request').map((f) => f.id)).toEqual([
      'request.other',
      'request.seen',
    ]);
    expect(manualFeatures(features, 'missing').map((f) => f.id)).toEqual(['core']);
    expect(state.seen['request.seen'].action).toBe('skipped');
  });

  it('honours availability predicates', () => {
    const feature = sample({ when: 'cloud' });
    expect(featureAvailable(feature, { cloudSignedIn: false })).toBe(false);
    expect(featureAvailable(feature, { cloudSignedIn: true })).toBe(true);
  });
});
