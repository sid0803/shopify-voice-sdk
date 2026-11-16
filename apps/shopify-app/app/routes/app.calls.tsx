import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getStores } from "../lib/stores.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const stores = await getStores();
  const calls = await stores.ledger.list(session.shop, 100);
  return { calls, mode: stores.mode };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "reconcile") return { error: "Unknown action" };
  const stores = await getStores();
  await stores.queue.enqueue({
    id: `reconcile:${session.shop}:${Date.now()}`,
    type: "reconcile",
    payload: { shop: session.shop },
    maxAttempts: 3,
  });
  return { ok: true };
};

export default function CallsPage() {
  const { calls, mode } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Call log">
      <s-section heading={`Recent calls (${mode} store)`}>
        {actionData && "ok" in actionData && (
          <s-banner tone="success" heading="Reconciliation queued">
            <s-paragraph>The worker will check pending calls against TechLadder.</s-paragraph>
          </s-banner>
        )}
        {actionData && "error" in actionData && (
          <s-banner tone="critical" heading="Not queued">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}
        <Form method="post">
          <input type="hidden" name="intent" value="reconcile" />
          <s-button type="submit">Reconcile pending calls</s-button>
        </Form>
        {calls.length === 0 ? (
          <s-paragraph>No calls yet.</s-paragraph>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Order</th>
                  <th align="left">Status</th>
                  <th align="left">Outcome</th>
                  <th align="left">Tag</th>
                  <th align="left">Updated</th>
                  <th align="left">Recording</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={`${c.shop}:${c.externalId}`}>
                    <td>{c.orderId}</td>
                    <td>{c.status}</td>
                    <td>{c.outcome ?? "—"}</td>
                    <td>{c.tagApplied ?? "—"}</td>
                    <td>{c.updatedAt}</td>
                    <td>
                      {c.recordingUrl?.startsWith("http") ? (
                        <a href={c.recordingUrl} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}
