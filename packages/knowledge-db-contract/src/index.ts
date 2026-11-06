// K09: the common knowledge_verification SQL component and its fail-closed installer.
export { DEFAULT_COMPONENT_ROOT, loadComponent, sha256Hex } from "./component.js";
export type { Component, ComponentManifest, Migration, ReleaseSpec } from "./component.js";
export { InstallRefused, inspect, install } from "./installer.js";
export type { InstallReceipt, InstallTarget, Inspection } from "./installer.js";
export * from "./seal-keys.js";
