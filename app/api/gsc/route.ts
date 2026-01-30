import { NextRequest, NextResponse } from "next/server";
import { fetchGSCSummary } from "@/lib/gsc";

export const runtime = "nodejs";

function getDateRange(searchParams: URLSearchParams): { start: string; end: string } {
  const end = searchParams.get("end") ?? new Date().toISOString().slice(0, 10);
  const days = parseInt(searchParams.get("days") ?? "28", 10);
  const endDate = new Date(end);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - Math.max(1, Math.min(365, days)));
  return {
    start: searchParams.get("start") ?? startDate.toISOString().slice(0, 10),
    end,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { start, end } = getDateRange(searchParams);
    const summary = await fetchGSCSummary(start, end);
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      message.includes("not set") || message.includes("invalid")
        ? 400
        : message.includes("Permission") || message.includes("403")
          ? 403
          : message.includes("not found") || message.includes("Site URL")
            ? 404
            : 500;
    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
