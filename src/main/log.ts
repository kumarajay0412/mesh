/** Tiny leveled logger for the main process. */
export function log(scope: string) {
  const prefix = `[mesh:${scope}]`
  return {
    info: (...a: unknown[]) => console.log(prefix, ...a),
    warn: (...a: unknown[]) => console.warn(prefix, ...a),
    error: (...a: unknown[]) => console.error(prefix, ...a),
  }
}
