import { TelemetryService } from './types';

const isOnServer = typeof document === 'undefined';

export const DEFAULT_POSTHOG_KEY =
  'phc_1wb3ErK7DJgNWrGiZmH8mMUaPfEwSCuYJwOOT8JogJF';
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

export class ClientTelemetryService implements TelemetryService {
  async initialize(): Promise<void> {
    if (isOnServer) {
      return Promise.resolve();
    }
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'client.telemetry.service.ts:14',
        message: 'About to import posthog-js',
        data: { isOnServer: false },
        timestamp: Date.now(),
        runId: 'run1',
        hypothesisId: 'A',
      }),
    }).catch(() => {});
    // #endregion agent log
    const { posthog } = await import('posthog-js');
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'client.telemetry.service.ts:15',
        message: 'posthog-js imported successfully',
        data: { hasPosthog: !!posthog },
        timestamp: Date.now(),
        runId: 'run1',
        hypothesisId: 'A',
      }),
    }).catch(() => {});
    // #endregion agent log
    posthog.init(import.meta.env.VITE_POSTHOG_KEY || DEFAULT_POSTHOG_KEY, {
      api_host: import.meta.env.VITE_POSTHOG_INGESTION_URL || '/qwery',
      ui_host:
        import.meta.env.VITE_POSTHOG_HOST ||
        import.meta.env.VITE_POSTHOG_URL ||
        DEFAULT_POSTHOG_HOST,
      persistence: 'localStorage+cookie',
      person_profiles: 'always',
      capture_pageview: true,
      capture_pageleave: true,
    });
    return Promise.resolve();
  }
  async ready(): Promise<void> {
    return Promise.resolve();
  }
  async trackPageView(_path: string): Promise<void> {
    return Promise.resolve();
  }
  async trackEvent(
    event: string,
    properties?: Record<string, string>,
  ): Promise<void> {
    if (isOnServer) {
      return Promise.resolve();
    }
    const { posthog } = await import('posthog-js');
    posthog.capture(event, properties);
    return Promise.resolve();
  }
  async identify(
    _userId: string,
    _traits?: Record<string, string>,
  ): Promise<void> {
    return Promise.resolve();
  }
  async trackError(_error: Error): Promise<void> {
    return Promise.resolve();
  }
  async trackUsage(_usage: string): Promise<void> {
    return Promise.resolve();
  }
  async trackPerformance(_performance: string): Promise<void> {
    return Promise.resolve();
  }
  async trackFeatureUsage(_feature: string): Promise<void> {
    return Promise.resolve();
  }
  async trackAgent(_agent: string): Promise<void> {
    return Promise.resolve();
  }
  async addProvider(_provider: string, _config: object): Promise<void> {
    return Promise.resolve();
  }
  async removeProvider(_provider: string): Promise<void> {
    return Promise.resolve();
  }
}
