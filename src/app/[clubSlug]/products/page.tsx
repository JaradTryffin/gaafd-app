import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getProducts } from "@/lib/products";
import { getCategories } from "@/lib/categories";
import { ProductsHeader } from "./products-header";
import { ProductsTable } from "./products-table";
import { CategoriesPanel } from "./categories-panel";

export default async function ProductsPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") notFound();

  const [products, categories] = await Promise.all([
    getProducts(supabase, access.clubId),
    getCategories(supabase, access.clubId),
  ]);

  return (
    <>
      <ProductsHeader clubName={access.name} count={products.length} />
      <CategoriesPanel clubId={access.clubId} categories={categories} />
      <ProductsTable clubId={access.clubId} products={products} categories={categories} />
    </>
  );
}
