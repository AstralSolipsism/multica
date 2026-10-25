import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "@multica/views/locales";
import { toast } from "sonner";
import type {
  DaemonStatus,
  WorkspacesRootInfo,
} from "../../../shared/daemon-types";
import { useLocalDaemonActivity } from "./daemon-activity";
import { DaemonWorkspacesRootRow } from "./daemon-workspaces-root-row";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The hook's own filtering matrix lives in daemon-activity.test.ts; here it is
// stubbed so these tests stay focused on the settings-row interaction flow.
vi.mock("./daemon-activity", () => ({
  useLocalDaemonActivity: vi.fn(() => ({ runtimeCount: 0, affectedTasks: [] })),
}));

const DEFAULT_INFO: WorkspacesRootInfo = {
  effectivePath: "/home/tester/multica_workspaces_desktop-api-example-com",
  customPath: null,
  envOverride: null,
  defaultPath: "/home/tester/multica_workspaces_desktop-api-example-com",
};

function installAPIs(info: WorkspacesRootInfo | null = DEFAULT_INFO) {
  const getWorkspacesRoot = vi.fn().mockResolvedValue(info);
  const setWorkspacesRoot = vi.fn().mockResolvedValue({ success: true });
  const restart = vi.fn().mockResolvedValue({ success: true });
  Object.defineProperty(window, "daemonAPI", {
    configurable: true,
    value: { getWorkspacesRoot, setWorkspacesRoot, restart },
  });
  const pickDirectory = vi.fn();
  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: { pickDirectory },
  });
  return { getWorkspacesRoot, setWorkspacesRoot, restart, pickDirectory };
}

function renderRow(status: DaemonStatus = { state: "running", daemonId: "d1" }) {
  return render(
    <I18nProvider locale="zh-Hans" resources={RESOURCES}>
      <DaemonWorkspacesRootRow status={status} />
    </I18nProvider>,
  );
}

async function renderReadyRow(status?: DaemonStatus) {
  const view = renderRow(status);
  // The path only renders once getWorkspacesRoot resolves.
  await screen.findByText(DEFAULT_INFO.effectivePath);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocalDaemonActivity).mockReturnValue({
    runtimeCount: 0,
    affectedTasks: [],
  });
});

describe("DaemonWorkspacesRootRow — rendering", () => {
  it("shows the effective path and hides reset when no custom path is set", async () => {
    installAPIs();
    await renderReadyRow();

    expect(
      screen.getByRole("button", { name: "更改路径..." }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "恢复默认" }),
    ).not.toBeInTheDocument();
  });

  it("offers reset-to-default when a custom path is configured", async () => {
    installAPIs({
      ...DEFAULT_INFO,
      effectivePath: "/data/multica",
      customPath: "/data/multica",
    });
    renderRow();
    await screen.findByText("/data/multica");

    expect(
      screen.getByRole("button", { name: "恢复默认" }),
    ).toBeEnabled();
  });

  it("disables editing with a read-only note when MULTICA_WORKSPACES_ROOT pins the root", async () => {
    installAPIs({
      ...DEFAULT_INFO,
      effectivePath: "/env/pinned",
      envOverride: "/env/pinned",
    });
    renderRow();
    await screen.findByText("/env/pinned");

    expect(
      screen.getByText(/MULTICA_WORKSPACES_ROOT 固定/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更改路径..." })).toBeDisabled();
  });

  it("disables editing when the daemon is managed outside the app", async () => {
    installAPIs();
    renderRow({ state: "running", daemonId: "d1", externallyManaged: true });
    await screen.findByText(DEFAULT_INFO.effectivePath);

    expect(screen.getByText("由应用外部管理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更改路径..." })).toBeDisabled();
  });
});

