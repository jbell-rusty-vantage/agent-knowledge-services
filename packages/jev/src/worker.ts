import { callProvider, ProviderFailure } from "./provider.js";
import type { ProviderCall } from "./provider.js";

process.on("disconnect", () => process.exit(0));
let busy = false;
process.on("message", async (message: { id: string; call: ProviderCall }) => {
  if (busy) return;
  busy = true;
  try {
    const result = await callProvider(message.call);
    process.send?.({ id: message.id, result });
  } catch (error) {
    const failure = error instanceof ProviderFailure ? error : new ProviderFailure("WORKER_FAILURE", false);
    process.send?.({
      id: message.id,
      error: { code: failure.code, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs },
    });
  } finally {
    busy = false;
  }
});
