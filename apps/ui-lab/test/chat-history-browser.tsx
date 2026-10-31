// Real Virtuoso/ResizeObserver fixture for e2e/chat-history-scroll.spec.ts.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, setApiInstance } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import type { ChatMessage } from "@multica/core/types";
import { ChatMessageList } from "../../../packages/views/chat/components/chat-message-list";
import enChat from "../../../packages/views/locales/en/chat.json";
import enEditor from "../../../packages/views/locales/en/editor.json";
import "../src/styles.css";

setApiInstance(new ApiClient(window.location.origin));
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function message(index: number): ChatMessage {
  return {
    id: `message-${index}`, chat_session_id: "session", role: "assistant",
    task_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    content: (index === 98 ? '```html\n<div id="media" style="height:120px">Delayed HTML</div><script>addEventListener("message",e=>{if(e.data==="grow")document.getElementById("media").style.height="480px"})</script>\n```\n\n' : "") + Array.from({ length: 8 }, (_, line) => `Reading message ${index}, paragraph ${line}. ` + "A stable line of historical text. ".repeat(4)).join("\n\n"),
  };
}
function Fixture() {
  const [messages, setMessages] = useState(() => Array.from({ length: 50 }, (_, i) => message(i + 50)));
  const [fetching, setFetching] = useState(false);
  return (
    <I18nProvider locale="en" resources={{ en: { chat: enChat, editor: enEditor } }}>
      <QueryClientProvider client={qc}>
        <output id="message-count" style={{ display: "none" }}>{messages.length}</output>
        <div style={{ height: 600, width: 760, display: "flex", flexDirection: "column" }}>
          <ChatMessageList messages={messages} pendingTask={null} availability="online"
            hasOlderMessages={messages[0]?.id !== "message-0"} isFetchingOlderMessages={fetching}
            onLoadOlderMessages={() => {
              if (fetching || messages[0]?.id === "message-0") return;
              setFetching(true);
              setTimeout(() => {
                setMessages((old) => [...Array.from({ length: 50 }, (_, i) => message(i)), ...old]);
                setFetching(false);
              }, 800);
            }} />
        </div>
      </QueryClientProvider>
    </I18nProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
