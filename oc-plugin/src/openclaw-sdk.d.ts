// Type stub for the OpenClaw plugin SDK.
// The real implementation is provided by OpenClaw at runtime; this file exists
// solely so the local tsc (used by update.sh) can resolve the import without
// requiring OpenClaw's own node_modules to be present.
declare module "openclaw/plugin-sdk/plugin-entry" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function definePluginEntry(entry: Record<string, any>): unknown;
}
