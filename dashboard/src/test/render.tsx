import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { AppRoutes, Providers } from "@/App";
import { createQueryClient } from "@/lib/queryClient";

/** Shows the current location, so tests can assert redirects. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

/** The whole app at `path`, with a fresh query cache (no state leaks between tests). */
export function renderApp(path: string) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <Providers client={client}>
        <AppRoutes />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </Providers>
    </MemoryRouter>,
  );
  return { ...utils, user, client };
}
