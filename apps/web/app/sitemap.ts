import { DEPLOYMENT_URL } from "@multica/core/deployment";
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = DEPLOYMENT_URL;

  return [
    {
      url: baseUrl,
      lastModified: new Date("2026-04-01"),
      changeFrequency: "weekly",
      priority: 1.0,
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
}
