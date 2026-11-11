/**
 * Co-change ("logical coupling") mined from git history: files that are committed together.
 * Huge commits (renames, reformatting) are skipped because they couple everything to everything.
 */
export interface CoChange {
  /** commits touching each file */
  commits: Map<string, number>;
  /** pair counts: a -> (b -> shared commits) */
  shared: Map<string, Map<string, number>>;
  totalCommits: number;
}

export const MAX_FILES_PER_COMMIT = 30;

/** Parse `git log --name-only --pretty=format:@@%H` output. */
export function buildCoChange(gitLogOutput: string, keep: (path: string) => boolean = () => true): CoChange {
  const commits = new Map<string, number>();
  const shared = new Map<string, Map<string, number>>();
  let total = 0;
  for (const block of gitLogOutput.split('@@').slice(1)) {
    const files = [...new Set(block.split('\n').slice(1).map(l => l.trim()).filter(Boolean).filter(keep))];
    if (files.length === 0 || files.length > MAX_FILES_PER_COMMIT) continue;
    total++;
    for (const f of files) commits.set(f, (commits.get(f) ?? 0) + 1);
    for (const a of files) {
      let row = shared.get(a);
      if (!row) shared.set(a, (row = new Map()));
      for (const b of files) if (a !== b) row.set(b, (row.get(b) ?? 0) + 1);
    }
  }
  return { commits, shared, totalCommits: total };
}

export interface Coupled {
  path: string;
  shared: number;
  /** commits touching the seed file */
  of: number;
  /** P(other changes | seed changes) */
  confidence: number;
}

/** Files that usually change when `path` changes. */
export function coupledFiles(cc: CoChange, path: string, minShared = 3, minConfidence = 0.2): Coupled[] {
  const row = cc.shared.get(path);
  const of = cc.commits.get(path) ?? 0;
  if (!row || of === 0) return [];
  return [...row.entries()]
    .map(([p, n]) => ({ path: p, shared: n, of, confidence: n / of }))
    .filter(c => c.shared >= minShared && c.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
}
