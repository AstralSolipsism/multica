import { NextResponse, type NextRequest } from "next/server";

// Retain upstream pages and content; retire their public route trees here.
// The sitemap uses the same policy as the request boundary.
export const RETIRED_MARKETING_PATHS = [
  "/about",
  "/homepage",
  "/changelog",
  "/contact-sales",
  "/usecases",
] as const;

export function isRetiredMarketingPath(pathname: string): boolean {
  // Next can resolve case variants and percent-encoded route segments.
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes cannot resolve a page; keep matching the raw path.
  }
  const path = pathname.toLowerCase();
  return RETIRED_MARKETING_PATHS.some(
    (route) => path === route || path.startsWith(`${route}/`),
  );
}

export function retiredMarketingResponse(req: NextRequest): NextResponse | null {
  if (!isRetiredMarketingPath(req.nextUrl.pathname)) return null;
  const destination = req.nextUrl.clone();
  // Use Next's existing not-found page, including the visible 404 and noindex.
  destination.pathname = "/_not-found";
  destination.search = "";
  return NextResponse.rewrite(destination, {
    status: 404,
    headers: { "X-Robots-Tag": "noindex" },
  });
}
