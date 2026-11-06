// The local profile on its own entry (`@aiengineer/knowledge-host/local`): the capability matrix and the lazy local
// host, without the server composition. A caller that only runs offline commands — the `ks` CLI — loads this entry
// and never the server roles, their persistence or database driver. createHost({ profile: "local" }) composes the same host.
export * from "./capabilities.js";
export * from "./local-host.js";
export * from "./catalog-profile.js";
