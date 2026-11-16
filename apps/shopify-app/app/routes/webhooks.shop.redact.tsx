import type { ActionFunctionArgs } from "react-router";
import { handleGdprRoute } from "../lib/gdprWebhook.server";

export const action = async ({ request }: ActionFunctionArgs) =>
  handleGdprRoute(request, "shop/redact");
