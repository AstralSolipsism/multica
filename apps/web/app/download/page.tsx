import type { Metadata } from "next";
import type { SupportedLocale } from "@multica/core/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export const metadata: Metadata = {
  title: "Download",
};

// Internal build distribution placeholder. The upstream marketing download
// page (OS detection, GitHub release assets, CLI one-liner) was removed with
// the marketing surface; the four in-app entries that link here (login page,
// onboarding welcome + desktop-fork steps, help menu) need this route to
// resolve. Once the internal release source is live (Stage 3), replace the
// copy below with real links to the internal desktop installers / CLI
// artifacts.
const COPY: Record<SupportedLocale, { title: string; body: string }> = {
  en: {
    title: "Download",
    body: "Desktop and CLI builds are distributed through internal release channels.",
  },
  "zh-Hans": {
    title: "下载",
    body: "桌面端与 CLI 安装包通过内部发布渠道分发。",
  },
  ja: {
    title: "ダウンロード",
    body: "デスクトップ版と CLI のビルドは社内のリリース経由で配布されます。",
  },
  ko: {
    title: "다운로드",
    body: "데스크톱 및 CLI 빌드는 사내 릴리스 채널을 통해 배포됩니다.",
  },
};

export default async function DownloadPage() {
  const locale = await getRequestLocale();
  const copy = COPY[locale];

  return (
    <div className="flex h-svh flex-col items-center justify-center gap-2 bg-background px-6 text-center">
      <h1 className="text-title-lg font-medium tracking-tight text-foreground">
        {copy.title}
      </h1>
      <p className="max-w-md text-body text-muted-foreground">{copy.body}</p>
    </div>
  );
}
