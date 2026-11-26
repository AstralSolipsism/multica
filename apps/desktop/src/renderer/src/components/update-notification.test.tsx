import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "@multica/views/locales";

import { UpdateNotification } from "./update-notification";

function renderWithLocale(locale: "en" | "zh-Hans" = "en") {
  return render(
    <I18nProvider locale={locale} resources={RESOURCES}>
      <UpdateNotification />
    </I18nProvider>,
  );
}

const mocks = vi.hoisted(() => ({
  installUpdate: vi.fn(),
  openExternal: vi.fn(),
}));

type UpdateDownloadedListener = (info: {
  version: string;
  releaseNotes?: string;
}) => void;

describe("UpdateNotification", () => {
  let updateDownloaded: UpdateDownloadedListener;

  beforeEach(() => {
    mocks.installUpdate.mockReset().mockResolvedValue(undefined);
    mocks.openExternal.mockReset().mockResolvedValue(undefined);

    Object.defineProperty(window, "desktopAPI", {
      configurable: true,
      value: { openExternal: mocks.openExternal },
    });
    Object.defineProperty(window, "updater", {
      configurable: true,
      value: {
        onUpdateDownloaded: (listener: UpdateDownloadedListener) => {
          updateDownloaded = listener;
          return vi.fn();
        },
        installUpdate: mocks.installUpdate,
      },
    });
  });

  it("offers no changelog link — there is no internal changelog to open", () => {
    renderWithLocale();
    act(() => updateDownloaded({ version: "0.4.27" }));

    expect(screen.queryByRole("button", { name: "Later" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "See changelog" }),
    ).not.toBeInTheDocument();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("still installs the update immediately from the primary action", () => {
    renderWithLocale();
    act(() => updateDownloaded({ version: "0.4.27" }));

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));

    expect(mocks.installUpdate).toHaveBeenCalledOnce();
  });

  it("renders localized Chinese copy without adding a changelog link", () => {
    renderWithLocale("zh-Hans");
    act(() => updateDownloaded({ version: "0.4.27" }));

    expect(screen.getByText("更新已就绪")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看更新日志" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即重启" })).toBeInTheDocument();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
