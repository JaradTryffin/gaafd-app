import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getDispenseOrders } from "@/lib/dispense-orders";
import { OrdersHeader } from "./orders-header";
import { OrdersTable } from "./orders-table";

export default async function OrdersPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") notFound();

  const orders = await getDispenseOrders(supabase, access.clubId);

  return (
    <>
      <OrdersHeader />
      <OrdersTable orders={orders} />
    </>
  );
}
