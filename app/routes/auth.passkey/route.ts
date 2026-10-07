import type { ActionFunctionArgs } from "@remix-run/node";
import { registerPasskey } from "../../services/auth/auth.server";

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  const response = await registerPasskey(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
