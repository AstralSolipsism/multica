import { DEPLOYMENT_URL } from "@multica/core/deployment";
import { isRetiredMarketingPath } from "../lib/labrastro-marketing";
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = DEPLOYMENT_URL;

  const pages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date("2026-04-01"),
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: new Date("2026-04-01"),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/changelog`,
      lastModified: new Date("2026-04-01"),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/contact-sales`,
      lastModified: new Date("2026-05-21"),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/licensing`,
      lastModified: new Date("2026-09-21"),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: new Date("2026-09-21"),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
  return pages.filter((page) => !isRetiredMarketingPath(new URL(page.url).pathname));
}
