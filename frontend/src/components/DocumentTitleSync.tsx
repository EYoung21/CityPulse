"use client";

import { useEffect } from "react";
import { cityPageTitle, getCurrentCity } from "@/lib/pulse-cities";

/** Keeps `document.title` aligned with the hostname after client navigation. */
export default function DocumentTitleSync() {
  useEffect(() => {
    const apply = () => {
      document.title = cityPageTitle(getCurrentCity());
    };
    apply();
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
  }, []);

  return null;
}
