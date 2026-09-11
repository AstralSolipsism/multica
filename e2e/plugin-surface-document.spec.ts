import { expect, test, type Page } from "@playwright/test";
import { buildSurfaceFrameDocument } from "../packages/views/plugins/surface-document";

/**
 * Real Chromium coverage for the trusted srcdoc wrapper and its URL-hosted,
 * opaque guest. Hosted fixtures speak the current single-use v2 port protocol;
 * host listeners must be armed before srcdoc, as in PluginSurfaceFrame.
 */
interface SurfaceState {
  challenges: string[];
  replies: string[];
  terminal: string[];
}

async function mountHost(page: Page) {
  await page.setContent(`<!doctype html><body>
    <iframe id="surface" sandbox="allow-scripts allow-same-origin"></iframe>
    <script>
      window.surfaceState = { challenges: [], replies: [], terminal: [] };
      addEventListener("message", event => {
        const frame = document.querySelector("#surface");
        if (event.source !== frame.contentWindow) return;
        const type = event.data?.type;
        if (type === "multica:plugin-bridge-connect" && event.ports[0]) {
          window.surfaceState.challenges.push(event.data.challenge);
          window.surfacePort?.close();
          window.surfacePort = event.ports[0];
          window.surfacePort.onmessage = event => window.surfaceState.replies.push(event.data);
          window.surfacePort.postMessage("ping");
        }
        if (type === "multica:plugin-surface-error" ||
            type === "multica:plugin-surface-navigated" ||
            type === "multica:plugin-surface-navigation-blocked") {
          window.surfaceState.terminal.push(type);
          window.surfacePort?.close();
        }
      });
    </script>
  </body>`);
}

function readState(page: Page) {
  return page.evaluate(() => (window as unknown as { surfaceState: SurfaceState }).surfaceState);
}

async function launchSurface(page: Page, launch: string) {
  await page.locator("#surface").evaluate((frame, srcdoc) => {
    (frame as HTMLIFrameElement).srcdoc = srcdoc;
  }, buildSurfaceFrameDocument({
    url: `https://plugin-content.example.test/plugin-surfaces/${launch}`,
    bridgeToken: launch,
  }));
}

test.describe("plugin surface document (real Chromium, hosted guest)", () => {
  test("a host-authored launch reload connects a fresh port without hostile navigation", async ({ page }) => {
    const requests: string[] = [];
    await page.route("https://plugin-content.example.test/plugin-surfaces/*", async (route) => {
      const launch = new URL(route.request().url()).pathname.split("/").at(-1)!;
      requests.push(launch);
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
          addEventListener("pagehide", () => parent.postMessage({ type: "multica:plugin-surface-navigated" }, "*"));
          const channel = new MessageChannel();
          channel.port2.onmessage = event => channel.port2.postMessage(${JSON.stringify(launch)} + ":" + event.data);
          parent.postMessage({ type: "multica:plugin-bridge-connect", version: 2, challenge: ${JSON.stringify(launch)} }, "*", [channel.port1]);
        </script>`,
      });
    });
    await mountHost(page);
    for (const launch of ["first-proof", "replacement-proof"]) {
      await launchSurface(page, launch);
      await expect.poll(async () => (await readState(page)).replies).toContain(`${launch}:ping`);
    }
    expect(requests).toEqual(["first-proof", "replacement-proof"]);
    expect(await readState(page)).toEqual({
      challenges: ["first-proof", "replacement-proof"],
      replies: ["first-proof:ping", "replacement-proof:ping"],
      terminal: [],
    });
  });

  test("reports a first-line guest error to the listener armed before launch", async ({ page }) => {
    await page.route("https://plugin-content.example.test/plugin-surfaces/error-proof", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        // The hosted bootstrap installs this handler before inserting plugin
        // code. The wrapper relays the one-shot terminal signal to the host.
        body: `<!doctype html><body><script>
          addEventListener("error", () => parent.postMessage({ type: "multica:plugin-surface-error" }, "*"));
          const plugin = document.createElement("script");
          plugin.textContent = "throw new Error('plugin failed during bootstrap');";
          document.body.appendChild(plugin);
        </script></body>`,
      });
    });
    await mountHost(page);
    await launchSurface(page, "error-proof");
    await expect.poll(() => readState(page)).toEqual({
      challenges: [],
      replies: [],
      terminal: ["multica:plugin-surface-error"],
    });
  });

  test("rejects wrong proofs and protocol versions and relays the valid port only once", async ({ page }) => {
    await page.route("https://plugin-content.example.test/plugin-surfaces/valid-proof", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
          for (const [version, challenge, reply] of [
            [2, "wrong-proof", "wrong-proof"],
            [1, "valid-proof", "wrong-version"],
            [2, "valid-proof", "accepted"],
            [2, "valid-proof", "replayed"]
          ]) {
            const channel = new MessageChannel();
            channel.port2.onmessage = () => channel.port2.postMessage(reply);
            parent.postMessage({ type: "multica:plugin-bridge-connect", version, challenge }, "*", [channel.port1]);
          }
        </script>`,
      });
    });
    await mountHost(page);
    await launchSurface(page, "valid-proof");
    await expect.poll(async () => (await readState(page)).replies).toEqual(["accepted"]);
    expect(await readState(page)).toEqual({ challenges: ["valid-proof"], replies: ["accepted"], terminal: [] });
  });
});
