import type { ApiAction, LocalApiIdentity } from "@aiengineer/knowledge-host";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

type Access = { tenant: string; identity: LocalApiIdentity };
type RouteInput<Params, Query, Body> = {
  access: Access;
  params: Params;
  query: Query;
  body: Body;
  request: FastifyRequest;
  reply: FastifyReply;
};

interface RouteDefinition<Params, Query, Body, Output> {
  method: "GET" | "POST";
  url: string;
  access: ApiAction;
  params?: z.ZodType<Params>;
  query?: z.ZodType<Query>;
  body?: z.ZodType<Body>;
  call: (input: RouteInput<Params, Query, Body>) => Output | Promise<Output>;
  map?: (output: Output, input: RouteInput<Params, Query, Body>) => unknown;
}

export function createRouteRegistrar(dependencies: {
  server: FastifyInstance;
  requireAccess: (request: FastifyRequest, reply: FastifyReply, action: ApiAction) => Promise<Access | undefined>;
}) {
  return function route<Params = unknown, Query = unknown, Body = unknown, Output = unknown>(
    definition: RouteDefinition<Params, Query, Body, Output>,
  ): void {
    dependencies.server.route({
      method: definition.method,
      url: definition.url,
      handler: async (request, reply) => {
        const access = await dependencies.requireAccess(request, reply, definition.access);
        if (!access) return;
        const input = {
          access,
          params: definition.params ? definition.params.parse(request.params) : (request.params as Params),
          query: definition.query ? definition.query.parse(request.query) : (request.query as Query),
          body: definition.body ? definition.body.parse(request.body) : (request.body as Body),
          request,
          reply,
        };
        const output = await definition.call(input);
        return definition.map ? definition.map(output, input) : output;
      },
    });
  };
}
