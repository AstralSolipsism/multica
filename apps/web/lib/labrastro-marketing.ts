import { NextResponse, type NextRequest } from "next/server";
import { splitLandingLocale } from "./landing-locale-path";

// Retain upstream pages and content; retire their public route trees here.
// The sitemap uses the same policy as the request boundary.
export const RETIRED_MARKETING_PATHS = [
  "/about",
  "/homepage",
  "/changelog",
  "/contact-sales",
  "/usecases",
  "/blog",
  "/careers",
  "/customers",
  "/press",
  "/pricing",
  "/product",
  "/security",
  "/solutions",
] as const;

export function isRetiredMarketingPath(pathname: string): boolean {
  // Next can resolve case variants and percent-encoded route segments.
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes cannot resolve a page; keep matching the raw path.
  }
  const path = pathname.toLowerCase();
  const landingPath = splitLandingLocale(path)?.path ?? path;
  // Language roots belong to the retired marketing homepage, not internal `/`.
  if (landingPath === "/" && path !== "/") return true;
  return RETIRED_MARKETING_PATHS.some(
    (route) => landingPath === route || landingPath.startsWith(`${route}/`),
  );
}

export function retiredMarketingResponse(req: NextRequest): NextResponse | null {
  const { pathname } = req.nextUrl;
  // A workspace that took a language prefix as its slug keeps its bare root.
  if (
    splitLandingLocale(pathname)?.path === "/" &&
    req.cookies.has("multica_logged_in") &&
    req.cookies.get("last_workspace_slug")?.value === pathname.slice(1)
  ) {
    return null;
  }
  if (!isRetiredMarketingPath(pathname)) return null;
  const destination = req.nextUrl.clone();
  // Use Next's existing not-found page, including the visible 404 and noindex.
  destination.pathname = "/_not-found";
  destination.search = "";
  return NextResponse.rewrite(destination, {
    status: 404,
    headers: { "X-Robots-Tag": "noindex" },
  });
}
