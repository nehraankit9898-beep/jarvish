import { NextRequest, NextResponse } from "next/server";
import { detectOpenCode } from "@/lib/agentic/opencode";
import { rejectIfUnauthorized } from "@/lib/agentic/api-auth";

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const executablePath = searchParams.get("path") || undefined;
    const status = await detectOpenCode({ executablePath });
    return NextResponse.json(status);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to detect OpenCode" }, { status: 500 });
  }
}

