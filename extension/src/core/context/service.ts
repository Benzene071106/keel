import { RepoIndex, type RepoIndexSources } from './repoIndex';

/** Lazily built repo index, rebuilt on the next request after any write. */
export class ContextService {
  private current?: Promise<RepoIndex>;
  constructor(private readonly sources: RepoIndexSources) {}

  get(): Promise<RepoIndex> {
    if (!this.current) {
      this.current = RepoIndex.build(this.sources);
      this.current.catch(() => (this.current = undefined));
    }
    return this.current;
  }

  invalidate(): void {
    this.current = undefined;
  }
}
