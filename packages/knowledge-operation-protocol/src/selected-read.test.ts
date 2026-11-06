import { describe, expect, it } from "vitest";
import { digestBytes } from "./canonical.js";
import { ResearchReportPackageSchema, SelectedReportReadSchema, selectedReadDigest } from "./selected-read.js";
import { selectedMembersPackage, selectedMembersRead, selectedRevisionRead } from "./test-support.js";

describe("selected-report-read.v2", () => {
  it("accepts an exact members selection and a whole revision", () => {
    expect(SelectedReportReadSchema.parse(selectedMembersRead())).toEqual(selectedMembersRead());
    expect(SelectedReportReadSchema.parse(selectedRevisionRead()).selection).toEqual({ mode: "revision" });
  });

  it("refuses an undeclared or malformed purpose, a bare id, an empty or unsorted selection and extra fields", () => {
    const read = selectedMembersRead();
    const members = read.selection as Extract<typeof read.selection, { mode: "members" }>;
    const assertion = members.assertions[0] as (typeof members.assertions)[number];
    const { purpose: _purpose, ...withoutPurpose } = read;
    const refused = [
      withoutPurpose,
      { ...read, purpose: "Not A Purpose" },
      { ...read, exact: false },
      { ...read, extra: 1 },
      { ...read, selection: { ...members, assertions: [assertion.id] } },
      { ...read, selection: { mode: "members", assertions: [], evidence: [] } },
      { ...read, selection: { ...members, assertions: [assertion, assertion] } },
      { ...read, selection: { ...members, assertions: [{ ...assertion, id: "z" }, assertion] } },
      { ...read, selection: { ...members, evidence: [{ ...assertion, kind: "assertion" }] } },
      { ...read, selection: { mode: "revision", assertions: [] } },
    ];
    for (const candidate of refused) expect(SelectedReportReadSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("research-report-package.v2", () => {
  it("holds exactly the selected members, each record digesting to its handle", () => {
    const pkg = selectedMembersPackage();
    expect(ResearchReportPackageSchema.parse(pkg)).toEqual(pkg);
    expect(pkg.request).toBe(selectedReadDigest(selectedMembersRead()));
  });

  it("refuses a widened, edited or partial package", () => {
    const pkg = selectedMembersPackage();
    const assertion = pkg.assertions[0] as (typeof pkg.assertions)[number];
    const refused = [
      {
        ...pkg,
        assertions: [{ ...assertion, record: { ...(assertion.record as Record<string, unknown>), edited: true } }],
      },
      { ...pkg, assertions: [] },
      { ...pkg, evidence: [...pkg.evidence, ...pkg.evidence] },
      {
        ...pkg,
        body: {
          path: "body.md",
          digest: digestBytes("body"),
          bytes: 4,
          artifact: {
            kind: "artifact",
            id: "artifact-body",
            version: "artifact.v1",
            digest: digestBytes("body"),
            tenant: pkg.report.tenant,
            binding: pkg.report.binding,
          },
        },
      },
      { ...pkg, selection: { mode: "revision" } },
    ];
    for (const candidate of refused) expect(ResearchReportPackageSchema.safeParse(candidate).success).toBe(false);
  });
});
