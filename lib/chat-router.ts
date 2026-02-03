/**
 * Dataset-aware routing: detect metadata/statistics questions vs thematic.
 * For metadata questions we answer from index meta only (no LLM, no retrieval).
 */

/** Detect "how many posts", "count of articles", "number of blog posts", etc. */
export function isMetadataQuestion(message: string): boolean {
  const q = message.toLowerCase().trim();
  const hasCountIntent =
    /\b(how many|count of|number of|total (number of)?|how many (do we have|are there)|# of)\b/i.test(q) ||
    /\b(count|total)\s+(posts|articles|blogs?|chunks?|authors?|tags?)\b/i.test(q) ||
    /\b(posts|articles|blogs?|chunks?)\s+(count|total|do we have)\b/i.test(q);
  const hasDatasetSubject =
    /\b(posts?|articles?|blogs?|chunks?|authors?|tags?)\b/i.test(q);
  return !!(hasCountIntent && hasDatasetSubject);
}

/** Use larger topK for summarization/thematic questions to improve coverage. */
const SUMMARIZATION_PATTERNS = [
  /\bsummar(y|ize|ise)\b/i,
  /\bmain themes?\b/i,
  /\boverview\b/i,
  /\bwhat (are|is) (our|the) (blog|content|themes?)\b/i,
  /\bkey (themes?|topics?|points?)\b/i,
  /\bhigh level\b/i,
];

export function isSummarizationQuestion(message: string): boolean {
  const q = message.toLowerCase().trim();
  return SUMMARIZATION_PATTERNS.some((re) => re.test(q));
}

/** topK for retrieval: larger for summarization. */
export const DEFAULT_TOP_K = 5;
export const SUMMARIZATION_TOP_K = 18;

export function getTopKForQuery(message: string): number {
  return isSummarizationQuestion(message) ? SUMMARIZATION_TOP_K : DEFAULT_TOP_K;
}

/** Detect questions about first/last/oldest/newest post so we include those posts' chunks. */
export function isOrderQuestion(message: string): { first?: boolean; last?: boolean } {
  const q = message.toLowerCase().trim();
  const first =
    /\b(first|oldest|earliest)\s*(blog|post|article)\b/i.test(q) ||
    /\b(what|which)\s+(was|is)\s+the\s+first\b/i.test(q) ||
    /\b(blog|post|article)\s+#\s*1\b/i.test(q);
  const last =
    /\b(last|newest|most recent|latest)\s*(blog|post|article)\b/i.test(q) ||
    /\b(what|which)\s+(was|is)\s+(the\s+)?(last|newest|latest)\b/i.test(q);
  return { first: !!first, last: !!last };
}
