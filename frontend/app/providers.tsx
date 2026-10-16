"use client";

import { useState } from "react";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import "@rainbow-me/rainbowkit/styles.css";

export function Providers({ children }: { children: React.ReactNode }) {
  // Created inside the component so the cache is never shared between requests
  // during SSR, and so a fast refresh doesn't hand back a torn-down client.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        // Chain data goes stale on its own schedule; refetching on every tab
        // focus just multiplies RPC calls for no new information.
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 10_000,
      },
    },
  }));

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#10b981",
            accentColorForeground: "#0a0a0c",
            borderRadius: "medium",
            fontStack: "system",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