describe("DaemonWorkspacesRootRow — change flow ordering", () => {
  it("opens the risk dialog FIRST and does not touch the folder picker", async () => {
    const { pickDirectory } = installAPIs();
    await renderReadyRow();

    fireEvent.click(screen.getByRole("button", { name: "更改路径..." }));

    // All three risks are listed before any picker can open: GC sweep, no
    // migration of the old tree, and the restart that interrupts runs.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/专用的空文件夹/)).toBeInTheDocument();
    expect(screen.getByText(/不会自动迁移/)).toBeInTheDocument();
    expect(screen.getByText(/将立即重启本机守护进程/)).toBeInTheDocument();
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it("does nothing when the risk dialog is cancelled", async () => {
    const { pickDirectory, setWorkspacesRoot, restart } = installAPIs();
    await renderReadyRow();

    fireEvent.click(screen.getByRole("button", { name: "更改路径..." }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(setWorkspacesRoot).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("opens the picker only after confirmation, and stops when the picker is cancelled", async () => {
    const { pickDirectory, setWorkspacesRoot, restart } = installAPIs();
    pickDirectory.mockResolvedValue({ ok: false, reason: "cancelled" });
    await renderReadyRow();

    fireEvent.click(screen.getByRole("button", { name: "更改路径..." }));
    fireEvent.click(
      await screen.findByRole("button", { name: "已知晓，选择文件夹..." }),
    );

    await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(setWorkspacesRoot).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("writes the picked path via the CLI, restarts the daemon, and confirms", async () => {
    const { pickDirectory, setWorkspacesRoot, restart } = installAPIs();
    pickDirectory.mockResolvedValue({
      ok: true,
      path: "/data/multica-ws",
      basename: "multica-ws",
    });
    await renderReadyRow();

    fireEvent.click(screen.getByRole("button", { name: "更改路径..." }));
    fireEvent.click(
      await screen.findByRole("button", { name: "已知晓，选择文件夹..." }),
    );

    await waitFor(() =>
      expect(setWorkspacesRoot).toHaveBeenCalledWith("/data/multica-ws"),
    );
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(
      "任务工作区路径已更新",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("shows the affected run count when runs are active on this daemon", async () => {
    vi.mocked(useLocalDaemonActivity).mockReturnValue({
      runtimeCount: 1,
      affectedTasks: [{}, {}] as never,
    });
    installAPIs();
    await renderReadyRow();

    fireEvent.click(screen.getByRole("button", { name: "更改路径..." }));

    expect(
      await screen.findByText(/本机当前有 2 次运行正在进行/),
    ).toBeInTheDocument();
  });

  it("reports a failed config write and does not restart", async () => {
    const { pickDirectory, setWorkspacesRoot, restart } = installAPIs();
    pickDirectory.mockResolvedValue({ ok: true, path: "/data/x" });
    setWorkspacesRoot.mockResolvedValue({ success: false, error: "nope" });
    await renderReadyRow();

    fireEvent.click(screen.getByRole("button", { name: "更改路径..." }));
    fireEvent.click(
      await screen.findByRole("button", { name: "已知晓，选择文件夹..." }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "更新任务工作区路径失败",
        expect.objectContaining({ description: "nope" }),
      ),
    );
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("DaemonWorkspacesRootRow — reset flow", () => {
  const CUSTOM_INFO: WorkspacesRootInfo = {
    ...DEFAULT_INFO,
    effectivePath: "/data/multica",
    customPath: "/data/multica",
  };

  it("asks for the reset-specific risks (no GC warning) before clearing", async () => {
    installAPIs(CUSTOM_INFO);
    renderRow();
    await screen.findByText("/data/multica");

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/不会自动迁移/)).toBeInTheDocument();
    expect(screen.getByText(/将立即重启本机守护进程/)).toBeInTheDocument();
    // The GC "pick a dedicated empty folder" warning only applies to picking
    // a NEW root, not to restoring the default.
    expect(screen.queryByText(/专用的空文件夹/)).not.toBeInTheDocument();
  });

  it("clears the config and restarts on confirm", async () => {
    const { setWorkspacesRoot, restart, getWorkspacesRoot } =
      installAPIs(CUSTOM_INFO);
    getWorkspacesRoot.mockResolvedValueOnce(CUSTOM_INFO);
    renderRow();
    await screen.findByText("/data/multica");

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "恢复默认并重启" }),
    );

    await waitFor(() => expect(setWorkspacesRoot).toHaveBeenCalledWith(""));
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(
      "任务工作区路径已更新",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });
});
