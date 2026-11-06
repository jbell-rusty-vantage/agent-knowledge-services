import type {
  AcquisitionAdapter,
  AcquisitionPlan,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionVerification,
  AdmittedAcquisitionPlan,
  SupportDecision,
} from "./types.js";

export class RoutedAcquisitionAdapter implements AcquisitionAdapter {
  readonly adapterKey = "routed";
  readonly version = "1.0.0";
  constructor(private readonly adapters: readonly AcquisitionAdapter[]) {
    if (adapters.length === 0) throw new Error("ACQUISITION_ROUTER_EMPTY");
  }
  supports(request: AcquisitionRequest): SupportDecision {
    return (
      this.matching(request)?.supports(request) ?? {
        supported: false,
        reason: "no acquisition adapter for target",
      }
    );
  }
  async plan(request: AcquisitionRequest): Promise<AcquisitionPlan> {
    return this.require(this.matching(request)).plan(request);
  }
  async execute(plan: AdmittedAcquisitionPlan): Promise<AcquisitionResult> {
    return this.require(this.byKey(plan.adapterKey) ?? this.matching(plan.request)).execute(plan);
  }
  async verify(result: AcquisitionResult): Promise<AcquisitionVerification> {
    return this.require(this.byKey(result.plan.adapterKey)).verify(result);
  }
  private matching(request: AcquisitionRequest): AcquisitionAdapter | undefined {
    return this.adapters.find((adapter) => adapter.supports(request).supported);
  }
  private byKey(adapterKey: string): AcquisitionAdapter | undefined {
    return this.adapters.find((adapter) => adapter.adapterKey === adapterKey);
  }
  private require(adapter: AcquisitionAdapter | undefined): AcquisitionAdapter {
    if (!adapter) throw new Error("UNSUPPORTED_TARGET");
    return adapter;
  }
}
