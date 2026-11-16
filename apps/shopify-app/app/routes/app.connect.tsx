import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getStores } from "../lib/stores.server";
import { ensureSettings, loadShopInfo } from "../lib/settings.server";
import { ensureResultWebhook, validateTechLadderKey } from "../lib/techladder.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const info = await loadShopInfo(admin);
  const settings = await ensureSettings(session.shop, info);
  return {
    connected: Boolean(settings.techladderKeyRef),
    accountName: settings.techladderAccountName ?? settings.techladderAccountId ?? null,
    webhookReady: Boolean(settings.techladderWebhookSecretRef),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const key = String(form.get("techladderKey") ?? "").trim();
  if (!key.startsWith("sk_")) {
    return { error: "Paste a TechLadder developer key beginning with sk_." };
  }

  const info = await loadShopInfo(admin);
  const settings = await ensureSettings(session.shop, info);
  let accountName: string;
  let accountId: string | undefined;
  try {
    const account = await validateTechLadderKey(key);
    accountName = account.name;
    accountId = account.accountId;
  } catch (err) {
    return { error: `Key validation failed: ${String((err as Error)?.message ?? err)}` };
  }

  let warning: string | undefined;
  let endpoint: { endpointId: string; secret: string } | undefined;
  try {
    endpoint = await ensureResultWebhook(settings, key, settings.techladderWebhookSecretRef);
  } catch (err) {
    warning = `Key saved, but the result webhook could not be registered: ${String(
      (err as Error)?.message ?? err,
    )}`;
  }

  const stores = await getStores();
  await stores.settings.save({
    ...settings,
    techladderKeyRef: key,
    ...(accountId ? { techladderAccountId: accountId } : {}),
    techladderAccountName: accountName,
    // Reconnecting after an uninstall should resume calling once configured.
    enabled: true,
    ...(endpoint
      ? {
          techladderWebhookEndpointId: endpoint.endpointId,
          techladderWebhookSecretRef: endpoint.secret,
        }
      : {}),
  });

  return { ok: true, accountName, ...(warning ? { warning } : {}) };
};

export default function ConnectPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Connect TechLadder">
      <s-section heading="TechLadder account">
        <s-paragraph>
          Paste the shop&apos;s TechLadder developer key. It is validated with GET
          /me, stored encrypted, and never sent to the browser again.
        </s-paragraph>
        {data.connected && (
          <s-banner tone="success" heading="Connected">
            <s-paragraph>
              Account: {data.accountName ?? "validated"}
              {data.webhookReady ? " · result webhook registered" : " · webhook missing, reconnect"}
            </s-paragraph>
          </s-banner>
        )}
        {actionData && "error" in actionData && (
          <s-banner tone="critical" heading="Could not connect">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}
        {actionData && "ok" in actionData && (
          <s-banner tone="success" heading="Key saved">
            <s-paragraph>
              Account: {actionData.accountName}
              {actionData.warning ? ` — ${actionData.warning}` : ""}
            </s-paragraph>
          </s-banner>
        )}
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-password-field
              name="techladderKey"
              label="TechLadder key (sk_...)"
              autocomplete="off"
              required
            />
            <s-button type="submit" variant="primary">
              Validate and connect
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
