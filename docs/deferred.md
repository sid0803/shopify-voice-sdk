# Deferred until implementations are done (senior-approved order)

Do these together at the end, not one by one during testing.

1. **Repo visibility**: flip `shopify-voice-sdk` to private + scrub PII from
   history (real phone in `test/mongo.test.ts`-era fixtures
   `analysis-ready.sample.json` + `mapping.test.ts`, real order ids in
   `tag-test.ts` comment + replay fixture, key prefix in `backend-gaps.md`).
   Replace with fakes, then squash-or-filter-repo (history is public).
2. **Key rotation**: dev `sk_`, ngrok token, Shopify client secret — all
   appeared in chat/screenshots. Revoke + fresh values to local `.env` only.
3. **Live order tests**: new orders only after 1–2; verify `queued`,
   conversation, disposition, tag.
4. **7-scenario matrix**: Web-call first, then PSTN; log the table.
5. **Replay with a real sample**: swap
   `test/fixtures/analysis-ready.sample.json` for a signed backend payload,
   rerun replay test, then live tag on a dispositioned call.
6. **Staging deploy + host-owned items**: public URL replaces tunnels,
   Mongo/KMS live, OAuth token flow, worker schedule, `GET list 500`
   traceback, usage/billing decision, pricing (senior's).
