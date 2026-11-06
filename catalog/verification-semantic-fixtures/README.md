# Retained semantic replay fixtures

These private fixtures supplement an immutable benchmark dataset. They do not change its frozen bytes, labels, provider grants, or admission status.

`cedad3b42fc7d04c05cee35fff30bb75521cdf95f9d3280859abfa517956b495` contains 18 verified artifact handles and byte objects for the exact v1 `tru-symphony-source` claims run. The original signed audit is retained as `origin-audit.json`. The source proof is `verification-semantic-mission-control-0562c6a5-aebe-4d96-80bf-fee931ef9a2a`; its public verification key and separate report run are retained in the workspace evidence.

This first fixture is incomplete for standalone deterministic replay: it does not retain the authenticated runtime-principal binding used by the native run, and its fragment uses a run-local ID rather than the frozen benchmark fragment ID. The selector, selected bytes, and assertion match; full replay binding does not. Consumers must fail closed rather than invent the missing binding or silently substitute identities. A successor fixture must retain the new sealed binding artifact and the original benchmark fragment ID. Do not rewrite this fixture to imply that the original run retained information it did not retain.

The public assertion and selected fragment were checked for exact equality against the existing bounded D-013 processing grant. The calls used the D-014 completion cohort. No human-gold labels or policy admission were produced.

The current CLI fixture is `c63055da4dee19de98bfdaf8fafa7884fef6ae9f127964041b2dc4d97d561352`, containing 19 authenticated artifact objects from native proof `verification-semantic-mission-control-a576b3d0-6406-4e89-8c54-01b9f9ffe6d6`. It retains the sealed server-resolved runtime-principal binding and exact frozen benchmark fragment ID. Its origin audit signature and complete artifact closure were verified before export. The loader verifies its pinned canonical manifest digest and every artifact's bytes and parent references; the replay adapter re-admits retained projections, reproduces the deterministic result, and replays the captured semantic assessment without network access or new artifact writes.

This successor supplies one evidence-only assessment for `tru-symphony-source`, not the full paired benchmark or a human judgment. The native claims/report workflows remain `review_required`. The earlier incomplete fixture remains unchanged as historical evidence.


EV166 fixture `a035191eb769dd706b47ef784ce6654a1cf8ec9ab07e4fea07a627520b3faabc` contains two missing v1 cases, 36 independently checked native artifact objects. Offline replay passed with networking disabled. This new engineering attempt supplements the retained 38-case fixture and preserves prior failed attempts; it is not human gold or single-pass quality acceptance. Both outcomes require review. The installed demo has not yet been repinned.


EV167 installed fixture `7067f432979212167ca1d7b797e37e6d0b5f5b180dc5919a210010017860c82c` composes the original 38-case fixture `768721ef0648e5ca6beddf5606ee533dac40c194c081af159d4738513b95f058` with EV166 two-case fixture `a035191eb769dd706b47ef784ce6654a1cf8ec9ab07e4fea07a627520b3faabc`. All 40 original assessment identities and results replay unchanged. Ten shared handles matched exactly; 524 distinct artifact objects are retained. This is multi-run engineering coverage; original failures are preserved and no single-pass quality claim is made. The original two fixture directories remain immutable. The CLI now defaults to the composed fixture.
