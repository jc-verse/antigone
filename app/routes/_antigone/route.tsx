import type { LoaderFunctionArgs } from "@remix-run/node";
import { Outlet } from "@remix-run/react";
import type { ReactElement } from "react";
import { requireOwnerSession } from "../../services/auth/auth.server";
import useGeneration, {
  GenerationContext,
} from "../_antigone.create/useGeneration";

export default function ProtectedRoutes(): ReactElement {
  const generation = useGeneration();
  return (
    <GenerationContext.Provider value={generation}>
      <Outlet />
    </GenerationContext.Provider>
  );
}

export async function loader({ request }: LoaderFunctionArgs): Promise<null> {
  await requireOwnerSession(request);
  return null;
}
