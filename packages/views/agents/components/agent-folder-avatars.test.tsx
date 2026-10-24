// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Agent } from "@multica/core/types";
import { AgentFolderAvatars } from "./agent-folder-avatars";

vi.mock("@multica/core/workspace/avatar-url", () => ({ resolvePublicFileUrl: (url: string | null) => url }));

const agents = [
  { id: "image", name: "Image agent", avatar_url: "/api/avatars/sig/avatar.png" },
  { id: "emoji", name: "Emoji agent", avatar_url: "emoji:🚀" },
  { id: "default", name: "Default agent", avatar_url: null },
  { id: "fourth", name: "Fourth agent", avatar_url: null },
  { id: "fifth", name: "Fifth agent", avatar_url: null },
  { id: "sixth", name: "Sixth agent", avatar_url: null },
  { id: "seventh", name: "Seventh agent", avatar_url: null },
] as Agent[];

describe("AgentFolderAvatars", () => {
  it("uses image, emoji and fallback avatars with names, and recalculates overflow at both widths", () => {
    render(<AgentFolderAvatars agents={agents} count={7} emptyLabel="Empty" />);
    const image = screen.getByRole("img", { name: "Image agent" });
    expect(image.getAttribute("src")).toBe("/api/avatars/sig/avatar.png");
    expect(screen.getByRole("img", { name: "Emoji agent" }).textContent).toBe("🚀");
    expect(screen.getByTitle("Default agent").querySelector("svg")).toBeTruthy();
    expect(screen.getByTitle("Fourth agent").className).toContain("hidden @2xl:inline-flex");
    expect(screen.queryByTitle("Fifth agent")).toBeNull();
    expect(screen.getByText("+4").className).toContain("@2xl:hidden");
    expect(screen.getByText("+3").className).toContain("hidden @2xl:inline-flex");
    fireEvent.error(image);
    expect(screen.queryByRole("img", { name: "Image agent" })).toBeNull();
    expect(screen.getByTitle("Image agent").querySelector("svg")).toBeTruthy();
  });

  it("omits overflow for three members and shows only the empty badge for zero", () => {
    const { rerender } = render(<AgentFolderAvatars agents={agents.slice(0, 3)} count={3} emptyLabel="Empty" />);
    expect(screen.queryByText(/^\+/)).toBeNull();
    rerender(<AgentFolderAvatars agents={[]} count={0} emptyLabel="Empty" />);
    expect(screen.getByText("Empty").className).toContain("border-dashed");
    expect(screen.queryByTitle("Image agent")).toBeNull();
  });
});
