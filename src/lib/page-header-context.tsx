"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type PageHeaderValue = {
  title: string;
  subtitle?: string;
  // A new element on every render of the calling page re-fires the effect
  // below (React compares by identity), which is fine and expected if the
  // content is genuinely live (e.g. reflecting a controlled search input's
  // value). If a page's actions are static, wrap them in useMemo so an
  // unrelated re-render of that page doesn't churn the shared header.
  actions?: React.ReactNode;
};

type PageHeaderContextValue = {
  header: PageHeaderValue;
  setHeader: (value: PageHeaderValue) => void;
};

const DEFAULT_HEADER: PageHeaderValue = { title: "" };

const PageHeaderContext = createContext<PageHeaderContextValue | null>(null);

export function PageHeaderProvider({ children }: { children: React.ReactNode }) {
  const [header, setHeader] = useState<PageHeaderValue>(DEFAULT_HEADER);
  return (
    <PageHeaderContext.Provider value={{ header, setHeader }}>
      {children}
    </PageHeaderContext.Provider>
  );
}

// Pages call this to set the shared header. Runs in an effect (not during
// render) so it doesn't trigger a state update in the provider while React
// is still rendering the tree that reads that same state.
export function usePageHeader(value: PageHeaderValue) {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) {
    throw new Error("usePageHeader must be used within a PageHeaderProvider");
  }
  const { title, subtitle, actions } = value;
  useEffect(() => {
    ctx.setHeader({ title, subtitle, actions });
    // ctx.setHeader is stable across renders (from useState), but ESLint's
    // exhaustive-deps can't know that — omitting it here is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, subtitle, actions]);
}

export function usePageHeaderValue(): PageHeaderValue {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) {
    throw new Error("usePageHeaderValue must be used within a PageHeaderProvider");
  }
  return ctx.header;
}
