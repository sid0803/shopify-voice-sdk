import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getStores } from "../lib/stores.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const stores = await getStores();
  const settings = await stores.settings.get(session.shop);
  const recent = await stores.ledger.list(session.shop, 5);
  return {
    connected: Boolean(settings?.techladderKeyRef),
    enabled: settings?.enabled ?? false,
    tagsEnabled: settings?.tagsEnabled ?? true,
    recent,
    mode: stores.mode,
  };
};

export default function Index() {
  const { connected, enabled, tagsEnabled, recent, mode } = useLoaderData<typeof loader>();

  return (
    <s-page heading="TechLadder AI Calls">
      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-badge tone={connected ? "success" : "critical"}>
            {connected ? "TechLadder connected" : "TechLadder not connected"}
          </s-badge>
          <s-badge tone={enabled ? "success" : "warning"}>
            {enabled ? "Calls enabled" : "Calls disabled"}
          </s-badge>
          <s-badge tone={tagsEnabled ? "success" : "warning"}>
            {tagsEnabled ? "Order tags on" : "Order tags off"}
          </s-badge>
          <s-paragraph>
            Storage: {mode}. New orders are called automatically when the shop is
            connected and enabled.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Next steps">
        <s-unordered-list>
          <s-list-item>
            <Link to="/app/connect">{connected ? "Replace TechLadder key" : "Connect TechLadder"}</Link>
          </s-list-item>
          <s-list-item>
            <Link to="/app/settings">Configure agent, hours, DND and tags</Link>
          </s-list-item>
          <s-list-item>
            <Link to="/app/calls">Open the call log</Link>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Recent calls">
        {recent.length === 0 ? (
          <s-paragraph>No calls yet.</s-paragraph>
        ) : (
          <s-unordered-list>
            {recent.map((c) => (
              <s-list-item key={`${c.shop}:${c.externalId}`}>
                Order {c.orderId}: {c.status}
                {c.outcome ? ` · ${c.outcome}` : ""}
                {c.tagApplied ? ` · tag ${c.tagApplied}` : ""}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}
