import { QueryClient } from "@tanstack/react-query";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A 4xx won't fix itself on retry; a network blip or a 5xx might.
        retry: (count, err) => {
          const status = (err as { status?: number }).status;
          return count < 2 && (status === undefined || status >= 500);
        },
        refetchOnWindowFocus: true,
      },
    },
  });
}
