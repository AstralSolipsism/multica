import type { Metadata } from "next";
import type { SupportedLocale } from "@multica/core/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { DownloadClient } from "./download-client";

export const metadata: Metadata = {
  title: "Download",
};

// Server-side fetch of the internal desktop update feed so the page shows the
// live desktop version without baking it into the bundle. Failures degrade to
// a version-less page (the internal source being briefly unreachable must not
// take /download down), so no revalidate bomb and no throw.
const DESKTOP_FEED_PATH = "/downloads/desktop/labrastro.yml";
const DESKTOP_ASSET_DIR = "/downloads/desktop";

type DesktopFeed = { version: string | null; url: string | null };

async function fetchDesktopFeed(): Promise<DesktopFeed> {
  const base = process.env.MULTICA_APP_URL ?? "https://multica.outlune.com";
  try {
    const res = await fetch(`${base}${DESKTOP_FEED_PATH}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return { version: null, url: null };
    const text = await res.text();
    const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    const url = /^path:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    return { version, url };
  } catch {
    return { version: null, url: null };
  }
}

export default async function DownloadPage() {
  const locale = await getRequestLocale();
  const feed = await fetchDesktopFeed();

  return (
    <DownloadClient
      locale={locale}
      desktopVersion={feed.version}
      desktopPath={feed.url ? `${DESKTOP_ASSET_DIR}/${feed.url}` : null}
    />
  );
}
