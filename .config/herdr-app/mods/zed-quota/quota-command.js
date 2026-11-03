// npm installs a .cmd shim on Windows, which cannot be spawned as a native executable.
// Keep exec injectable so the fallback and machine forwarding can be checked without Herdr.
export async function runQuotaCommand(exec, options = {}) {
  try {
    return await exec("quota-axi", ["--json"], options);
  } catch (startError) {
    try {
      // Fixed command only: never interpolate paths, credentials or caller arguments into cmd.
      return await exec("cmd.exe", ["/d", "/s", "/c", "quota-axi --json"], options);
    } catch {
      // On Unix, let the existing login-shell fallback handle PATH discovery.
      throw startError;
    }
  }
}
