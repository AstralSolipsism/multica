// @vitest-environment node
//
// Guards patches/electron-updater@6.8.3.patch. Windows updates first try a
// differential download, and the generic feed sends every changed range in
// one multipart request. Upstream never listened for errors on that response,
// so a connection dropping mid-download (net::ERR_QUIC_PROTOCOL_ERROR in the
// field) surfaced as Electron's "A JavaScript error occurred in the main
// process" dialog instead of the usual fallback to a full download.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CancellationToken } from "electron-updater";
import { GenericDifferentialDownloader } from "electron-updater/out/differentialDownloader/GenericDifferentialDownloader";

type BlockMap = Parameters<GenericDifferentialDownloader["download"]>[0];
type HttpExecutor = ConstructorParameters<typeof GenericDifferentialDownloader>[1];

const BLOCK_SIZE = 4;

function blockMap(checksums: string[]): BlockMap {
  return {
    version: "2",
    files: [
      { name: "file", offset: 0, checksums, sizes: checksums.map(() => BLOCK_SIZE) },
    ],
  };
}

// Stands in for electron-updater's ElectronHttpExecutor, following Electron's
// net module: the response is emitted after end(), and a network failure
// after the response has started destroys the response with the net error,
// then fails the request with the same error (Electron's
// lib/common/api/net-client-request.ts).
class FakeNet {
  readonly ranges: string[] = [];
  private request = new EventEmitter();
  private response = new PassThrough();
  private markResponseStarted!: () => void;
  readonly responseStarted = new Promise<void>((resolve) => {
    this.markResponseStarted = resolve;
  });

  createRequest(
    options: { headers: Record<string, string> },
    callback: (response: PassThrough) => void,
  ): EventEmitter {
    this.ranges.push(options.headers.Range);
    const response = Object.assign(new PassThrough(), {
      statusCode: 206,
      headers: { "content-type": "multipart/byteranges; boundary=PART" },
    });
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        setImmediate(() => {
          request.emit("response", response);
          this.markResponseStarted();
        });
      },
      abort: () => {},
    });
    request.on("response", callback);
    this.request = request;
    this.response = response;
    return request;
  }

  addErrorAndTimeoutHandlers(request: EventEmitter, reject: (error: Error) => void): void {
    request.on("error", reject);
  }

  failResponse(error: Error): void {
    this.response.destroy(error);
  }

  dropConnection(error: Error): void {
    this.failResponse(error);
    this.request.emit("error", error);
  }
}

describe("differential update download", () => {
  let dir: string;
  let uncaught: unknown[] = [];
  const recordUncaught = (error: unknown): void => {
    uncaught.push(error);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "multica-differential-download-"));
    uncaught = [];
    process.on("uncaughtException", recordUncaught);
  });

  afterEach(() => {
    process.off("uncaughtException", recordUncaught);
    rmSync(dir, { recursive: true, force: true });
  });

  async function startDownload(): Promise<{ net: FakeNet; download: Promise<unknown> }> {
    const oldFile = join(dir, "installer.exe");
    writeFileSync(oldFile, Buffer.alloc(2 * BLOCK_SIZE));
    const net = new FakeNet();
    const downloader = new GenericDifferentialDownloader(
      { size: 4 * BLOCK_SIZE, sha512: "" },
      net as unknown as HttpExecutor,
      {
        oldFile,
        newFile: join(dir, "update.exe"),
        newUrl: new URL("https://downloads.example.test/labrastro-desktop-setup.exe"),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        requestHeaders: null,
        // What the generic provider picks for any feed URL outside S3.
        isUseMultipleRangeRequest: true,
        cancellationToken: new CancellationToken(),
      },
    );
    // Blocks x and y are new and not adjacent, so both ranges share one
    // multipart request.
    const download = downloader.download(blockMap(["a", "b"]), blockMap(["a", "x", "b", "y"]));
    await net.responseStarted;
    expect(net.ranges).toEqual(["bytes=4-7, 12-15"]);
    return { net, download };
  }

  it("rejects without an uncaught exception when the connection drops mid-response", async () => {
    const { net, download } = await startDownload();
    const error = new Error("net::ERR_QUIC_PROTOCOL_ERROR");
    net.dropConnection(error);

    // AppUpdater.differentialDownloadInstaller falls back to a full download
    // when this rejects.
    await expect(download).rejects.toBe(error);
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncaught).toEqual([]);
  });

  it("fails the download from the response error alone", async () => {
    const { net, download } = await startDownload();
    const error = new Error("net::ERR_CONNECTION_RESET");
    net.failResponse(error);

    await expect(download).rejects.toBe(error);
    expect(uncaught).toEqual([]);
  });
});
