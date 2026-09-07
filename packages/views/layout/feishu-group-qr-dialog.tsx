"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useOptionalNavigation } from "../navigation";
import { useT } from "../i18n";

// Site-relative path of the group-invite QR image, served from the web
// app's /public directory. To ship a different QR code, replace
// `apps/web/public/feishu-group-qr.png` — no code change needed.
const QR_PATH = "/feishu-group-qr.png";

/**
 * Group-invite dialog shared by the sidebar card and the help-menu item.
 * Replaces the old outbound discord.gg link: joining the community
 * happens inside the app by scanning a QR code, with no external
 * navigation and no third-party request until the member scans.
 *
 * The image URL goes through the navigation adapter: web is same-origin,
 * and desktop resolves the connected environment's public web URL from its
 * runtime config — required before the shell's navigation provider mounts,
 * so the image can never be asked to load off the renderer's `file://`
 * origin. The optional read only covers isolated mounts outside a provider
 * (and their tests), where the site-relative path is the correct web answer.
 */
export function FeishuQrDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("layout");
  const navigation = useOptionalNavigation();
  const qrUrl = navigation ? navigation.getShareableUrl(QR_PATH) : QR_PATH;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t(($) => $.feishu_qr.title)}</DialogTitle>
          <DialogDescription>{t(($) => $.feishu_qr.hint)}</DialogDescription>
        </DialogHeader>
        <img
          src={qrUrl}
          alt={t(($) => $.feishu_qr.title)}
          className="mx-auto aspect-square w-56 rounded-lg border bg-white"
        />
      </DialogContent>
    </Dialog>
  );
}
