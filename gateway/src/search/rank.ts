import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ScoredTool {
  tool: Tool;
  score: number;
}

/** Orders tools by relevance to a query. A seam so a smarter ranker (embeddings) can replace this one. */
export interface Ranker {
  /** Only tools that match at all, best first. */
  rank(query: string, tools: Tool[]): ScoredTool[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "for",
  "and",
  "or",
  "in",
  "on",
  "with",
  "by",
  "is",
  "are",
  "me",
  "my",
  "all",
  "please",
]);

/** Plural -> singular, crudely: enough that "orders" finds "list_order". */
function stem(word: string): string {
  // "status", "address" and "analysis" are already singular.
  return word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)
    ? word.slice(0, -1)
    : word;
}

/** Lowercase words from text, splitting on punctuation, `_`, `-` and camelCase. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .map(stem);
}

/** Field weights: a hit in the name says more than one buried in a description. */
const NAME_WEIGHT = 3;
const ARG_WEIGHT = 1.5;
const DESCRIPTION_WEIGHT = 1;
/** Query words of at least this length also match words they are a prefix of ("ord" -> "orders"). */
const PREFIX_MIN = 3;
const PREFIX_FACTOR = 0.5;

const K1 = 1.2;
const B = 0.75;

interface Doc {
  tool: Tool;
  /** Weighted term frequencies. */
  terms: Map<string, number>;
  /** Weighted length. */
  length: number;
}

function argumentNames(tool: Tool): string[] {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

function indexTool(tool: Tool): Doc {
  const terms = new Map<string, number>();
  let length = 0;
  const add = (text: string, weight: number) => {
    for (const term of tokenize(text)) {
      terms.set(term, (terms.get(term) ?? 0) + weight);
      length += weight;
    }
  };
  add(tool.name, NAME_WEIGHT); // starts with the server's slug, so the server is searchable too
  add(tool.title ?? "", NAME_WEIGHT);
  add(argumentNames(tool).join(" "), ARG_WEIGHT);
  add(tool.description ?? "", DESCRIPTION_WEIGHT);
  return { tool, terms, length };
}

/**
 * BM25 over the tools the caller can see, with name, argument and description
 * weighted differently. The index is built per call: the list changes whenever
 * a server's health, a permission or the cache does, and a few hundred tools
 * take well under a millisecond.
 */
export class Bm25Ranker implements Ranker {
  rank(query: string, tools: Tool[]): ScoredTool[] {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || tools.length === 0) return [];

    const docs = tools.map(indexTool);
    const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;

    // For each query word, the terms that count as a match and how much each is worth.
    const matches = queryTerms.map((q) => {
      const found = new Map<string, number>([[q, 1]]);
      if (q.length >= PREFIX_MIN) {
        for (const d of docs) {
          for (const term of d.terms.keys()) {
            if (term !== q && term.startsWith(q)) found.set(term, PREFIX_FACTOR);
          }
        }
      }
      return found;
    });

    const scored: ScoredTool[] = [];
    const docFrequency = matches.map(
      (found) => docs.filter((d) => [...found.keys()].some((t) => d.terms.has(t))).length,
    );
    for (const doc of docs) {
      let score = 0;
      matches.forEach((found, i) => {
        let tf = 0;
        for (const [term, factor] of found) tf += (doc.terms.get(term) ?? 0) * factor;
        if (tf === 0) return;
        const n = docFrequency[i];
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * doc.length) / avgLength));
      });
      if (score > 0) scored.push({ tool: doc.tool, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  }
}
