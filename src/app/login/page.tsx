import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="flex min-h-screen bg-background font-sans text-foreground">
      <div className="flex flex-none basis-[44%] flex-col bg-sidebar-bg px-12 py-11 text-sidebar-text">
        <div className="flex items-center gap-2.5">
          <div className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-primary font-heading text-lg font-bold text-white">
            G
          </div>
          <div className="font-heading text-[21px] font-bold tracking-[-0.02em] text-white">
            GaafD
          </div>
          <div className="ml-2 rounded-[5px] border border-sidebar-border-dark px-1.5 py-0.5 font-mono text-[10px] text-[#7f877a]">
            SaaS
          </div>
        </div>

        <div className="mt-auto max-w-[360px]">
          <div className="font-heading text-[30px] font-semibold leading-[1.2] tracking-[-0.02em] text-white">
            Run your club, the compliant way.
          </div>
          <p className="mt-4 text-[14px] leading-[1.55] text-[#9aa291]">
            Members, tokens, dispensing, inventory and signed agreements — one private workspace
            per club.
          </p>
        </div>

        <div className="mt-8 flex items-center gap-2 text-[11.5px] text-sidebar-text-muted">
          <span className="h-[7px] w-[7px] rounded-full bg-sidebar-accent-dot" />
          POPIA-aligned · invite-only access
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center p-10">
        <LoginForm error={error} />
      </div>
    </div>
  );
}
