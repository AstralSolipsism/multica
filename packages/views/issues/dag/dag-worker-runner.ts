/** One cancellable worker per request class. Replacing one class never aborts
 * another. Used by the existing projection and the Stage 8 scene service. */
export function createDagWorkerChannels<Request extends { requestId: number }, Response extends { requestId: number }>(
  factory: () => Worker,
  failureResponse: (requestId: number, error: string) => Response,
) {
  type Active = { requestId: number; done: (response: Response) => void; timer?: ReturnType<typeof setTimeout> };
  type Channel = { worker: Worker; active: Active | null };
  const channels = new Map<string, Channel>();
  const failures = new Map<string, string>();
  const stop = (key: string) => {
    failures.delete(key);
    const channel = channels.get(key);
    if (!channel) return;
    clearTimeout(channel.active?.timer);
    channel.worker.terminate();
    channels.delete(key);
  };
  const prepare = (key: string) => {
    if (failures.has(key)) throw new Error(failures.get(key)!);
    if (channels.has(key)) return channels.get(key)!;
    const worker = factory(), channel: Channel = { worker, active: null };
    channels.set(key, channel);
    const fail = (message: string) => {
      if (channels.get(key) !== channel) return;
      const active = channel.active;
      stop(key);
      failures.set(key, message);
      active?.done(failureResponse(active.requestId, message));
    };
    worker.addEventListener("message", (event: MessageEvent<Response>) => {
      if (channels.get(key) !== channel || !channel.active || event.data?.requestId !== channel.active.requestId) return;
      const active = channel.active;
      clearTimeout(active.timer);
      channel.active = null;
      active.done(event.data);
    });
    worker.addEventListener("error", (event) => fail(event.message || "DAG worker failed"));
    worker.addEventListener("messageerror", () => fail("DAG worker response could not be decoded"));
    return channel;
  };
  return {
    prepare(key: string) { try { prepare(key); } catch (error) { failures.set(key, error instanceof Error ? error.message : "DAG worker failed"); } },
    execute(key: string, request: Request, done: (response: Response) => void, deadline?: { ms: number; expired: () => void }) {
      if (channels.get(key)?.active) stop(key);
      try {
        const channel = prepare(key);
        channel.active = { requestId: request.requestId, done };
        if (deadline) channel.active.timer = setTimeout(() => { stop(key); deadline.expired(); }, deadline.ms);
        channel.worker.postMessage(request);
      } catch (error) {
        stop(key);
        done(failureResponse(request.requestId, error instanceof Error ? error.message : "DAG worker failed"));
      }
    },
    terminate(key?: string) { if (key !== undefined) stop(key); else { for (const key of channels.keys()) stop(key); failures.clear(); } },
  };
}
