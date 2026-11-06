export interface SemanticDriftObservation {
  readonly requestedModel: string;
  readonly returnedModel?: string;
  readonly deploymentId: string;
  readonly drifted: boolean;
  readonly alertClass: "none" | "returned_model_mismatch";
}

/** A provider that answers with a different model than requested has drifted; the observation is recorded, never repaired. */
export function observeSemanticModelDrift(input: {
  readonly requestedModel: string;
  readonly returnedModel?: string;
  readonly deploymentId: string;
}): SemanticDriftObservation {
  const drifted = input.returnedModel !== undefined && input.returnedModel !== input.requestedModel;
  return Object.freeze({
    ...input,
    drifted,
    alertClass: drifted ? "returned_model_mismatch" : "none",
  });
}

/** No calibrated probability exists yet; raw provider confidences are retained but never interpreted as one. */
export function semanticCalibrationStatus(): {
  readonly status: "pending_empirical_labels";
  readonly calibratedProbabilityAvailable: false;
} {
  return Object.freeze({
    status: "pending_empirical_labels",
    calibratedProbabilityAvailable: false,
  });
}
