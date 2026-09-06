"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { configStore } from "@multica/core/config";
import { isDesktopShell } from "../platform/local-directory";
import { useT } from "../i18n";

// Site-relative path of the group-invite QR image, served from the web
// app's /public directory.
//
// TODO(placeholder): the checked-in PNG is a stand-in. Drop the real
// Feishu group QR code over `apps/web/public/feishu-group-qr.png` (same
// filename, no code change needed) once the owner provides it.
const QR_PATH = "/feishu-group-qr.png";

/**
 * The QR image URL for the current client.
 *
 * On web the image lives on the same origin, so the site-relative path
 * always loads. The desktop renderer's document origin (file://) cannot
 * resolve it, so absolutize against the web app URL the server advertises
 * in /api/config (`daemon_app_url`) — the same split-origin treatment as
 * attachment media. If the server hasn't advertised one, fall back to the
 * relative path (broken image rather than a crash; the entry is only
 * useful once the server is reachable anyway).
 */
function qrImageUrl(): string {
  if (!isDesktopShell()) return QR_PATH;
  const appUrl = configStore.getState().daemonAppUrl.replace(/\/+$/, "");
  return appUrl ? `${appUrl}${QR_PATH}` : QR_PATH;
}

/**
 * Group-invite dialog shared by the sidebar card and the help-menu item.
 * Replaces the old outbound discord.gg link: joining the community
 * happens inside the app by scanning a QR code, with no external
 * navigation and no third-party request until the member scans.
 */
export function FeishuQrDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("layout");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t(($) => $.feishu_qr.title)}</DialogTitle>
          <DialogDescription>{t(($) => $.feishu_qr.hint)}</DialogDescription>
        </DialogHeader>
        <img
          src={qrImageUrl()}
          alt={t(($) => $.feishu_qr.title)}
          className="mx-auto aspect-square w-56 rounded-lg border bg-white"
        />
      </DialogContent>
    </Dialog>
  );
}
