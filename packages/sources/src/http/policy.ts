import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

export interface HttpPolicy {
  allowedProtocols: readonly ("http:" | "https:")[];
  allowedPorts: readonly number[];
  maximumRedirects: number;
  timeoutMs: number;
  maximumBytes: number;
  maximumDecompressionRatio: number;
  allowedHosts?: readonly string[];
  deniedHosts?: readonly string[];
}

export interface DnsResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export const defaultResolver: DnsResolver = {
  async resolve(hostname) {
    return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  },
};

const HTTPS_PORT = 443;
const HTTP_PORT = 80;
const ALWAYS_DENIED_HOSTS = new Set(["localhost", "metadata.google.internal"]);
const FORBIDDEN_IPV6_ADDRESSES = ["::", "::1"] as const;
const FORBIDDEN_IPV6_SUBNETS = [
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const;
const FORBIDDEN_IPV4_SUBNETS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const;

const { ipv4: forbiddenIpv4, ipv6: forbiddenIpv6 } = createForbiddenLists();

export function defaultPortFor(protocol: string): number {
  return protocol === "https:" ? HTTPS_PORT : HTTP_PORT;
}

export function isForbiddenAddress(address: string): boolean {
  const normalized = normalizeIpLiteral(address);
  if (isIP(normalized) === 6) return forbiddenIpv6.check(normalized, "ipv6");
  return isIP(normalized) !== 4 || forbiddenIpv4.check(normalized, "ipv4");
}

export interface SafeHttpTarget {
  url: URL;
  addresses: readonly string[];
}

export async function resolveSafeHttpTarget(
  raw: string,
  policy: HttpPolicy,
  resolver: DnsResolver,
): Promise<SafeHttpTarget> {
  const url = new URL(raw);
  assertAllowedProtocol(url.protocol, policy);
  assertNoUrlCredentials(url);
  assertAllowedPort(url, policy);
  const host = normalizeHostname(url.hostname);
  assertHostPermitted(host, policy);
  const addresses = await resolveHostAddresses(host, resolver);
  assertAddressesPermitted(addresses);
  return { url, addresses: [...new Set(addresses)] };
}

export async function assertSafeHttpUrl(raw: string, policy: HttpPolicy, resolver: DnsResolver): Promise<URL> {
  return (await resolveSafeHttpTarget(raw, policy, resolver)).url;
}

function createForbiddenLists(): { ipv4: BlockList; ipv6: BlockList } {
  const ipv6 = new BlockList();
  const ipv4 = new BlockList();
  for (const address of FORBIDDEN_IPV6_ADDRESSES) ipv6.addAddress(address, "ipv6");
  for (const [network, prefix] of FORBIDDEN_IPV6_SUBNETS) ipv6.addSubnet(network, prefix, "ipv6");
  for (const [network, prefix] of FORBIDDEN_IPV4_SUBNETS) {
    ipv4.addSubnet(network, prefix, "ipv4");
    ipv6.addSubnet(`::ffff:${network}`, 96 + prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

function assertAllowedProtocol(protocol: string, policy: HttpPolicy): void {
  if (!policy.allowedProtocols.some((allowed) => allowed === protocol)) throw new Error("PROTOCOL_DENIED");
}

function assertNoUrlCredentials(url: URL): void {
  if (url.username || url.password) throw new Error("URL_CREDENTIALS_DENIED");
}

function assertAllowedPort(url: URL, policy: HttpPolicy): void {
  const port = url.port ? Number(url.port) : defaultPortFor(url.protocol);
  if (!policy.allowedPorts.includes(port)) throw new Error("PORT_DENIED");
}

function assertHostPermitted(host: string, policy: HttpPolicy): void {
  if (isDeniedHost(host, policy)) throw new Error("HOST_DENIED");
  if (policy.allowedHosts && !policy.allowedHosts.includes(host)) throw new Error("HOST_NOT_ALLOWLISTED");
}

async function resolveHostAddresses(host: string, resolver: DnsResolver): Promise<readonly string[]> {
  return isIP(host) ? [host] : resolver.resolve(host);
}

function assertAddressesPermitted(addresses: readonly string[]): void {
  if (addresses.length === 0 || addresses.some(isForbiddenAddress)) throw new Error("ADDRESS_DENIED");
}

function isDeniedHost(host: string, policy: HttpPolicy): boolean {
  return Boolean(policy.deniedHosts?.includes(host)) || ALWAYS_DENIED_HOSTS.has(host) || host.endsWith(".localhost");
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function normalizeIpLiteral(address: string): string {
  const [literal] = normalizeHostname(address).split("%");
  return literal ?? "";
}
