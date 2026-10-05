import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../test/i18n";
import { JoinDiscordCard } from "./join-discord-card";

const userId = { current: "user-1" as string | undefined };
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (s: { user?: { id?: string } }) => unknown) =>
    selector({ user: userId.current ? { id: userId.current } : undefined }),
}));

afterEach(() => {
  localStorage.clear();
  userId.current = "user-1";
});

describe("JoinDiscordCard", () => {
  // The entry is a button that opens the in-app QR dialog — never an
  // outbound anchor, so joining the community neither navigates away nor
  // contacts a third-party host.
  it("opens the group QR dialog instead of navigating", async () => {
    const user = userEvent.setup();
    renderWithI18n(<JoinDiscordCard />);

    expect(
      screen.queryByRole("link", { name: /Feishu group/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Feishu group/i }));

    const qr = screen.getByRole("img", { name: /Feishu group QR code/i });
    expect(qr).toHaveAttribute("src", "/feishu-group-qr.png");
  });

  it("hides and stays hidden after dismiss, persisting per user", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithI18n(<JoinDiscordCard />);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Feishu group/i)).not.toBeInTheDocument();

    // A fresh mount for the same user keeps the card hidden.
    unmount();
    renderWithI18n(<JoinDiscordCard />);
    expect(screen.queryByText(/Feishu group/i)).not.toBeInTheDocument();
  });

  it("keeps the card visible for a different user", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithI18n(<JoinDiscordCard />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    unmount();

    userId.current = "user-2";
    renderWithI18n(<JoinDiscordCard />);
    expect(
      screen.getByRole("button", { name: /Feishu group/i }),
    ).toBeInTheDocument();
  });

  it("preserves the fork's French dismissal wording", async () => {
    const user = userEvent.setup();
    renderWithI18n(<JoinDiscordCard />, { locale: "fr" });

    const community = screen.getByRole("button", { name: /Feishu/ });
    await user.click(screen.getByRole("button", { name: "Masquer" }));

    expect(community).not.toBeInTheDocument();
  });
});
