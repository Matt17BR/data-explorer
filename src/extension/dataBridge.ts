import type { OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface BridgeRequestOptions {
  cancellation?: CancellationTokenLike;
  priority?: "interactive" | "background";
  timeoutMs?: number;
}

export interface OpenWranglerBridge {
  request(request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse>;
  setActiveSession?(sessionId: string | undefined): void;
  onIdle?(): void;
}
