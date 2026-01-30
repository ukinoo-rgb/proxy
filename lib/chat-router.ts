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
