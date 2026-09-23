/**
 * iOS Safari requires an explicit permission prompt, triggered from a user
 * gesture, before it delivers deviceorientation events. Android/desktop don't.
 */
export async function requestGyroPermission(): Promise<"granted" | "denied" | "unsupported"> {
  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return "unsupported";
  const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> };
  if (typeof DOE.requestPermission === "function") {
    try {
      return await DOE.requestPermission();
    } catch {
      return "denied";
    }
  }
  return "granted";
}
