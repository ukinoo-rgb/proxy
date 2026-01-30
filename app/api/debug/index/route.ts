import { NextResponse } from "next/server";
import { getMeta } from "@/lib/blog-store";

export const runtime = "nodejs";

/** GET /api/debug/index - returns index metadata for debugging and UI badge */
export async function GET() {
  try {
    const meta = getMeta();
    const samplePosts = (meta.postsIndex ?? []).slice(0, 10).map((p) => ({
      title: p.title,
      slug: p.slug,
      datePublished: p.datePublished,
      tags: p.tags,
    }));
    return NextResponse.json({
      totalPosts: meta.totalPosts,
      totalChunks: meta.totalChunks,
      lastIngestedAt: meta.lastIngestedAt || null,
      samplePosts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, totalPosts: 0, totalChunks: 0, samplePosts: [] },
      { status: 500 }
    );
  }
}
