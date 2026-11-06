import type { FastifyReply, FastifyRequest } from "fastify";
import { correlationId } from "../plugins/correlation.js";
import { problem, sendProblem } from "./problem-map.js";

export async function admitBody<Body>(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  parse: (raw: unknown) => Body;
  admission: ((body: Body) => boolean | Promise<boolean>) | undefined;
  unavailable: string;
  denied: string;
}): Promise<{ body: Body } | undefined> {
  const { request, reply } = input;
  if (!input.admission) {
    sendProblem(reply, problem(503, "CAPABILITY_NOT_ADMITTED", input.unavailable, correlationId(request)));
    return undefined;
  }
  const body = input.parse(request.body);
  if (!(await input.admission(body))) {
    sendProblem(reply, problem(403, "FORBIDDEN", input.denied, correlationId(request)));
    return undefined;
  }
  return { body };
}
