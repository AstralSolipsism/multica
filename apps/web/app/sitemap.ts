import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://multica.outlune.com";

  return [
    {
      url: baseUrl,
      lastModified: new Date("2026-04-01"),
      changeFrequency: "weekly",
      priority: 1.0,
    },
  ];
}
