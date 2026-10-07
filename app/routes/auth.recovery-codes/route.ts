import type { ActionFunctionArgs } from "@remix-run/node";
import { confirmRecoveryCodes } from "../../services/auth/auth.server";

export const action = ({ request }: ActionFunctionArgs): Promise<Response> =>
  confirmRecoveryCodes(request);
