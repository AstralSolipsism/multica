import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n, I18nProvider } from "@multica/core/i18n/react";
import { CLI_INSTALL_SH_URL } from "@multica/core/deployment";
import { RESOURCES } from "@multica/views/locales";
import type { DaemonStatus } from "../../../shared/daemon-types";
import { DaemonPanel } from "./daemon-panel";
import { DaemonSettingsTab } from "./daemon-settings-tab";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../platform/daemon-reauth", () => ({
  reauthenticateDaemon: vi.fn(),
}));

let emitLogLine: (line: string) => void = () => {};

function installDaemonAPI(status: DaemonStatus) {
  Object.defineProperty(window, "daemonAPI", {
    configurable: true,
    value: {
      getPrefs: vi.fn().mockResolvedValue({ autoStart: true, autoStop: false }),
      setPrefs: vi.fn().mockResolvedValue({ autoStart: true, autoStop: false }),
      isCliInstalled: vi.fn().mockResolvedValue(true),
      getStatus: vi.fn().mockResolvedValue(status),
      onStatusChange: vi.fn(() => () => {}),
      startLogStream: vi.fn(),
      stopLogStream: vi.fn(),
      onLogLine: vi.fn((handler: (line: string) => void) => {
        emitLogLine = handler;
        return () => {};
      }),
    },
  });
}

function renderWithLocale(element: ReactNode, locale: "en" | "zh-Hans" = "zh-Hans") {
  return render(
    <I18nProvider locale={locale} resources={RESOURCES}>
      {element}
    </I18nProvider>,
  );
}

beforeEach(() => {
  emitLogLine = () => {};
  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: { appInfo: { os: "linux" }, openExternal: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("Desktop daemon localization with real resources", () => {
  it.each([["en", "<version>"], ["zh-Hans", "<版本>"]] as const)("%s: interpolates both internal download URLs in the Windows CLI installation help", async (locale, version) => {
    installDaemonAPI({ state: "stopped" });
    vi.mocked(window.daemonAPI.isCliInstalled).mockResolvedValue(false);
    window.desktopAPI.appInfo.os = "windows";

    renderWithLocale(<DaemonSettingsTab />, locale);

    const help = await screen.findByText(createI18n(locale, RESOURCES).getResource(
      locale, "fork-ui", "settings.desktop.daemon.cli_install_windows_label",
    ));
    expect(help).toHaveAttribute("title", expect.stringContaining(`https://multica.outlune.com/downloads/cli/v${version}/`));
    expect(help).toHaveAttribute("title", expect.stringContaining("https://multica.outlune.com/downloads/latest.json"));
    expect(help.getAttribute("title")).not.toContain("{{");
  });

  it.each(["linux", "macos"] as const)("opens the internal shell installer on %s when the CLI is missing", async (os) => {
    installDaemonAPI({ state: "stopped" });
    vi.mocked(window.daemonAPI.isCliInstalled).mockResolvedValue(false);
    window.desktopAPI.appInfo.os = os;

    renderWithLocale(<DaemonSettingsTab />);

    fireEvent.click(await screen.findByRole("button", {
      name: createI18n("zh-Hans", RESOURCES).getResource("zh-Hans", "settings", "desktop.daemon.installation_guide"),
    }));
    expect(window.desktopAPI.openExternal).toHaveBeenCalledExactlyOnceWith(CLI_INSTALL_SH_URL);
  });

  it("lets the locale own the externally managed sentence ending", async () => {
    installDaemonAPI({ state: "running", externallyManaged: true });

    renderWithLocale(<DaemonSettingsTab />);

    expect(
      await screen.findByText(
        "登录时自动启动。",
      ),
    ).toBeInTheDocument();
    const command = screen.getByText("multica daemon stop");
    expect(command.closest("p")).toHaveTextContent(/multica daemon stop。$/);
  });

  it("renders repeated log messages with straight double quotes", async () => {
    installDaemonAPI({ state: "running" });
    renderWithLocale(
      <DaemonPanel
        open
        onOpenChange={vi.fn()}
        status={{ state: "running" }}
        runtimeCount={0}
      />,
    );

    await act(async () => {
      emitLogLine("12:00:00.000 INF poll complete component=daemon");
      emitLogLine("12:00:01.000 INF poll complete component=daemon");
    });

    expect(
      await screen.findByText('另有 1 条"poll complete"——点击展开'),
    ).toBeInTheDocument();
  });
});
