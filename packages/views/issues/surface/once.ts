export function once<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= load().catch((error) => {
      pending = undefined;
      throw error;
    }));
}
