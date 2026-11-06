import { describe, expect, it } from "vitest";
import type { VerificationSourceAssessment } from "@aiengineer/knowledge-contracts";
import { assessSourceAuthority } from "./assessment.js";

function companyStatement(overrides: Partial<VerificationSourceAssessment> = {}): VerificationSourceAssessment {
  return {
    assessmentId: "assessment-1",
    assertionId: "claim-1",
    fragmentId: "fragment-1",
    sourceFamilyId: "company-family",
    sourceOrganizationId: "company-org",
    vector: {
      authority: "promotional",
      independence: "self_reported",
      directness: "direct",
      freshness: "current",
      applicability: "direct",
    },
    claimScope: "descriptive_fact",
    evidenceScope: "company_statement",
    publicationRelation: "not_publication",
    jurisdictionKnown: true,
    licenseKnown: true,
    freshnessKnown: true,
    ...overrides,
  };
}

function independentPaper(overrides: Partial<VerificationSourceAssessment> = {}): VerificationSourceAssessment {
  return companyStatement({
    assessmentId: "assessment-2",
    fragmentId: "fragment-2",
    sourceFamilyId: "paper-family",
    sourceOrganizationId: "university",
    vector: {
      authority: "primary",
      independence: "independent",
      directness: "direct",
      freshness: "current",
      applicability: "direct",
    },
    claimScope: "method_validation",
    evidenceScope: "population",
    publicationRelation: "validates_antecedent_method",
    ...overrides,
  });
}

describe("source authority withholding", () => {
  it("withholds authority for a promotional clinical-utility claim", () => {
    expect(assessSourceAuthority("claim-1", [companyStatement({ claimScope: "clinical_utility" })])).toMatchObject({
      status: "withheld",
      independentCorroboration: false,
    });
  });

  it("does not let a single-sample technical result carry population accuracy", () => {
    expect(
      assessSourceAuthority("claim-1", [
        companyStatement({
          claimScope: "population_accuracy",
          evidenceScope: "single_sample_technical",
        }),
      ]).reasonCodes,
    ).toContain("SINGLE_SAMPLE_TECHNICAL_RESULT_NOT_POPULATION_ACCURACY");
  });

  it("does not let an antecedent-method publication validate the product", () => {
    expect(
      assessSourceAuthority("claim-1", [
        companyStatement({
          claimScope: "product_validation",
          evidenceScope: "antecedent_method",
          publicationRelation: "validates_antecedent_method",
        }),
      ]).reasonCodes,
    ).toContain("PUBLICATION_DOES_NOT_VALIDATE_PRODUCT");
  });
});

describe("source authority sufficiency", () => {
  it("accepts an independent primary source in scope", () => {
    expect(assessSourceAuthority("claim-1", [independentPaper()])).toMatchObject({
      status: "sufficient",
      independentCorroboration: true,
    });
  });

  it("requires population applicability on the independent source itself", () => {
    expect(
      assessSourceAuthority("claim-1", [
        independentPaper({
          claimScope: "population_accuracy",
          evidenceScope: "single_sample_technical",
        }),
        companyStatement({
          assessmentId: "assessment-interested-population",
          fragmentId: "fragment-interested-population",
          claimScope: "population_accuracy",
          evidenceScope: "population",
        }),
      ]),
    ).toMatchObject({
      status: "withheld",
      independentCorroboration: true,
      reasonCodes: expect.arrayContaining(["SINGLE_SAMPLE_TECHNICAL_RESULT_NOT_POPULATION_ACCURACY"]),
    });
  });

  it("requires product applicability on the independent source itself", () => {
    expect(
      assessSourceAuthority("claim-1", [
        independentPaper({
          claimScope: "product_validation",
          evidenceScope: "single_sample_technical",
        }),
        companyStatement({
          assessmentId: "assessment-interested-product",
          fragmentId: "fragment-interested-product",
          claimScope: "product_validation",
          evidenceScope: "commercial_product",
          publicationRelation: "validates_product",
        }),
      ]),
    ).toMatchObject({
      status: "withheld",
      independentCorroboration: true,
      reasonCodes: expect.arrayContaining(["PUBLICATION_DOES_NOT_VALIDATE_PRODUCT"]),
    });
  });
});
