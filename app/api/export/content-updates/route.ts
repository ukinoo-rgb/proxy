import { NextRequest, NextResponse } from "next/server";
import { getCaseFileByToken } from "@/lib/export-store";
import { buildContentUpdates, contentUpdatesToMarkdown } from "@/lib/exports";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }
  const caseFile = getCaseFileByToken(token);
  if (!caseFile) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 404 });
  }
  const updates = buildContentUpdates(caseFile);
  const md = contentUpdatesToMarkdown(updates);
  return new NextResponse(md, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="content_updates.md"',
    },
  });
}
