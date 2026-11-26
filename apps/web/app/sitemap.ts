import type { MetadataRoute } from "next";
import { DEPLOYMENT_URL } from "@multica/core/deployment";
import { landingAlternates } from "@/lib/landing-locale-path";
import { createEnDict } from "@/features/landing/i18n/en";
import { isLiveRoute, siteRoutes } from "@/features/landing/site/sitemap";
import { isRetiredMarketingPath } from "../lib/labrastro-marketing";

type SitemapHints = Pick<MetadataRoute.Sitemap[number], "changeFrequency" | "priority">;

const HINTS: Readonly<Record<string, SitemapHints>> = {
  "/": { changeFrequency: "weekly", priority: 1.0 },
  "/about": { changeFrequency: "monthly", priority: 0.7 },
  "/changelog": { changeFrequency: "weekly", priority: 0.6 },
  "/contact-sales": { changeFrequency: "monthly", priority: 0.7 },
  "/download": { changeFrequency: "weekly", priority: 0.8 },
  "/licensing": { changeFrequency: "monthly", priority: 0.6 },
  "/privacy": { changeFrequency: "yearly", priority: 0.3 },
};

/** Pages that list recent releases change with each one. */
const RELEASE_PAGES: Record<string, true> = { "/": true, "/changelog": true };

function latestReleaseDate(): Date | undefined {
  const dates = createEnDict().changelog.entries.map((entry) => entry.date).sort();
  const latest = dates.at(-1);
  return latest ? new Date(latest) : undefined;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const releasedAt = latestReleaseDate();

  return siteRoutes()
    .filter(isLiveRoute)
    .filter((route) => !isRetiredMarketingPath(route))
    .map((route) => ({
      url: route === "/" ? DEPLOYMENT_URL : `${DEPLOYMENT_URL}${route}`,
      ...(RELEASE_PAGES[route] && releasedAt ? { lastModified: releasedAt } : {}),
      ...(HINTS[route] ?? { changeFrequency: "monthly", priority: 0.5 }),
      alternates: {
        languages: Object.fromEntries(
          Object.entries(landingAlternates(route, DEPLOYMENT_URL)).filter(
            ([, href]) => !isRetiredMarketingPath(new URL(href).pathname),
          ),
        ),
      },
    }));
}
