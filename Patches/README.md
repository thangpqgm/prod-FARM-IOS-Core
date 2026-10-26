# WebDriverAgent patches

`npm run wda:prepare` applies `wda-16.1.1-farm.patch` to the WebDriverAgent bundled with the pinned
`appium-xcuitest-driver` 12.1.4 (appium-webdriveragent 16.1.1), then builds and signs it:

- `POST /wda/absolute-actions` (no session): a single viewport touch sent straight through
  `FBXCTestDaemonsProxy synthesizeEventWithRecord` — no app snapshot, no idle wait, so taps on the
  TikTok video feed take ~0.4s instead of hanging 60-90s.
- `POST /wda/import-media` {name, mimeType, data(base64)}: adds the file to Photos (add-only access).
  The first import asks for Photos permission for WebDriverAgentRunner — tap Allow.
- `POST /wda/pressButton` without a session, and `NSPhotoLibraryAddUsageDescription` in the runner's Info.plist.

The patch is the two original 8.9.1 patches (kept in `upstream/` for reference) ported with context lines
to WDA 16.1.1 in tiktok-mkt-system, where it runs on real iPhones. The 0-context 8.9.1 patches land in the
wrong places on 16.1.1 and the build fails. Changing the driver version means porting this patch again.
