import { gated } from "@/lib/access";
import { importListing } from "@/lib/importer";

export const maxDuration = 30;

export const POST = gated(async (req) => {
  const { input } = (await req.json().catch(() => ({}))) as { input?: string };
  if (!input?.trim()) return Response.json({ error: "Provide an address or listing URL" }, { status: 400 });
  return Response.json(await importListing(input));
});
