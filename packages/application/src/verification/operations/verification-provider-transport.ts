import { z } from "zod";
import { VerificationArtifactHandleSchema } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, providerDigest, sha256Digest } from "@aiengineer/knowledge-verification";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const VerificationProviderTransportBindingSchema = z.strictObject({
  tenantId: z.uuid(),
  operationId: z.uuid(),
  operationStepId: z.uuid(),
  providerAttemptId: z.uuid(),
  profileArtifactId: z.uuid(),
  profileDigest: digest,
  dispatchFencingToken: z.int().positive(),
});
export type VerificationProviderTransportBinding = z.infer<typeof VerificationProviderTransportBindingSchema>;
export const VerificationProviderTransportResponseSchema = z.strictObject({
  schemaVersion: z.literal("verification-provider-transport-response.v1"),
  binding: VerificationProviderTransportBindingSchema,
  httpStatus: z.int().min(200).max(599),
  requestDigest: digest,
  responseEnvelope: VerificationArtifactHandleSchema,
  rawResponse: VerificationArtifactHandleSchema,
});
export type VerificationProviderTransportResponse = z.infer<typeof VerificationProviderTransportResponseSchema>;

/** Body status is never interpreted or inferred here. The adapter supplies it. */
export function prepareVerificationProviderTransportResponse(
  input: Omit<VerificationProviderTransportResponse, "schemaVersion">,
) {
  const response = VerificationProviderTransportResponseSchema.parse({
    schemaVersion: "verification-provider-transport-response.v1",
    ...input,
  });
  if (
    response.responseEnvelope.tenantId !== response.binding.tenantId ||
    response.rawResponse.tenantId !== response.binding.tenantId ||
    response.responseEnvelope.parentArtifactIds.length !== 2 ||
    response.responseEnvelope.parentArtifactIds[1] !== response.rawResponse.artifactId
  )
    throw new Error("PROVIDER_TRANSPORT_RESPONSE_BINDING_INVALID");
  const bytes = new TextEncoder().encode(canonicalizeJson(response));
  if (bytes.byteLength > 32_000) throw new Error("PROVIDER_TRANSPORT_RESPONSE_BYTES_EXCEEDED");
  const payloadDigest = providerDigest(response);
  const b = response.binding;
  // Every field is a validated UUID, digest or integer; the delimiter cannot
  // occur inside a field. SQL reconstructs this binding from canonical rows.
  const transformationSignature = sha256Digest(
    [
      "verification-provider-transport-binding.v1",
      payloadDigest,
      b.tenantId,
      b.operationId,
      b.operationStepId,
      b.providerAttemptId,
      b.profileArtifactId,
      b.profileDigest,
      String(b.dispatchFencingToken),
      String(response.httpStatus),
      response.responseEnvelope.artifactId,
      response.rawResponse.artifactId,
      response.rawResponse.digest,
      response.requestDigest,
    ].join("|"),
  );
  return {
    response,
    bytes,
    payloadDigest,
    parentArtifactIds: [response.responseEnvelope.artifactId, response.binding.profileArtifactId],
    transformationSignature,
  };
}
