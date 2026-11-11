/** Split identifiers and prose into lowercase terms: "get_debug_flag" -> get, debug, flag. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** Tiny suffix stripper so "commands" matches "command" and "masking" matches "mask". */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

const STOP = new Set(
  'the a an and or of to in on for is are be it its as at by with from that this these those any all every must should can will not no into than then also only each other new add make use used using value values'.split(' '),
);

export interface Bm25Doc {
  id: number;
  terms: string[];
}

export class Bm25 {
  private df = new Map<string, number>();
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private avg = 0;

  constructor(private readonly docs: Bm25Doc[], private readonly k1 = 1.2, private readonly b = 0.75) {
    for (const d of docs) {
      const m = new Map<string, number>();
      for (const t of d.terms) m.set(t, (m.get(t) ?? 0) + 1);
      this.tf[d.id] = m;
      this.len[d.id] = d.terms.length;
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avg = docs.reduce((a, d) => a + d.terms.length, 0) / Math.max(1, docs.length);
  }

  idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Returns [docId, score, matchedTerms] sorted by score. */
  search(queryTerms: string[], limit = 50, ids?: Iterable<number>): [number, number, string[]][] {
    const q = [...new Set(queryTerms)];
    const out: [number, number, string[]][] = [];
    for (const id of ids ?? this.docs.map(d => d.id)) {
      const [s, matched] = this.score(id, q);
      if (s > 0) out.push([id, s, matched]);
    }
    return out.sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  private score(id: number, q: string[]): [number, string[]] {
    const tf = this.tf[id];
    let s = 0;
    const matched: string[] = [];
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      matched.push(t);
      s += this.idf(t) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[id]) / this.avg)));
    }
    return [s, matched];
  }
}
