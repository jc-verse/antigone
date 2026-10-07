import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authHandler } from "../../services/auth/auth.server";

export const loader = ({ request }: LoaderFunctionArgs): Promise<Response> =>
  authHandler(request);
export const action = ({ request }: ActionFunctionArgs): Promise<Response> =>
  authHandler(request);
