"use client";

import { usePageHeaderValue } from "@/lib/page-header-context";

export function AppHeader() {
  const { title, subtitle, actions } = usePageHeaderValue();
  return (
    <header className="flex flex-none items-center gap-4 border-b border-border bg-[#fbfaf6] px-7 py-[18px]">
      <div className="min-w-0">
        <div className="font-heading text-[22px] font-bold leading-[1.1] tracking-[-0.02em]">
          {title}
        </div>
        {subtitle && <div className="mt-0.5 text-[12.5px] text-[#6b6f66]">{subtitle}</div>}
      </div>
      {actions && <div className="ml-auto flex items-center gap-2.5">{actions}</div>}
    </header>
  );
}
