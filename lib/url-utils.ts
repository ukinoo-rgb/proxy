/**
 * Strict URL normalization for GSC/GA4 matching and evidence joins.
 * V2: single canonical form (https, lowercase host/path, trailing slash policy).
 */

const DEFAULT_BLOG_BASE = "https://www.proxlearn.com/blog";

export interface NormalizeOptions {
  /** Prefer www (true) or non-www (false). Default true. */
  preferWww?: boolean;
  /** Strip trailing slash (true) or keep (false). Default true. */
  stripTrailingSlash?: boolean;
  /** Strip query and fragment for key matching. Default true. */
  stripQueryFragment?: boolean;
  /** Base URL for blog; used when resolving slug to full URL. */
  blogBase?: string;
}

const DEFAULT_OPTIONS: Required<NormalizeOptions> = {
  preferWww: true,
  stripTrailingSlash: true,
  stripQueryFragment: true,
  blogBase: DEFAULT_BLOG_BASE,
};

/**
 * Normalize URL for evidence keys and GSC page matching.
 * - Scheme: https only
 * - Host: lowercase; www vs non-www per preferWww
 * - Path: lowercase; trailing slash per stripTrailingSlash
 * - Query/fragment: strip if stripQueryFragment
 */
export function normalizeUrl(
  urlOrPath: string,
  options: NormalizeOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let s = (urlOrPath || "").trim();
  if (!s) return "";

  try {
    // If it looks like a path only (starts with /), prepend origin
    if (s.startsWith("/")) {
      const base = opts.blogBase.replace(/\/?$/, "");
      s = base + (s === "/" ? "" : s);
    }
    const u = new URL(s, "https://www.proxlearn.com/");
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    if (opts.preferWww && !u.hostname.startsWith("www.") && !u.hostname.includes(".")) {
      // don't add www to localhost etc
    } else if (opts.preferWww && u.hostname.split(".").length >= 2 && !u.hostname.startsWith("www.")) {
      u.hostname = "www." + u.hostname;
    } else if (!opts.preferWww && u.hostname.startsWith("www.")) {
      u.hostname = u.hostname.slice(4);
    }
    u.pathname = u.pathname.toLowerCase() || "/";
    if (opts.stripTrailingSlash && u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    }
    if (opts.stripQueryFragment) {
      u.search = "";
      u.hash = "";
    }
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * Slug to full blog URL (normalized).
 */
export function slugToBlogUrl(slug: string, options: NormalizeOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const base = opts.blogBase.replace(/\/?$/, "");
  const path = "/" + (slug || "").replace(/^\/+/, "");
  return normalizeUrl(base + path, opts);
}

/**
 * Extract slug from a blog URL or path (e.g. /blog/foo-bar -> foo-bar).
 */
export function urlToSlug(urlOrPath: string): string {
  const normalized = normalizeUrl(urlOrPath, { stripQueryFragment: true });
  const match = normalized.match(/\/blog\/([^/]+)/i) || (urlOrPath.startsWith("/") && urlOrPath.match(/\/blog\/([^/]+)/i));
  return match ? match[1] : "";
}

/**
 * Check if message contains a URL or slug we can filter GSC by.
 * Returns normalized URL if found, else null.
 */
export function extractPageFilterFromMessage(
  message: string,
  catalogSlugs: string[],
  options: NormalizeOptions = {}
): string | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const text = message.trim();

  // Explicit URL
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/i);
  if (urlMatch) {
    const u = normalizeUrl(urlMatch[1], opts);
    if (u) return u;
  }

  // Path-like /blog/slug or /slug
  const pathMatch = text.match(/(\/blog\/[^\s/]+|\/[a-z0-9-]+)/i);
  if (pathMatch) {
    const path = pathMatch[1];
    const u = normalizeUrl(path, opts);
    if (u) return u;
  }

  // Known slug from catalog (e.g. "how-to-celebrate-teacher-appreciation-week")
  for (const slug of catalogSlugs) {
    const re = new RegExp("\\b" + slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (re.test(text)) return slugToBlogUrl(slug, opts);
  }

  return null;
}
