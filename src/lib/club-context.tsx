"use client";

import { createContext, useContext } from "react";

export type ClubContextValue = {
  clubId: string;
  slug: string;
  name: string;
  initials: string;
  accentColor: string;
  role: "staff" | "admin";
};

const ClubContext = createContext<ClubContextValue | null>(null);

export function ClubProvider({
  value,
  children,
}: {
  value: ClubContextValue;
  children: React.ReactNode;
}) {
  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>;
}

export function useClub(): ClubContextValue {
  const ctx = useContext(ClubContext);
  if (!ctx) {
    throw new Error("useClub must be used within a ClubProvider");
  }
  return ctx;
}
