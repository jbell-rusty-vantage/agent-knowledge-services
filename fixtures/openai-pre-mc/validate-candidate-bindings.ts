import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgresCanonicalRepository, PostgresVerificationRepository } from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-runtime";
import { disposableDatabaseUrl, disposableStorageConfig } from "../../packages/persistence/test/disposable.mjs";

const root=import.meta.dirname;
const files=["candidate-claims-2024.jsonl","candidate-claims-2025.jsonl","candidate-claims-2026.jsonl"];
const hash=(bytes: Uint8Array|string)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const readRows=async(name:string)=>(await readFile(resolve(root,name),"utf8")).trim().split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line));
const inventory=await readRows("sources.jsonl");
const databaseUrl=disposableDatabaseUrl(),storage=disposableStorageConfig();assert.ok(databaseUrl&&storage,"GUARDED_DISPOSABLE_REQUIRED");
const db=new PostgresCanonicalRepository({connectionString:databaseUrl});
const cache=new Map<string,any>(),families=new Map<string,string>(),claims=new Map<string,any>();let quotes=0,dateRanges=0,contextRanges=0;
try {
 for(const file of files)for(const row of await readRows(file)){
  const id=row.claimId??row.candidateId;assert.ok(id&&!claims.has(id),"CLAIM_ID_REQUIRED_UNIQUE");claims.set(id,row);
  assert.equal(row.reviewStatus??row.review?.status,"review_required");assert.equal(row.notAdmissionGold??!row.review?.admissionGold,true);
  const source=row.source;const inventoryRow=inventory.find(item=>item.captureId===source.captureId&&item.tenantId===source.tenantId&&item.terminalStatus==="succeeded");assert.ok(inventoryRow,"ADMITTED_INVENTORY_CAPTURE_REQUIRED");
  assert.equal(source.contentDigest??source.sourceDigest,inventoryRow.contentDigest);
  const key=`${source.tenantId}:${source.projectionArtifactId}`;
  if(!cache.has(key)){
   const repo=new PostgresVerificationRepository(db,new SupabaseArtifactStore({projectUrl:storage.projectUrl,serviceRoleKey:storage.secretKey,bucket:"ai-engineer-cloud-bucket",maximumBytes:8_000_000}),{async authorize(input){assert.equal(input.tenantId,source.tenantId)}});
   const artifact=await repo.getLogicalArtifact({tenantId:source.tenantId,artifactId:source.projectionArtifactId});assert.ok(artifact);assert.equal(artifact.handle.digest,source.projectionDigest);assert.equal(hash(artifact.bytes),source.projectionDigest);
   const result=await repo.getLogicalArtifact({tenantId:source.tenantId,artifactId:inventoryRow.resultArtifactId});assert.ok(result);
   assert.ok(JSON.parse(new TextDecoder().decode(result.bytes)).output.projections.some((p:any)=>p.projectionArtifact.artifactId===source.projectionArtifactId&&p.projectionArtifact.digest===source.projectionDigest),"PROJECTION_NOT_BOUND_TO_ADMITTED_CAPTURE_RESULT");
   cache.set(key,JSON.parse(new TextDecoder().decode(artifact.bytes)));
  }
  const projection=cache.get(key),locator=row.locator??source.locator;
  const page=locator.physicalPageNumber?projection.pages.find((p:any)=>p.physicalPageNumber===locator.physicalPageNumber):undefined;
  const text=page?.text??projection.canonicalText;assert.equal(typeof text,"string");if(page)assert.equal(page.textLayerDigest,locator.textLayerDigest);
  const start=locator.start??locator.startOffset??locator.characterOffset??locator.canonicalTextCharacterOffset;
  const quote=locator.exactQuote??source.quote;const end=locator.end??locator.endOffset??start+(locator.characterLength??locator.canonicalTextCharacterLength);
  assert.equal(text.slice(start,end),quote,`QUOTE_REPLAY:${id}`);if(locator.selectedUtf8Digest)assert.equal(hash(quote),locator.selectedUtf8Digest);quotes++;
  for(const context of [row.supportContext,source.context].filter(Boolean)){const start=context.start??context.startOffset,end=context.end??context.endOffset;assert.equal(text.slice(start,end),context.exactQuote??context.text,`CONTEXT_REPLAY:${id}`);contextRanges++;}
  for(const date of [row.dateLocator,source.publicationDateEvidence,row.dateEvidence,source.dateEvidence].filter(Boolean)){const start=date.start??date.startOffset??date.characterOffset,end=date.end??date.endOffset??start+date.characterLength;const quote=date.exactQuote??date.quote;assert.equal(text.slice(start,end),quote,`DATE_REPLAY:${id}`);dateRanges++;}
  const family=row.sourceFamily??row.split.sourceFamily,split=typeof row.split==="string"?row.split:row.split.assignment;assert.ok(["development","calibration","held_out"].includes(split));assert.ok(!families.has(family)||families.get(family)===split,"FAMILY_SPLIT_LEAKAGE");families.set(family,split);
 }
 const receipt={schemaVersion:"openai-pre-mc-candidate-replay.v1",recordedAt:new Date().toISOString(),passed:true,claims:claims.size,quotes,dateRanges,contextRanges,remoteProjections:cache.size,notAdmissionGold:true,semanticReview:"independent engineering review remains separate from mechanical replay",sourceHashes:Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(resolve(root,file)))])))};
 await writeFile(resolve(root,"candidate-replay.result.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify(receipt));
}finally{await db.close()}
