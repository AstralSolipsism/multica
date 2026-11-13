import { LocaleProvider } from "@/features/landing/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialLocale = await getRequestLocale();

  return (
    <div className="landing-light h-full overflow-x-hidden overflow-y-auto bg-white">
      <LocaleProvider initialLocale={initialLocale}>{children}</LocaleProvider>
    </div>
  );
}
