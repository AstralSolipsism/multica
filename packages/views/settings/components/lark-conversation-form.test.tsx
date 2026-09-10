import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enSettings from "../../locales/en/settings.json";
import enCommon from "../../locales/en/common.json";
import { LarkConversationForm } from "./lark-conversation-form";
import type { LarkInstallation } from "@multica/core/types";

const mutation = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: new Error("failed") }));
vi.mock("@multica/core/lark", () => ({ useSetLarkConversation: () => mutation }));

const installation: LarkInstallation = { id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "app", bot_open_id: "bot", installer_user_id: "owner", status: "active", installed_at: "", created_at: "", updated_at: "" };
function view(disabled: boolean) {
  return <I18nProvider locale="en" resources={{ en: { settings: enSettings, common: enCommon } }}>
    <LarkConversationForm workspaceId="ws" installation={installation} disabled={disabled} />
  </I18nProvider>;
}

it("preserves the edited conversations and blocks save/revoke while configuration cannot be verified", () => {
  const { rerender } = render(view(false));
  fireEvent.click(screen.getByText("Agent conversations"));
  const input = screen.getByLabelText(/Group chat IDs/);
  fireEvent.change(input, { target: { value: "oc_group" } });
  rerender(view(true));
  expect(input).toHaveValue("oc_group");
  expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Revoke conversations" })).toBeDisabled();
  expect(mutation.mutateAsync).not.toHaveBeenCalled();
  rerender(view(false));
  fireEvent.click(screen.getByRole("button", { name: "Authorize conversations" }));
  expect(mutation.mutateAsync).toHaveBeenCalledWith([{ chat_id: "oc_group", chat_type: "group" }]);
});
