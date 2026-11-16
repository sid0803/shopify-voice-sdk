import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { ShopSettingsSchema } from "@techladder/adapter-shopify";
import { authenticate } from "../shopify.server";
import { getStores } from "../lib/stores.server";
import { ensureSettings, loadShopInfo } from "../lib/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const info = await loadShopInfo(admin);
  const settings = await ensureSettings(session.shop, info);
  return {
    settings: {
      ...settings,
      // Never send the pasted key or webhook secret to the browser.
      techladderKeyRef: "",
      techladderWebhookSecretRef: "",
    },
    connected: Boolean(settings.techladderKeyRef),
    shopTimezone: info.timezone,
  };
};

function num(form: FormData, name: string, fallback: number): number {
  const value = Number(form.get(name));
  return Number.isFinite(value) ? value : fallback;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const info = await loadShopInfo(admin);
  const current = await ensureSettings(session.shop, info);

  let tagNames: Record<string, string> = {};
  const tagJson = String(form.get("tagNamesJson") ?? "").trim();
  if (tagJson) {
    try {
      const parsed = JSON.parse(tagJson) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { error: "Tag overrides must be a JSON object, e.g. {\"call-confirmed\":\"confirmed\"}." };
      }
      tagNames = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    } catch {
      return { error: "Tag overrides are not valid JSON." };
    }
  }

  const next = ShopSettingsSchema.safeParse({
    ...current,
    enabled: form.get("enabled") === "on",
    agentId: String(form.get("agentId") ?? "").trim(),
    versionName: String(form.get("versionName") ?? "").trim(),
    voice: String(form.get("voice") ?? "").trim(),
    didNumberId: String(form.get("didNumberId") ?? "").trim() || undefined,
    codOnly: form.get("codOnly") === "on",
    minOrderValue: Math.max(0, Math.round(num(form, "minOrderValue", current.minOrderValue))),
    callingHours: {
      start: String(form.get("start") ?? current.callingHours.start),
      end: String(form.get("end") ?? current.callingHours.end),
      timezone: String(form.get("timezone") ?? info.timezone),
    },
    shopCountry: (String(form.get("shopCountry") ?? "").trim() || undefined) as
      | string
      | undefined,
    language: String(form.get("language") ?? "").trim() || undefined,
    maxRetries: Math.max(0, Math.min(5, Math.round(num(form, "maxRetries", current.maxRetries)))),
    tagsEnabled: form.get("tagsEnabled") === "on",
    tagNames,
    blockedPhones: String(form.get("blockedPhones") ?? "")
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter(Boolean),
  });

  if (!next.success) {
    return { error: next.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const stores = await getStores();
  await stores.settings.save(next.data);
  return { ok: true };
};

export default function SettingsPage() {
  const { settings, connected, shopTimezone } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Call settings">
      <s-section heading="Connection">
        <s-paragraph>
          {connected
            ? "A TechLadder key is connected for this shop."
            : "Connect a TechLadder key before enabling calls."}
        </s-paragraph>
        {actionData && "error" in actionData && (
          <s-banner tone="critical" heading="Not saved">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}
        {actionData && "ok" in actionData && (
          <s-banner tone="success" heading="Saved">
            <s-paragraph>Settings updated.</s-paragraph>
          </s-banner>
        )}
      </s-section>

      <Form method="post">
        <s-stack direction="block" gap="large">
          <s-section heading="Agent and caller">
            <s-stack direction="block" gap="base">
              <s-text-field name="agentId" label="Agent id" value={settings.agentId} required />
              <s-text-field name="versionName" label="Agent version" value={settings.versionName} required />
              <s-text-field name="voice" label="Voice" value={settings.voice} required />
              <s-text-field name="didNumberId" label="Caller number id (optional)" value={settings.didNumberId ?? ""} />
              <s-text-field name="language" label="Language (optional)" value={settings.language ?? ""} />
            </s-stack>
          </s-section>

          <s-section heading="Which orders get called">
            <s-stack direction="block" gap="base">
              <s-checkbox name="enabled" label="Calls enabled" checked={settings.enabled} />
              <s-checkbox name="codOnly" label="Cash-on-delivery orders only" checked={settings.codOnly} />
              <s-number-field
                name="minOrderValue"
                label="Minimum order value"
                value={String(settings.minOrderValue)}
              />
              <s-text-field name="shopCountry" label="Shop country (ISO 2-letter)" value={settings.shopCountry ?? ""} />
              <s-text-field
                name="blockedPhones"
                label="DND list (comma-separated E.164)"
                value={settings.blockedPhones.join(", ")}
              />
            </s-stack>
          </s-section>

          <s-section heading="Calling hours">
            <s-stack direction="block" gap="base">
              <s-text-field name="start" label="Start (HH:MM)" value={settings.callingHours.start} />
              <s-text-field name="end" label="End (HH:MM)" value={settings.callingHours.end} />
              <s-text-field name="timezone" label="Timezone" value={settings.callingHours.timezone} />
              <s-paragraph>Shop timezone from Shopify: {shopTimezone}</s-paragraph>
            </s-stack>
          </s-section>

          <s-section heading="Tags and retries">
            <s-stack direction="block" gap="base">
              <s-checkbox name="tagsEnabled" label="Write result tags back to orders" checked={settings.tagsEnabled} />
              <s-number-field
                name="maxRetries"
                label="Max retries (0-5)"
                value={String(settings.maxRetries)}
              />
              <s-text-area
                name="tagNamesJson"
                label="Tag overrides (JSON, optional)"
                value={JSON.stringify(settings.tagNames, null, 2)}
                rows={4}
              />
            </s-stack>
          </s-section>

          <s-button type="submit" variant="primary">Save settings</s-button>
        </s-stack>
      </Form>
    </s-page>
  );
}
