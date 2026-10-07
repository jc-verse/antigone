import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { requireOwnerSession } from "../../services/auth/auth.server";

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  await requireOwnerSession(request);
  return redirect("/create");
}
