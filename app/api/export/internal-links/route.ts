import { NextRequest, NextResponse } from "next/server";
import { getCaseFileByToken } from "@/lib/export-store";
import { buildInternalLinksList, toCsv } from "@/lib/exports";

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
  const rows = buildInternalLinksList(caseFile);
  const csv = toCsv(rows, ["source_url", "target_url", "suggested_anchor", "reason"]);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="internal_links.csv"',
    },
  });
}
