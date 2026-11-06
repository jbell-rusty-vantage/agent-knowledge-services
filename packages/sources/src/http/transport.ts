import { isIP } from "node:net";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";
import type { IncomingMessage, RequestOptions } from "node:http";
import { defaultPortFor, isForbiddenAddress } from "./policy.js";

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PinnedHttpTransport {
  fetch(url: URL, init: RequestInit, validatedAddresses: readonly string[]): Promise<Response>;
}

export type PinnedRequestOptions = RequestOptions & {
  servername?: string;
  rejectUnauthorized?: boolean;
};

const BODYLESS_STATUSES = new Set([204, 205, 304]);
const FALLBACK_STATUS = 500;

export function buildPinnedRequestOptions(url: URL, init: RequestInit, address: string): PinnedRequestOptions {
  const family = pinnedAddressFamily(address);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.host = url.host;
  const certificateName = url.hostname.replace(/^\[|\]$/g, "");
  return {
    protocol: url.protocol,
    hostname: address,
    family,
    port: url.port || defaultPortFor(url.protocol),
    method: init.method ?? "GET",
    path: `${url.pathname}${url.search}`,
    headers,
    signal: init.signal ?? undefined,
    ...tlsPin(url.protocol, certificateName),
  };
}

export const nodePinnedHttpTransport: PinnedHttpTransport = {
  async fetch(url, init, validatedAddresses) {
    const address = validatedAddresses[0];
    if (!address) throw new Error("PINNED_ADDRESS_INVALID");
    if (init.body !== undefined && init.body !== null) throw new Error("PINNED_TRANSPORT_BODY_UNSUPPORTED");
    const request = url.protocol === "https:" ? requestHttps : requestHttp;
    return await new Promise<Response>((resolve, reject) => {
      const req = request(buildPinnedRequestOptions(url, init, address), (incoming) => resolve(webResponse(incoming)));
      req.once("error", reject);
      req.end();
    });
  },
};

function pinnedAddressFamily(address: string): 4 | 6 {
  const family = isIP(address);
  if ((family !== 4 && family !== 6) || isForbiddenAddress(address)) throw new Error("PINNED_ADDRESS_INVALID");
  return family;
}

function tlsPin(
  protocol: string,
  certificateName: string,
): Pick<PinnedRequestOptions, "servername" | "rejectUnauthorized"> {
  if (protocol !== "https:") return {};
  return {
    ...(isIP(certificateName) === 0 ? { servername: certificateName } : {}),
    rejectUnauthorized: true,
  };
}

function webResponse(incoming: IncomingMessage): Response {
  const status = incoming.statusCode ?? FALLBACK_STATUS;
  const bodyless = BODYLESS_STATUSES.has(status);
  if (bodyless) incoming.resume();
  return new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
    status,
    statusText: incoming.statusMessage ?? "",
    headers: copyRawHeaders(incoming.rawHeaders),
  });
}

function copyRawHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined) break;
    headers.append(name, value);
  }
  return headers;
}
