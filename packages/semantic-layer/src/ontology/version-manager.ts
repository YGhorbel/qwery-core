import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import { valid, parse, inc, compare } from 'semver';
import type { Ontology } from '../models/ontology.schema';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface OntologyVersion {
  version: string;
  datasourceId: string;
  createdAt: Date;
  conceptsCount: number;
  relationshipsCount: number;
  changes?: {
    conceptsAdded?: number;
    conceptsRemoved?: number;
    relationshipsAdded?: number;
    relationshipsRemoved?: number;
  };
}

export interface VersionHistory {
  versions: OntologyVersion[];
  currentVersion: string | null;
}

/**
 * Manages ontology versions and evolution history.
 */
export class OntologyVersionManager {
  private versionHistory = new Map<string, VersionHistory>(); // datasourceId -> history

  /**
   * Calculate next semantic version based on changes.
   */
  calculateNextVersion(
    currentVersion: string,
    changes: {
      conceptsAdded?: number;
      conceptsRemoved?: number;
      relationshipsAdded?: number;
      relationshipsRemoved?: number;
    },
  ): string {
    const parsed = valid(currentVersion);
    if (!parsed) {
      // If not valid semver, try to parse manually
      const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1]!, 10);
        const minor = parseInt(match[2]!, 10);
        const patch = parseInt(match[3]!, 10);
        return calculateVersionFromParts(major, minor, patch, changes);
      }
      // Default to 1.0.0 if can't parse
      return '1.0.0';
    }

    const parts = parse(parsed);
    if (!parts) {
      return '1.0.0';
    }

    return calculateVersionFromParts(parts.major, parts.minor, parts.patch, changes);
  }

  /**
   * Record a new ontology version.
   */
  async recordVersion(
    datasourceId: string,
    version: string,
    ontology: Ontology,
    changes?: OntologyVersion['changes'],
  ): Promise<void> {
    const logger = await getLogger();

    if (!this.versionHistory.has(datasourceId)) {
      this.versionHistory.set(datasourceId, {
        versions: [],
        currentVersion: null,
      });
    }

    const history = this.versionHistory.get(datasourceId)!;
    const conceptsCount = ontology.ontology.concepts.length;
    const relationshipsCount = ontology.ontology.concepts.reduce(
      (sum, c) => sum + (c.relationships?.length || 0),
      0,
    );

    const ontologyVersion: OntologyVersion = {
      version,
      datasourceId,
      createdAt: new Date(),
      conceptsCount,
      relationshipsCount,
      changes,
    };

    history.versions.push(ontologyVersion);
    history.currentVersion = version;

    // Sort versions by semver
    history.versions.sort((a, b) => {
      const aValid = valid(a.version);
      const bValid = valid(b.version);
      if (aValid && bValid) {
        return compare(bValid, aValid); // Descending order (newest first)
      }
      return b.version.localeCompare(a.version);
    });

    logger.info('[VersionManager] Recorded ontology version', {
      datasourceId,
      version,
      conceptsCount,
      relationshipsCount,
      totalVersions: history.versions.length,
    });
  }

  /**
   * Get version history for a datasource.
   */
  getVersionHistory(datasourceId: string): VersionHistory | null {
    return this.versionHistory.get(datasourceId) || null;
  }

  /**
   * Get current version for a datasource.
   */
  getCurrentVersion(datasourceId: string): string | null {
    const history = this.versionHistory.get(datasourceId);
    return history?.currentVersion || null;
  }

  /**
   * Compare two ontology versions and return diff.
   */
  async compareVersions(
    datasourceId: string,
    version1: string,
    version2: string,
  ): Promise<{
    conceptsAdded: number;
    conceptsRemoved: number;
    relationshipsAdded: number;
    relationshipsRemoved: number;
  }> {
    const history = this.versionHistory.get(datasourceId);
    if (!history) {
      return {
        conceptsAdded: 0,
        conceptsRemoved: 0,
        relationshipsAdded: 0,
        relationshipsRemoved: 0,
      };
    }

    const v1 = history.versions.find((v) => v.version === version1);
    const v2 = history.versions.find((v) => v.version === version2);

    if (!v1 || !v2) {
      return {
        conceptsAdded: 0,
        conceptsRemoved: 0,
        relationshipsAdded: 0,
        relationshipsRemoved: 0,
      };
    }

    return {
      conceptsAdded: Math.max(0, v2.conceptsCount - v1.conceptsCount),
      conceptsRemoved: Math.max(0, v1.conceptsCount - v2.conceptsCount),
      relationshipsAdded: Math.max(0, v2.relationshipsCount - v1.relationshipsCount),
      relationshipsRemoved: Math.max(0, v1.relationshipsCount - v2.relationshipsCount),
    };
  }

  /**
   * List all versions for a datasource.
   */
  listVersions(datasourceId: string): OntologyVersion[] {
    const history = this.versionHistory.get(datasourceId);
    return history?.versions || [];
  }
}

function calculateVersionFromParts(
  major: number,
  minor: number,
  patch: number,
  changes: {
    conceptsAdded?: number;
    conceptsRemoved?: number;
    relationshipsAdded?: number;
    relationshipsRemoved?: number;
  },
): string {
  const conceptsChanged = (changes.conceptsAdded || 0) + (changes.conceptsRemoved || 0);
  const relationshipsChanged = (changes.relationshipsAdded || 0) + (changes.relationshipsRemoved || 0);

  // Major version: breaking changes (concept removal)
  if (changes.conceptsRemoved && changes.conceptsRemoved > 0) {
    return `${major + 1}.0.0`;
  }

  // Minor version: new concepts added
  if (conceptsChanged > 0) {
    return `${major}.${minor + 1}.0`;
  }

  // Patch version: relationships only
  if (relationshipsChanged > 0) {
    return `${major}.${minor}.${patch + 1}`;
  }

  // No changes
  return `${major}.${minor}.${patch}`;
}

let instance: OntologyVersionManager | null = null;

export function getVersionManager(): OntologyVersionManager {
  if (!instance) {
    instance = new OntologyVersionManager();
  }
  return instance;
}
