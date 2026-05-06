"use client";

import { useEffect, useState } from "react";
import { loadCityDistricts, onCityDistrictsLoaded } from "@/lib/districts";
import { getCurrentCity } from "@/lib/pulse-cities";

export function useCityDistricts() {
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const slug = getCurrentCity().slug;
    let cancelled = false;
    loadCityDistricts(slug)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setVersion((v) => v + 1);
      })
      .catch(() => {
        if (cancelled) return;
        setReady(true);
      });
    const unsub = onCityDistrictsLoaded((loadedSlug) => {
      if (loadedSlug === slug) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return { ready, version };
}
