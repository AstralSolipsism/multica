import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESOURCES } from "../test/i18n";
import { JoinDiscordCard } from "./join-discord-card";

// react-i18next isn't initialised in the views test env, so resolve the
// selector against the assembled namespace to assert on actual copy.
vi.mock("../i18n", () => ({
  useT: (namespace: string) => ({
    t: (sel: (r: unknown) => string) => sel(RESOURCES.en[namespace]),
  }),
}));

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
    render(<JoinDiscordCard />);

    expect(
      screen.queryByRole("link", { name: /Feishu group/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Feishu group/i }));

    const qr = screen.getByRole("img", { name: /Feishu group QR code/i });
    expect(qr).toHaveAttribute("src", "/feishu-group-qr.png");
  });

  it("hides and stays hidden after dismiss, persisting per user", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<JoinDiscordCard />);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Feishu group/i)).not.toBeInTheDocument();

    // A fresh mount for the same user keeps the card hidden.
    unmount();
    render(<JoinDiscordCard />);
    expect(screen.queryByText(/Feishu group/i)).not.toBeInTheDocument();
  });

  it("keeps the card visible for a different user", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<JoinDiscordCard />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    unmount();

    userId.current = "user-2";
    render(<JoinDiscordCard />);
    expect(
      screen.getByRole("button", { name: /Feishu group/i }),
    ).toBeInTheDocument();
  });
});
