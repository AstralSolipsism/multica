import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enOnboarding from "../locales/en/onboarding.json";
import { StepPlatformFork } from "./steps/step-platform-fork";
import { StepRuntimeConnect } from "./steps/step-runtime-connect";

// Existing step tests exercise the real, disabled fork policy. This proves
// upstream cards still exist and only the mount gate hides them.
vi.mock("./labrastro-marketing", () => ({ SHOW_CLOUD_PROMOTION: true }));
vi.mock("./components/use-runtime-picker", () => ({
  useRuntimePicker: () => ({
    runtimes: [], selected: null, selectedId: null,
    setSelectedId: vi.fn(), hasRuntimes: false,
  }),
}));

afterEach(() => vi.useRealTimers());

describe("retained upstream cloud cards", () => {
  it.each(["web", "desktop"])("%s retains its card behind the disabled fork gate", (platform) => {
    vi.useFakeTimers();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider locale="en" resources={{ en: { common: enCommon, onboarding: enOnboarding } }}>
          {platform === "web"
            ? <StepPlatformFork wsId="test" onNext={vi.fn()} cliInstructions={<div>CLI</div>} />
            : <StepRuntimeConnect wsId="test" onNext={vi.fn()} />}
        </I18nProvider>
      </QueryClientProvider>,
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText("Use a cloud computer")).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
  });
});
